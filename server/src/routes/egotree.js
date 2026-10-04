// server/src/routes/egotree.js
// 赛博传记 — 以某人为中心的 ego 大树（全局图 BFS 展开）
// 前端首屏：以本人节点为根，展开上三/下三/配偶/偏直系，可逐级下钻。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');

router.use(authMiddleware);

function pInfo(pid) {
  return db.prepare("SELECT id, name, real_name, gender, birth_date, status, visibility, claimed_by_user_id, generation, surname FROM persons WHERE id = ? AND status != 'deleted'").get(pid);
}

// 取某人的直接关系（父母 / 子女 / 配偶）
function directRels(pid) {
  const parents = [];
  const children = [];
  const spouses = [];
  const rows = db.prepare("SELECT from_person_id, to_person_id, type FROM relationships WHERE (from_person_id = ? OR to_person_id = ?) AND status != 'deleted'").all(pid, pid);
  rows.forEach((r) => {
    if (r.type === 'parent' && r.to_person_id === pid) parents.push(r.from_person_id);
    if (r.type === 'parent' && r.from_person_id === pid) children.push(r.to_person_id);
    if (r.type === 'spouse') {
      const other = r.from_person_id === pid ? r.to_person_id : r.from_person_id;
      if (!spouses.includes(other)) spouses.push(other);
    }
  });
  return { parents, children, spouses };
}

// 计算 ego 树：从 centerId BFS，maxDepth 控制展开层数（默认 3 代 = 上三下三 + 配偶家一层）
function computeEgoTree(centerId, maxDepth = 4) {
  const center = pInfo(centerId);
  if (!center) return null;
  const nodes = new Map();
  const edges = [];
  const edgeSet = new Set(); // 防重复边（同一对节点经不同路径出现两次）
  const seen = new Set();
  nodes.set(centerId, { ...center, depth: 0, relation: 'self', parentId: null });

  const queue = [{ id: centerId, depth: 0, parentId: null, relation: 'self' }];
  seen.add(centerId);

  while (queue.length) {
    const cur = queue.shift();
    if (cur.depth >= maxDepth) continue;
    const rels = directRels(cur.id);
    const candidates = [
      ...rels.parents.map((pid) => ({ pid, relation: cur.relation === 'self' ? 'parent' : 'ancestor', depth: cur.depth + 1 })),
      ...rels.children.map((pid) => ({ pid, relation: cur.relation === 'self' ? 'child' : 'descendant', depth: cur.depth + 1 })),
      ...rels.spouses.map((pid) => ({ pid, relation: 'spouse', depth: cur.depth + 1 })),
    ];
    candidates.forEach((c) => {
      const info = pInfo(c.pid);
      if (!info) return;
      const edgeKey = cur.id + '>' + c.pid + ':' + c.relation;
      if (!edgeSet.has(edgeKey)) { edgeSet.add(edgeKey); edges.push({ from: cur.id, to: c.pid, type: c.relation }); }
      if (!seen.has(c.pid)) {
        seen.add(c.pid);
        nodes.set(c.pid, { ...info, depth: c.depth, relation: c.relation, parentId: cur.id });
        queue.push({ id: c.pid, depth: c.depth, parentId: cur.id, relation: c.relation });
      }
    });
  }

  return {
    centerId,
    nodes: [...nodes.values()].map((n) => ({
      id: n.id, name: n.name, gender: n.gender, birth_date: n.birth_date,
      status: n.status, depth: n.depth, relation: n.relation, parentId: n.parentId,
      claimed: !!n.claimed_by_user_id, isSelf: n.id === centerId,
    })),
    edges,
  };
}

router.get('/', (req, res) => {
  const centerId = +req.query.center;
  if (!centerId) return res.status(400).json({ error: '缺少 center' });
  const tree = computeEgoTree(centerId);
  if (!tree) return res.status(404).json({ error: '人物不存在' });
  res.json(tree);
});

module.exports = router;
module.exports.computeEgoTree = computeEgoTree;
module.exports.directRels = directRels;
