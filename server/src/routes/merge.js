// server/src/routes/merge.js
// 赛博传记 — 同名三问题验证（阶段3）
// 两棵 ego 树出现「同名 + 同关系角色」候选 → 系统自动检测 → 双方各答 3 题（关系性事实 4 选 1）
// 判定：各对 ≥2 题 → 合并（X 方案：person_b 嫁接到 person_a，b 标记 deleted + merged_into）；否则 rejected。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { invalidateGraphCache } = require('../interview');

router.use(authMiddleware);

// —— 工具 ——
function nameOf(pid) {
  const p = db.prepare('SELECT name, real_name FROM persons WHERE id = ? AND status != \'deleted\'').get(pid);
  return p ? (p.real_name || p.name) : '';
}

// 从候选人关系脉络抽「正确值 + 干扰项」题库
function buildQuestionBank(pid) {
  const qb = [];
  // 1. 配偶姓名
  const spouse = db.prepare(
    "SELECT to_person_id FROM relationships WHERE from_person_id = ? AND type='spouse' AND status != 'deleted' LIMIT 1"
  ).get(pid);
  if (spouse) qb.push({ field: 'spouse', answer: nameOf(spouse.to_person_id) });
  // 2. 父亲 / 母亲姓名（parent 边反查：to=pid 表示 from 是 pid 的父母）
  const parents = db.prepare(
    "SELECT from_person_id, type FROM relationships WHERE to_person_id = ? AND type='parent' AND status != 'deleted'"
  ).all(pid);
  for (const pr of parents) {
    qb.push({ field: pr.type === 'parent' ? 'parent' : 'parent', answer: nameOf(pr.from_person_id) });
  }
  // 3. 子女姓名
  const children = db.prepare(
    "SELECT to_person_id FROM relationships WHERE from_person_id = ? AND type='parent' AND status != 'deleted'"
  ).all(pid);
  for (const ch of children) {
    qb.push({ field: 'child', answer: nameOf(ch.to_person_id) });
  }
  // 退化：关系脉络不足 → 传记定性题（出生地 / 职业）
  const p = db.prepare('SELECT birthplace, occupation FROM persons WHERE id = ?').get(pid);
  if (p) {
    if (p.birthplace) qb.push({ field: 'birthplace', answer: p.birthplace });
    if (p.occupation) qb.push({ field: 'occupation', answer: p.occupation });
  }
  return qb;
}

// 取 n 个随机干扰项（同字段类型的其他节点值）
function distractors(field, correct, n) {
  let pool = [];
  if (field === 'spouse' || field === 'parent' || field === 'child') {
    pool = db.prepare(
      "SELECT DISTINCT name FROM persons WHERE status != 'deleted' AND name != ? AND name != '' ORDER BY RANDOM() LIMIT ?"
    ).all(correct, n * 3).map((r) => r.name);
  } else if (field === 'birthplace') {
    pool = db.prepare(
      "SELECT DISTINCT birthplace FROM persons WHERE status != 'deleted' AND birthplace != ? AND birthplace != '' ORDER BY RANDOM() LIMIT ?"
    ).all(correct, n * 3).map((r) => r.birthplace);
  } else if (field === 'occupation') {
    pool = db.prepare(
      "SELECT DISTINCT occupation FROM persons WHERE status != 'deleted' AND occupation != ? AND occupation != '' ORDER BY RANDOM() LIMIT ?"
    ).all(correct, n * 3).map((r) => r.occupation);
  }
  // 去重 + 截 n 个；若不足 n，用占位补齐
  const uniq = [...new Set(pool.filter((x) => x && x !== correct))].slice(0, n);
  while (uniq.length < n) uniq.push('（其他）');
  return uniq;
}

const FIELD_LABEL = {
  spouse: 'TA 的配偶叫什么？',
  parent: 'TA 的父亲/母亲叫什么？',
  child: 'TA 的子女中有谁？',
  birthplace: 'TA 出生在哪个城市？',
  occupation: 'TA 从事什么职业？',
};

// 抽 3 题（按候选 pid 的脉络）；返回 [{q, options:[4], answerIndex}]
function buildQuestions(pid) {
  const bank = buildQuestionBank(pid);
  if (!bank.length) return [];
  // 打乱取前 3
  const shuffled = bank.sort(() => Math.random() - 0.5).slice(0, 3);
  return shuffled.map((item) => {
    const opts = [item.answer, ...distractors(item.field, item.answer, 3)];
    // 洗牌选项
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    return {
      q: FIELD_LABEL[item.field] || '关于 TA 的一个事实？',
      options: opts,
      answerIndex: opts.indexOf(item.answer),
    };
  });
}

// —— 撞名检测（relate 后调用）——
// 规则：传入刚变动的节点 pid，扫描全库「同名 + 同关系角色」的其他节点，逐对生成提案。
function detectMergeCandidates(pid, proposer) {
  const p = db.prepare("SELECT id, name, real_name, status FROM persons WHERE id = ? AND status != 'deleted'").get(pid);
  if (!p) return;
  // 同名候选（name 或 real_name 相等，排除自己与已合并节点）
  const nameMatches = db.prepare(
    "SELECT id, name, real_name FROM persons WHERE id != ? AND status != 'deleted'"
  ).all(pid).filter((o) =>
    (p.name && o.name && p.name === o.name) ||
    (p.real_name && o.real_name && p.real_name === o.real_name)
  );
  if (!nameMatches.length) return;
  // pid 的关系角色集合
  const rolesP = db.prepare(
    "SELECT DISTINCT type FROM relationships WHERE (from_person_id = ? OR to_person_id = ?) AND status != 'deleted'"
  ).all(pid, pid).map((r) => r.type);
  for (const o of nameMatches) {
    const rolesO = db.prepare(
      "SELECT DISTINCT type FROM relationships WHERE (from_person_id = ? OR to_person_id = ?) AND status != 'deleted'"
    ).all(o.id, o.id).map((r) => r.type);
    const sharedRole = rolesP.filter((r) => rolesO.includes(r));
    if (!sharedRole.length) continue; // 不同角色，跳过
    // 去重
    const ex = db.prepare(
      'SELECT id FROM merge_proposals WHERE ((person_a = ? AND person_b = ?) OR (person_a = ? AND person_b = ?)) AND status IN (\'pending\',\'merged\')'
    ).get(pid, o.id, o.id, pid);
    if (ex) continue;
    const qa = buildQuestions(pid);
    const qb = buildQuestions(o.id);
    if (!qa.length || !qb.length) continue; // 任一方无法抽题则跳过
    db.prepare(
      "INSERT INTO merge_proposals(person_a, person_b, proposed_by, status, questions_a, questions_b) VALUES(?, ?, ?, 'pending', ?, ?)"
    ).run(pid, o.id, proposer, JSON.stringify(qa), JSON.stringify(qb));
  }
}

// —— 列表 / 收件箱 ——
// 我作为相关方的所有 pending 提案（我是 a 或 b 节点的认领人，或创始人）
router.get('/proposals', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.person_a, m.person_b, m.status, m.created_at,
           pa.name AS name_a, pb.name AS name_b
    FROM merge_proposals m
    JOIN persons pa ON pa.id = m.person_a
    JOIN persons pb ON pb.id = m.person_b
    WHERE m.status = 'pending'
      AND (
        pa.claimed_by_user_id = ? OR pb.claimed_by_user_id = ?
        OR pa.founder_user_id = ? OR pb.founder_user_id = ?
      )
    ORDER BY m.created_at DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);
  res.json({ proposals: rows });
});

// 取单个提案详情（含给对方出的题 / 自己要答的题）
router.get('/proposals/:id', (req, res) => {
  const id = +req.params.id;
  const m = db.prepare('SELECT * FROM merge_proposals WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const pa = db.prepare('SELECT id, name, real_name, claimed_by_user_id, founder_user_id FROM persons WHERE id = ?').get(m.person_a);
  const pb = db.prepare('SELECT id, name, real_name, claimed_by_user_id, founder_user_id FROM persons WHERE id = ?').get(m.person_b);
  // 我能答的题：我是哪一方认领人/创始人，就答那一方
  let myQuestions = [];
  let mySide = null;
  if (pa && (pa.claimed_by_user_id === req.user.id || pa.founder_user_id === req.user.id)) { myQuestions = JSON.parse(m.questions_a || '[]'); mySide = 'a'; }
  else if (pb && (pb.claimed_by_user_id === req.user.id || pb.founder_user_id === req.user.id)) { myQuestions = JSON.parse(m.questions_b || '[]'); mySide = 'b'; }
  else return res.status(403).json({ error: '无权查看此提案' });
  res.json({
    proposal: m,
    name_a: pa ? (pa.real_name || pa.name) : '',
    name_b: pb ? (pb.real_name || pb.name) : '',
    mySide,
    myQuestions,
    alreadyAnswered: (mySide === 'a' ? (m.answers_a && m.answers_a !== '[]') : (m.answers_b && m.answers_b !== '[]')),
  });
});

// 作答
router.post('/proposals/:id/answer', (req, res) => {
  const id = +req.params.id;
  const m = db.prepare('SELECT * FROM merge_proposals WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.status !== 'pending') return res.status(400).json({ error: '提案已处理' });
  const pa = db.prepare('SELECT id, claimed_by_user_id, founder_user_id FROM persons WHERE id = ?').get(m.person_a);
  const pb = db.prepare('SELECT id, claimed_by_user_id, founder_user_id FROM persons WHERE id = ?').get(m.person_b);
  const { answers } = req.body || {}; // 数组，元素为选中的 option index
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers 格式错误' });
  let mySide, questions, stored;
  if (pa && (pa.claimed_by_user_id === req.user.id || pa.founder_user_id === req.user.id)) {
    mySide = 'a'; questions = JSON.parse(m.questions_a || '[]'); stored = 'answers_a';
  } else if (pb && (pb.claimed_by_user_id === req.user.id || pb.founder_user_id === req.user.id)) {
    mySide = 'b'; questions = JSON.parse(m.questions_b || '[]'); stored = 'answers_b';
  } else return res.status(403).json({ error: '无权作答' });
  // 计分
  let correct = 0;
  answers.forEach((ans, i) => {
    if (questions[i] && ans === questions[i].answerIndex) correct++;
  });
  db.prepare(`UPDATE merge_proposals SET ${stored} = ?, matched = matched + ? WHERE id = ?`).run(JSON.stringify(answers), correct, id);
  res.json({ ok: true, correct, total: questions.length, side: mySide });
});

// 双方都答完后，任一方或系统触发判定
router.post('/proposals/:id/judge', (req, res) => {
  const id = +req.params.id;
  const m = db.prepare('SELECT * FROM merge_proposals WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.status !== 'pending') return res.status(400).json({ error: '提案已处理' });
  const aa = JSON.parse(m.answers_a || '[]');
  const ab = JSON.parse(m.answers_b || '[]');
  if (!aa.length || !ab.length) return res.status(400).json({ error: '双方尚未完成作答' });
  const qa = JSON.parse(m.questions_a || '[]');
  const qb = JSON.parse(m.questions_b || '[]');
  const correctA = aa.filter((ans, i) => qa[i] && ans === qa[i].answerIndex).length;
  const correctB = ab.filter((ans, i) => qb[i] && ans === qb[i].answerIndex).length;
  // 判定：双方各对 ≥2 且都非 0 → 合并
  const pass = correctA >= 2 && correctB >= 2;
  if (!pass) {
    db.prepare("UPDATE merge_proposals SET status='rejected', reviewed_at=datetime('now','localtime') WHERE id = ?").run(id);
    return res.json({ ok: true, merged: false, correctA, correctB });
  }
  // 合并 X：person_b 嫁接到 person_a
  const a = m.person_a, b = m.person_b;
  const tx = db.transaction(() => {
    // 关系边：把 b 作为 from 或 to 的边改指向 a（避免与 a 已有边重复）
    const edges = db.prepare("SELECT id, from_person_id, to_person_id, type FROM relationships WHERE (from_person_id = ? OR to_person_id = ?) AND status != 'deleted'").all(b, b);
    for (const e of edges) {
      const nf = e.from_person_id === b ? a : e.from_person_id;
      const nt = e.to_person_id === b ? a : e.to_person_id;
      if (nf === nt) { db.prepare('UPDATE relationships SET status=\'deleted\' WHERE id = ?').run(e.id); continue; }
      const dup = db.prepare('SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ? AND status != \'deleted\'').get(nf, nt, e.type);
      if (dup) { db.prepare('UPDATE relationships SET status=\'deleted\' WHERE id = ?').run(e.id); }
      else { db.prepare('UPDATE relationships SET from_person_id = ?, to_person_id = ? WHERE id = ?').run(nf, nt, e.id); }
    }
    // 媒体迁移
    db.prepare('UPDATE media SET person_id = ? WHERE person_id = ?').run(a, b);
    // 传记补全：a 为空字段用 b 补
    const pa = db.prepare('SELECT * FROM persons WHERE id = ?').get(a);
    const pbRow = db.prepare('SELECT * FROM persons WHERE id = ?').get(b);
    const fill = {};
    for (const k of ['gender','birth_date','death_date','birthplace','residence','occupation','education','bio']) {
      if (!pa[k] && pbRow[k]) fill[k] = pbRow[k];
    }
    if (Object.keys(fill).length) {
      const sets = Object.keys(fill).map((k) => `${k} = ?`);
      db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...Object.values(fill), a);
    }
    // 认领关系迁移：若 b 被某人认领，且 a 尚未被认领，则把认领人迁移到 a
    if (pbRow.claimed_by_user_id && !pa.claimed_by_user_id) {
      db.prepare('UPDATE persons SET claimed_by_user_id = ? WHERE id = ?').run(pbRow.claimed_by_user_id, a);
    }
    // b 标记 deleted + merged_into，并清空 b 的认领人（避免 ensure-self 读到 dead 节点）
    db.prepare("UPDATE persons SET status='deleted', merged_into = ?, claimed_by_user_id = NULL, updated_at=datetime('now','localtime') WHERE id = ?").run(a, b);
  });
  tx();
  db.prepare("UPDATE merge_proposals SET status='merged', reviewed_at=datetime('now','localtime') WHERE id = ?").run(id);
  invalidateGraphCache(); // 合并改写关系边/人物，失效全局图缓存
  res.json({ ok: true, merged: true, correctA, correctB, kept: a, removed: b });
});

module.exports = router;
module.exports.detectMergeCandidates = detectMergeCandidates;
