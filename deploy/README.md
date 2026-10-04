# Kinfolk 一生之记 — 部署指南（与「某单位 / QC」共用服务器）

本指南解决一件事：**把一生之记部署到 QC 所在的同一台云服务器，两者互不干扰**。

---

## 0. 隔离设计（已内置，部署即生效）

| 维度 | 某单位 (QC) | 一生之记 (本程序) | 是否隔离 |
|---|---|---|---|
| 服务器 | YOUR_SERVER_IP (Ubuntu, ubuntu) | 同一台 | 共用硬件，进程独立 |
| 部署目录 | `/path/to/qc` | `/path/to/cybio` | ✅ 目录分离 |
| 数据库 | `quality.db` | `cybio.db` | ✅ 库分离，互不触碰 |
| 监听端口 | **3000** | **4000** | ✅ 端口错开 |
| PM2 名称 | `other-app` / 反代 `qc-www`、`reverse-proxy` | `cybio-app` | ✅ 进程名分离 |
| 域名 | `YOUR_DOMAIN` | `YOUR_DOMAIN` | ✅ 子域名分离 |
| node_modules / 依赖 | 各自独立 | 各自独立 | ✅ 依赖分离 |

> 两个程序没有任何共享文件、共享端口或共享环境变量。一生之记**不会读取、修改、备份 QC 的任何数据**（除下述反代分流，已获 QC 任务授权且为纯加法）。

---

## 1. 服务器前置拓扑（2026-08-21 SSH 实测，已确认）

**重要纠正**：服务器 80/443 上**既不是 nginx 也不是 Caddy**。QC 仓库里的 `deploy/Caddyfile`、`deploy/nginx/*` 是**死配置，从未启用**。本仓库的 `deploy/Caddyfile`、`deploy/nginx-family.conf` 仅作参考，**不要用它们**。

真正的入口是 QC 自写 Node 反代（root 运行）：
- `proxy-lcgcy-80.js`（pm2 `qc-www`）：放行 `/.well-known/acme-challenge/` + 301 跳 HTTPS
- `proxy-lcgcy-443.js`（pm2 `reverse-proxy`）：按 `req.url` 把**全部** 443 流量 → `127.0.0.1:3000`（other-app）

证书：`/root/ssl/YOUR_DOMAIN/`（acme.sh 签发），**SAN 仅 `DNS:YOUR_DOMAIN`**，无通配。

**因此一生之记接入的唯一正确方式** = 改 `proxy-lcgcy-443.js` 加 Host 分流 + 扩充证书 SAN。完整步骤见 👉 **`deploy/PROXY_INTEGRATION.md`**（含精确 patch、acme.sh 命令、DNS、reload、验证）。

---

## 2. 部署步骤（概览）

### 步骤 A — 上传代码（幂等，可反复执行）
```bash
bash deploy/push.sh
# 默认推到 YOUR_SERVER_IP:/path/to/cybio，PM2 名 cybio-app，端口 4000
# 可用环境变量覆盖：DEPLOY_SERVER / DEPLOY_USER / DEPLOY_PORT / DEPLOY_DIR
```
脚本自动打包（排除 node_modules/data/uploads/.env）、scp 上传、解包并 `pm2 start ecosystem.config.cjs`。

### 步骤 B — 改反代分流（在 QC 的反代文件上做纯加法）
按 `deploy/PROXY_INTEGRATION.md` §1，给 `/path/to/qc/proxy-lcgcy-443.js` 加约 4 行 Host 判断（`YOUR_DOMAIN → 4000`，其余 → 3000 不动）。

### 步骤 C — 扩证书（让子域合法）
按 §2：`acme.sh --issue` 增加 `-d YOUR_DOMAIN`（复用现有 webroot，免 DNS API），`--installcert` 写回并重载反代。

### 步骤 D — DNS（用户在域名后台做）
给 `YOUR_DOMAIN` 加 A 记录 → `YOUR_SERVER_IP`。

### 步骤 E — 生效验证
`pm2 reload reverse-proxy`；`curl -sI https://YOUR_DOMAIN/api/health` 期望 200 且证书合法；`curl -sI https://YOUR_DOMAIN/` 确认 QC 不受影响。

> 本机绕过前置直验进程：`curl -s http://localhost:4000/api/health`

---

## 3. 给「千里行（QC）」任务的说明段落（可直接转发）

> 我们准备把新应用「一生之记」部署到与某项目同一台云服务器（YOUR_SERVER_IP）。已做硬性隔离：一生之记监听 **4000**（避开 QC 3000），部署于 `/path/to/cybio`，用独立 `cybio.db`（与 `quality.db` 完全分离），PM2 名 `cybio-app`。
>
> **已实测确认前置拓扑**：80/443 上跑的是 QC 自写 Node 反代 `proxy-lcgcy-443.js`（pm2 `reverse-proxy`），不是 nginx/Caddy。因此接入方式是在该反代里加一段 Host 分流（`YOUR_DOMAIN → 4000`，other-app 的 3000 路径一行不动），并扩充证书 SAN 覆盖子域。改动为纯加法，对 QC 现有访问零影响，已随附 `PROXY_INTEGRATION.md` 精确步骤。
>
> 需协助/确认：
> - (a) 能否在 DNS 给 **`YOUR_DOMAIN`** 加 A 记录指向 `YOUR_SERVER_IP`？
> - (b) 证书扩充沿用 acme.sh 现有 webroot 模式（仅加单子域），是否同意？如需通配 `*.YOUR_DOMAIN` 则要走 DNS-01（需域名商 API），请告知。
> - (c) 服务器内存余量仅 ~1GB，cybio-app 已限 600MB；请知悉 kkFileView 等既有进程不可关停。

---

## 4. 待确认 / 自查清单

| 项目 | 状态 | 说明 |
|---|---|---|
| 真实域名 | ✅ `YOUR_DOMAIN` | 子域 `YOUR_DOMAIN` |
| 服务器 IP / 用户 / SSH | ✅ 复用 QC | YOUR_SERVER_IP / ubuntu / 22 |
| QC 端口 / PM2 名 | ✅ 已知 | 3000 / `other-app`；反代 `qc-www`、`reverse-proxy` |
| **前置拓扑** | ✅ **已确认** | 自写 Node 反代，非 nginx/Caddy（Caddyfile/nginx 配置为死配置） |
| **`YOUR_DOMAIN` DNS A 记录** | ❓ 待添加 | 用户在域名后台做 |
| **证书扩 SAN** | ❓ 待执行 | acme.sh 加 `-d YOUR_DOMAIN`（webroot 模式） |
| cybio-app 部署目录 | ✅ `/path/to/cybio` | 与 `/path/to/qc` 并列 |
| 内存上限 | ✅ 已设 `max_memory_restart:600M` | 防拖垮整机 |
