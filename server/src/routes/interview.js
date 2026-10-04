// server/src/routes/interview.js
// 赛博传记 — 访谈路由（全局图模型，需登录；无 tree 维度）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const iv = require('../interview');

router.use(authMiddleware);

// 开始访谈：补全自己（type=person_claim）或代录他人（type=relay，需已授权）
// 不再需要 tree_id：人物节点全局共享，关系网自然涌现。
router.post('/start', async (req, res) => {
  let { type = 'person_claim', target_person_id = null, relay_mode = false, focus_person_id = null, focus_relation = '', chapter_id = null } = req.body || {};
  if (target_person_id) {
    const node = db.prepare('SELECT * FROM persons WHERE id = ? AND status != \'deleted\'').get(target_person_id);
    if (!node) return res.status(404).json({ error: '节点不存在' });
    // 代录他人需授权（B_X）
    if (node.claimed_by_user_id !== req.user.id) {
      const granted = db.prepare('SELECT id FROM relay_requests WHERE requester_user_id = ? AND target_person_id = ? AND status = \'approved\'').get(req.user.id, target_person_id);
      if (!granted) return res.status(403).json({ error: '需要获得本人的授权才能记录 TA 的生平' });
    }
  } else if (type === 'person_claim') {
    // 补全自己：本人节点由访谈引擎自动 ensure-self（无需前端预建）
    const self = db.prepare('SELECT id FROM persons WHERE claimed_by_user_id = ? AND status != \'deleted\'').get(req.user.id);
    if (self) target_person_id = self.id;
    // 若无本人节点，留空，引擎 startInterview 会 ensureSelfNode 自动建
  }
  try {
    const r = await iv.startInterview({ userId: req.user.id, type, targetPersonId: target_person_id, relayMode: !!relay_mode, nickname: (req.body && req.body.nickname) || '', era: (req.body && req.body.era) || '', focusPersonId: focus_person_id, focusRelation: focus_relation, chapterId: chapter_id });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 发送消息
router.post('/message', async (req, res) => {
  const { interviewId, text, relay_mode = false, nickname = '', audio_id = null } = req.body || {};
  if (!interviewId || !text) return res.status(400).json({ error: '缺少参数' });
  const iv0 = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!iv0) return res.status(404).json({ error: '访谈不存在' });
  if (iv0.user_id !== req.user.id) return res.status(403).json({ error: '无权访问该访谈' });
  try {
    const r = await iv.sendMessage(interviewId, text, { relayMode: !!relay_mode, nickname, audioId: audio_id || null });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 用户复核确认后写回事实
router.patch('/:id/review', async (req, res) => {
  const iv0 = db.prepare('SELECT * FROM interviews WHERE id = ?').get(+req.params.id);
  if (!iv0) return res.status(404).json({ error: '访谈不存在' });
  if (iv0.user_id !== req.user.id) return res.status(403).json({ error: '无权访问该访谈' });
  const { facts } = req.body || {};
  if (!facts) return res.status(400).json({ error: '缺少 facts' });
  try {
    const r = iv.applyReview(+req.params.id, facts);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 消息历史
router.get('/:id/messages', (req, res) => {
  const iv0 = db.prepare('SELECT * FROM interviews WHERE id = ?').get(+req.params.id);
  if (!iv0) return res.status(404).json({ error: '访谈不存在' });
  if (iv0.user_id !== req.user.id) return res.status(403).json({ error: '无权访问' });
  res.json({ messages: iv.getMessages(+req.params.id) });
});

// 「重新说」
router.post('/:id/resay', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '缺少 text' });
  const iv0 = db.prepare('SELECT * FROM interviews WHERE id = ?').get(+req.params.id);
  if (!iv0) return res.status(404).json({ error: '访谈不存在' });
  if (iv0.user_id !== req.user.id) return res.status(403).json({ error: '无权访问该访谈' });
  try {
    const r = await iv.resayMessage(+req.params.id, text);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 结束访谈
router.post('/:id/finish', async (req, res) => {
  const iv0 = db.prepare('SELECT * FROM interviews WHERE id = ?').get(+req.params.id);
  if (!iv0) return res.status(404).json({ error: '访谈不存在' });
  if (iv0.user_id !== req.user.id) return res.status(403).json({ error: '无权访问' });
  try {
    const r = await iv.finishInterview(+req.params.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
