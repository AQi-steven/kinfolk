#!/usr/bin/env bash
# 赛博家谱 一键启动脚本
# 需要 Node >= 22（内置 node:sqlite，必须带 --experimental-sqlite）
set -e
cd "$(dirname "$0")"
exec node --experimental-sqlite server/index.js
