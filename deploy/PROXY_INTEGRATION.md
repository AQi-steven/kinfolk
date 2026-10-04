# 一生之记接入 QC 服务器前置代理 — 实测修正版

> 本文件取代 `Caddyfile` / `nginx-family.conf`。
> 依据：QC 任务 2026-08-21 SSH 实测交接简报（服务器 YOUR_SERVER_IP）。

## 0. 真实拓扑（实测，非推测）

| 项 | 实测值 |
|---|---|
| 80/443 上跑的是什么 | **都不是 nginx/Caddy**。QC 仓库里的 `deploy/Caddyfile`、`deploy/nginx/*` 是**死配置，从未启用** |
| 真正的入口 | QC 自写 Node 反代（root 运行）：<br>• `proxy-lcgcy-80.js`（pm2 `qc-www`）：放行 `/.well-known/acme-challenge/` + 301 跳 HTTPS<br>• `proxy-lcgcy-443.js`（pm2 `reverse-proxy`）：按 `req.url` 把**全部** 443 流量 → `127.0.0.1:3000`（other-app） |
| 证书 | `/root/ssl/YOUR_DOMAIN/`（acme.sh 签发）；**SAN 仅 `DNS:YOUR_DOMAIN`**，无通配 |
| 内存 | 2GB 总 / 可用仅 ~1GB；kkFileView(222MB) 不可关停 |
| 端口占用 | 80、443→自写 node；3000→other-app；8080→kkFileView；**4000 空闲（规划给 cybio-app）** |

**结论**：唯一可行的接入方式 = 改 `proxy-lcgcy-443.js` 加 Host 分流 + 扩证书 SAN。发 nginx/Caddy 配置对实际链路无效。

---

## 1. 改 `/path/to/qc/proxy-lcgcy-443.js`（加 Host 分流，3000 路径一行不动）

本改动已获 QC 任务交接授权，且为**纯加法**——只新增「host 命中 YOUR_DOMAIN 才走 4000」的判断，other-app 的 3000 转发逻辑完全保留，对 QC 零影响。

当前文件 `handler` 写死：
```js
const TARGET = 'http://127.0.0.1:3000';
function handler(req, res) {
  const options = { method: req.method, headers: req.headers, timeout: 30000 };
  const r = http.request(TARGET + req.url, options, (up) => { ... });
  ...
}
```

改为按 host 选 upstream（仅替换 TARGET 的取值方式）：
```js
function handler(req, res) {
  // 子域名分流：YOUR_DOMAIN → 4000(一生之记)，其余一律 → 3000(other-app)
  const host = (req.headers.host || '').split(':')[0];
  const target = host === 'YOUR_DOMAIN'
    ? 'http://127.0.0.1:4000'
    : 'http://127.0.0.1:3000';
  const options = { method: req.method, headers: req.headers, timeout: 30000 };
  const r = http.request(target + req.url, options, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  r.on('error', () => { res.writeHead(502); res.end('Bad gateway'); });
  req.pipe(r);
}
```
> 删掉原 `const TARGET = ...` 那一行即可。改动约 4 行。

---

## 2. 扩充证书（让 `YOUR_DOMAIN` 合法，消除证书不匹配）

最简方案：**复用现有 webroot**（80 代理已放行 acme-challenge，无需停进程），加单子域，**无需 DNS API**：
```bash
sudo acme.sh --issue -d YOUR_DOMAIN -d YOUR_DOMAIN --webroot /root/.acme.sh/wwwroot
sudo acme.sh --installcert -d YOUR_DOMAIN -d YOUR_DOMAIN \
  --key-file       /root/ssl/YOUR_DOMAIN/privkey.pem \
  --fullchain-file /root/ssl/YOUR_DOMAIN/fullchain.pem \
  --reloadcmd "pm2 reload reverse-proxy"
```
- `installcert` 会把合并后的新证书写回原目录，并 `pm2 reload reverse-proxy` 让代理重读证书。
- **不要**做通配 `*.YOUR_DOMAIN`——通配需 DNS-01 挑战（要域名商 API），webroot 模式做不了。未来若再加子域再单独 `--issue -d 新子域`。

---

## 3. DNS（需用户在域名注册商后台操作，服务器侧改不了）

加一条记录：`YOUR_DOMAIN` → `YOUR_SERVER_IP`（A 记录），等待生效：
```bash
ping YOUR_DOMAIN        # 能解析到 YOUR_SERVER_IP 即 OK
```

---

## 4. 生效与验证

证书 `installcert` 的 reloadcmd 已 reload 代理；若只改了 Host 分流未动证书，手动：
```bash
pm2 reload reverse-proxy
```
验证：
```bash
curl -sI https://YOUR_DOMAIN/api/health      # 期望 200，且证书 CN/SAN 含 YOUR_DOMAIN
curl -sI https://YOUR_DOMAIN/                        # 期望 200，QC 访问不受影响
```

---

## 5. 硬约束（务必遵守）

- **内存**：cybio-app 限 Node，PM2 `max_memory_restart:600M` + node_args `--max-old-space-size=512`；**禁 Java/JVM**（kkFileView 已占 222MB，余量紧张）。
- **端口**：只用 4000；勿占 80/443/3000/8080。
- **数据**：独立 `cybio.db`，绝不读/写 `quality.db` 或 other-app 其他文件（本代理分流除外，已授权且纯加法）。
- **微信内打开**（如需）：要独立子域 + 单独 JS 安全域名报备，`YOUR_DOMAIN` 的报备不继承子域。

---

## 6. 我（本机）能做的 / 不能做的

- ✅ 已交付：cybio-app 代码、PM2 配置（`ecosystem.config.cjs`）、push 脚本、本接入指南。
- ❌ 无法代执行：SSH 上服务器改反代、acme.sh 扩证书、DNS 加记录——这些需在服务器侧或域名后台由你/QC 任务完成。
- 注意：服务器前置当前是**自定义 Node 反代**，不在本机可观测范围；以上均依据 QC 任务的 SSH 实测交接，部署前建议先 `pm2 ls` / `ss -tlnp` 复验一次。
