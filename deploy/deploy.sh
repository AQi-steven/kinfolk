#!/bin/bash
# ============================================================
# 赛博传记 — PM2 服务部署脚本（在服务器上运行）
# 用法： ssh 登录服务器后， cd /path/to/cybio && bash deploy/deploy.sh
# 幂等：重复执行会先删除旧进程再启动，不会冲突。
# ============================================================
set -e

APP_DIR="/path/to/cybio/server"
APP_NAME="cybio-app"

echo "=== 赛博传记 - 部署脚本 ==="

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误：未安装 Node.js"
    echo "请先运行：curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
    exit 1
fi
echo "Node.js 版本：$(node --version)"

# 检查 PM2
if ! command -v pm2 &> /dev/null; then
    echo "正在安装 PM2..."
    npm install -g pm2
fi
echo "PM2 版本：$(pm2 --version)"

# 安装依赖
if [ -d "$APP_DIR" ]; then
    echo "安装依赖..."
    cd "$APP_DIR"
    npm install --production
else
    echo "错误：应用目录不存在 $APP_DIR"
    echo "请先将代码上传到服务器（见 deploy/push.sh）"
    exit 1
fi

# 创建必要目录（web/uploads 用于老照片上传，被 express.static 托管）
mkdir -p "$APP_DIR/data" "$APP_DIR/uploads" "$APP_DIR/backups" "$APP_DIR/logs" "/path/to/cybio/web/uploads"

# Schema 由 server/src/db.js 在启动时幂等建立（CREATE TABLE IF NOT EXISTS + 字段迁移）。
# 生产环境保留已有数据；如需彻底清库，请手动执行 rm /path/to/cybio/server/data/cybio.db*。
if [ -f "$APP_DIR/data/cybio.db" ]; then
  echo "检测到已有数据库，保留现有数据..."
else
  echo "未检测到数据库，启动后将自动创建新库..."
fi

# 停止旧进程（若存在）
# 🔒 部署前自动备份数据库（2026-09-13 事故教训：部署包误覆盖生产库时，此备份是唯一后悔药）
if [ -f "$APP_DIR/data/cybio.db" ]; then
  TS2="$(date +%Y%m%d%H%M%S)"
  mkdir -p "$APP_DIR/backups"
  node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1],{readOnly:true}).prepare('VACUUM INTO ?').run(process.argv[2])" \
    "$APP_DIR/data/cybio.db" "$APP_DIR/backups/pre-deploy-$TS2.db" 2>/dev/null \
    && echo "🔒 已备份数据库: backups/pre-deploy-$TS2.db" \
    || echo "⚠️ 警告：部署前备份失败（继续部署，请人工确认数据库安全）"
fi
pm2 delete $APP_NAME 2>/dev/null || true

# 启动服务（端口 4000 / DB / 密钥均由 ecosystem.config.cjs 固定）
echo "启动服务..."
cd /path/to/cybio/deploy
pm2 start ecosystem.config.cjs --env production

# 设置开机自启
pm2 save

echo ""
echo "=== 部署完成 ==="
echo "验证： curl -s http://localhost:4000/api/health"
echo ""
echo "运维命令："
echo "  pm2 status            # 查看状态"
echo "  pm2 logs $APP_NAME    # 查看日志"
echo "  pm2 restart $APP_NAME # 重启"
