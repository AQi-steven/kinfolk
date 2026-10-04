// server/src/routes/settings.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLLMConfig, setSetting } = require('../config');
const { testConnection } = require('../llm');
const { authMiddleware } = require('../auth');

// 管理员判定（P1-7）：改 LLM key / 测连接属于全局配置操作，只允许管理员。
// 规则：settings 表 admin_user_ids（逗号分隔）优先；未配置时兜底为「首用户」（系统第一个注册者 = 部署人）。
function isAdminUser(uid) {
  if (!uid) return false;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_user_ids'").get();
    const raw = (row && row.value || '').trim();
    if (raw) {
      const ids = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length) return ids.includes(uid);
    }
    const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    return !!(first && first.id === uid);
  } catch (e) {
    return false;
  }
}
const adminOnly = [authMiddleware, (req, res, next) => {
  if (!isAdminUser(req.user.id)) return res.status(403).json({ error: '仅管理员可修改全局 AI 配置' });
  next();
}];

// GET 公开（仅展示模型状态，无敏感信息）；写操作（改配置 / 测连接）必须管理员
router.get('/', (req, res) => {
  const c = getLLMConfig();
  res.json({ baseUrl: c.baseUrl, model: c.model, demoMode: c.demoMode, hasKey: !!c.apiKey, source: c.source });
});

router.post('/', adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.baseUrl !== undefined) setSetting('llm_base_url', b.baseUrl);
  if (b.apiKey !== undefined) setSetting('llm_api_key', b.apiKey);
  if (b.model !== undefined) setSetting('llm_model', b.model);
  const c = getLLMConfig();
  res.json({ ok: true, demoMode: c.demoMode, hasKey: !!c.apiKey, source: c.source });
});

router.post('/test', adminOnly, async (req, res) => {
  try {
    const r = await testConnection();
    res.json(r);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

module.exports = router;
