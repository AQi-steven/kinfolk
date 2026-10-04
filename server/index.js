// server/index.js
// 赛博传记：Express + 静态托管 web/ + 挂载 /api 路由
// 全局关系图模型（2026-08-23 重构：废除多租户 family_trees/tree_members/invite_code）
const express = require('express');
const path = require('path');
require('./src/db'); // 触发初始化建表
const personsRouter = require('./src/routes/persons');
const interviewRouter = require('./src/routes/interview');
const settingsRouter = require('./src/routes/settings');
const authRouter = require('./src/routes/auth');
const voiceRouter = require('./src/routes/voice');
const egoTreeRouter = require('./src/routes/egotree');
const mergeRouter = require('./src/routes/merge');
const memoirRouter = require('./src/routes/memoir');
const mediaRouter = require('./src/routes/media');
const invitationsRouter = require('./src/routes/invitations');
const claimsRouter = require('./src/routes/claims');
const suggestionsRouter = require('./src/routes/suggestions');
const { getLLMConfig } = require('./src/config');

const pkg = require('../package.json');
const fs = require('fs');
let APP_VERSION = pkg.version || '2.0.0';
try {
  const buildVer = fs.readFileSync(path.join(__dirname, '..', '.build-version'), 'utf8').trim();
  if (buildVer) APP_VERSION = buildVer;
} catch (_) { /* 没有构建戳就用 package.json 版本 */ }

const app = express();
app.use(express.json({ limit: '5mb' }));

// 所有 /api 响应统一 charset=utf-8
app.use('/api', (req, res, next) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  next();
});

app.get('/api/health', (req, res) => {
  const c = getLLMConfig();
  const hasCred = !!(c.apiKey || (c.secretId && c.secretKey));
  res.json({
    status: 'ok',
    demoMode: c.demoMode,
    version: APP_VERSION,
    provider: c.provider,
    model: c.model || null,
    hasKey: hasCred,
    source: c.source,
  });
});

// 阶段1挂载：auth / persons / egotree / voice
// 阶段4（2026-08-24）：interview 引擎完成去 tree_id 改造，正式挂载 /api/interview
// 设置页（账户 / AI 模型状态）挂载 /api/settings
// 阶段5（2026-08-29）：回忆录章节重新挂载 /api/memoir（全局图模型下 tree_id 仅作兼容字段）
app.use('/api/auth', authRouter);
app.use('/api/persons', personsRouter);
app.use('/api/egotree', egoTreeRouter);
app.use('/api/merge', mergeRouter);
app.use('/api/interview', interviewRouter);
app.use('/api/memoir', memoirRouter);
app.use('/api/settings', settingsRouter);
// 媒体（上传/AI配文）与节点认领邀请/认领（2026-08-29 重建为全局图模型，补活 claim.html 死链）
app.use('/api/media', mediaRouter);
app.use('/api/invitations', invitationsRouter);
app.use('/api/claims', claimsRouter);
// 家人补充建议（2026-10-04 P5）：家人提交建议 → 本人确认后入正文
app.use('/api/suggestions', suggestionsRouter);
app.use('/api', voiceRouter);

// 静态前端（SPA 用哈希路由，仅需托管 index.html + 资源）
const WEB_DIR = path.join(__dirname, '..', 'web');
const noCacheHtml = (res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
};
// HTML/入口文档禁止缓存，消除微信 X5 内核对旧版 HTML 的强缓存
// （微信里看到和浏览器不同的页面，最常见原因就是 X5 死缓存了旧版 index.html）
app.get(['/', '/index.html', '/auth.html'], (req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(WEB_DIR, req.path === '/' ? 'index.html' : req.path.slice(1)));
});
app.use(express.static(WEB_DIR, { index: false }));
// 用户上传的老照片（成书/配文用）
app.use('/uploads', express.static(path.join(__dirname, '..', 'web', 'uploads')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  const c = getLLMConfig();
  console.log(`\n📖 赛博传记 已启动： http://localhost:${PORT}`);
  console.log(`   AI 访谈引擎：${c.demoMode ? '演示模式（未配置 API Key，脚本化离线运行）' : `真实模型（${c.model || '默认'} / 来源:${c.source}）`}`);
  console.log(`   手机访问：同一局域网用本机 IP 打开，或电脑浏览器开开发者工具的移动视图。\n`);
});
