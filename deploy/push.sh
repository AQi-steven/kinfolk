#!/bin/bash
# ============================================================
# 赛博传记 — 一键部署（本地 → 生产）
# 用法： bash deploy/push.sh
# 环境变量（均可选，含默认值，已复用千里行 QC 同机信息）：
#   DEPLOY_SERVER  生产服务器 IP         默认 YOUR_SERVER_IP
#   DEPLOY_USER    SSH 登录用户          默认 ubuntu
#   DEPLOY_PORT    SSH 端口             默认 22
#   DEPLOY_DIR     服务器程序目录        默认 /path/to/cybio
# ============================================================
set -e

SERVER="${DEPLOY_SERVER:-YOUR_SERVER_IP}"
REMOTE_USER="${DEPLOY_USER:-root}"
SSH_PORT="${DEPLOY_PORT:-22}"
REMOTE_DIR="${DEPLOY_DIR:-/path/to/cybio}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SECRET_FILE="$(dirname "$LOCAL_DIR")/SecretKey.csv"
PKG="/tmp/cybio-app-push.tar.gz"

echo "=== 赛博传记 一键部署 ==="
echo "本地目录: $LOCAL_DIR"
echo "目标:     $REMOTE_USER@$SERVER:$SSH_PORT $REMOTE_DIR"

# ── 0. 本地构建 Tailwind v4（前端样式编译，本地化零 CDN）─────────────────
if [ -f "$LOCAL_DIR/package.json" ] && grep -q '"build:css"' "$LOCAL_DIR/package.json"; then
  echo "编译 Tailwind v4（src/tw.css → web/_tw.css）..."
  (cd "$LOCAL_DIR" && npm run build:css) || { echo "❌ build:css 失败，部署中止"; exit 1; }
fi

# ── 1. 构建临时目录、注入前端版本戳并打包（避免污染源文件）─────────────────
PKG_VERSION="$(cat "$LOCAL_DIR/package.json" | grep -m1 '"version"' | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
TIMESTAMP="$(date +%Y%m%d%H%M)"
BUILD_VERSION="${PKG_VERSION}-${TIMESTAMP}"
echo "前端版本戳: $BUILD_VERSION"

BUILD_TMP="/tmp/cybio-build-$BUILD_VERSION"
rm -rf "$BUILD_TMP"
mkdir -p "$BUILD_TMP"
cp -r "$LOCAL_DIR/web" "$BUILD_TMP/"
cp -r "$LOCAL_DIR/server" "$BUILD_TMP/"
cp -r "$LOCAL_DIR/scripts" "$BUILD_TMP/" 2>/dev/null || true
cp "$LOCAL_DIR/package.json" "$BUILD_TMP/"
cp "$LOCAL_DIR/package-lock.json" "$BUILD_TMP/" 2>/dev/null || true
cp "$LOCAL_DIR/README.md" "$BUILD_TMP/" 2>/dev/null || true
cp -r "$LOCAL_DIR/deploy" "$BUILD_TMP/"

# 注入前端版本戳，打破微信 X5 内核对 JS/CSS 的强缓存
for f in "$BUILD_TMP/web"/*.html; do
  [ -f "$f" ] && sed -i "s|__BUILD_VERSION__|$BUILD_VERSION|g" "$f"
done
echo "$BUILD_VERSION" > "$BUILD_TMP/.build-version"

echo "打包中..."
cd "$BUILD_TMP"
tar czf "$PKG" \
  --exclude='node_modules' --exclude='data' --exclude='uploads' \
  --exclude='.env' --exclude='backups' --exclude='*.tar.gz' \
  .build-version web server scripts package.json package-lock.json README.md deploy
echo "包大小: $(du -h "$PKG" | cut -f1)"

# ── 2. 上传 ──────────────────────────────────────────
echo "上传到服务器..."
REMOTE_HOME="$(ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" 'echo $HOME' 2>/dev/null || echo /root)"
scp -P "$SSH_PORT" "$PKG" "$REMOTE_USER@$SERVER:$REMOTE_HOME/cybio-app-push.tar.gz"

# 同步腾讯云 SecretKey.csv（长期凭证，替代短期 API Key）
if [ -f "$SECRET_FILE" ]; then
  echo "同步 SecretKey.csv..."
  scp -P "$SSH_PORT" "$SECRET_FILE" "$REMOTE_USER@$SERVER:$REMOTE_HOME/cybio-secretkey.csv"
  KEY_SYNC_CMD="cp -f $REMOTE_HOME/cybio-secretkey.csv $REMOTE_DIR/SecretKey.csv && chown root:root $REMOTE_DIR/SecretKey.csv && chmod 600 $REMOTE_DIR/SecretKey.csv"
else
  echo "警告：未找到 $SECRET_FILE，部署后将使用演示模式（无真实 AI）"
  KEY_SYNC_CMD="true"
fi

# ── 3. 解包 + 重启 pm2 ───────────────────────────────
echo "解包并部署服务..."
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" "bash -c 'cd $REMOTE_DIR && tar xzf $REMOTE_HOME/cybio-app-push.tar.gz && $KEY_SYNC_CMD && bash deploy/deploy.sh'"

# ── 4. 自检（本机进程，绕过前置代理）────────────────────
echo "等待服务启动..."
sleep 3
echo "--- /api/health (本机 4000) ---"
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" "curl -s --max-time 8 http://localhost:4000/api/health || echo '(health 不可达：请确认 cybio-app 已启动)'"

echo ""
echo "=== 代码部署完成 ==="
echo "前置代理（Host 分流）由 QC 任务侧完成，详见 deploy/PROXY_INTEGRATION.md"
echo "线上验证： curl -sI https://YOUR_DOMAIN/   （期望 200）"
