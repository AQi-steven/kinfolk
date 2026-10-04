// server/src/routes/invitations.js
// 赛博传记 — 节点认领邀请（全局图模型，挂在 /api 下）
//   GET /api/invitations/:token → 公开查看邀请信息（认领页用，无需登录）
// 生成邀请走 POST /api/persons/:id/invite（见 persons.js）
const express = require('express');
const router = express.Router();
const db = require('../db');

// 公开：查看邀请信息（认领页用，无需登录）
router.get('/:token', (req, res) => {
  const inv = db.prepare(
    `SELECT i.status, i.expires_at, p.id AS node_id, p.name, p.claimed_by_user_id
     FROM invitations i JOIN persons p ON p.id = i.node_id WHERE i.token = ?`
  ).get(req.params.token);
  if (!inv) return res.status(404).json({ error: '邀请无效' });
  if (inv.claimed_by_user_id) return res.json({ status: 'claimed', node: { name: inv.name } });
  if (inv.status !== 'pending') return res.json({ status: inv.status, node: { name: inv.name } });
  res.json({ status: 'pending', node: { id: inv.node_id, name: inv.name } });
});

module.exports = router;
