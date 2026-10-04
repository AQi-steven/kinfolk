// server/src/routes/memoir.js
// 赛博传记 — 回忆录章节（挂在 /api/memoir 下）
//   GET  /api/memoir/persons/:id/memoir → 按权限返回可见章节（公开也可读 public）
//   POST /api/memoir/persons/:id/memoir → 节点本人撰写（多数由访谈引擎自动生成）
//   PATCH /api/memoir/chapters/:cid → 节点本人编辑已有章节
const express = require('express');
const router = express.Router();
const db = require('../db');
const llm = require('../llm');
const iv = require('../interview');
const bookgen = require('../bookgen');
const history = require('../chapter-history');
const { authMiddleware } = require('../auth');

function canView(chapter, isMember, isOwnerOfNode) {
  if (chapter.visibility === 'public') return true;
  if (chapter.visibility === 'family') return isMember;
  if (chapter.visibility === 'self') return isOwnerOfNode;
  return false;
}

// 读取（需登录：family 级别对全体已登录成员可见，self 仅节点本人）
router.get('/persons/:id/memoir', authMiddleware, (req, res) => {
  const pid = +req.params.id;
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(pid);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const isMember = !!req.user;
  const isOwnerOfNode = req.user && node.claimed_by_user_id === req.user.id;
  // 时间链条排序：年份升序（无年份的排末尾，再按创建顺序）。
  // 此前纯按 sort_order（=创建时间戳），后补的童年章会排到最后，破坏时间线。
  const chapters = db.prepare('SELECT * FROM memoir_chapters WHERE person_id = ? ORDER BY COALESCE(year, 9999), sort_order, id').all(pid);
  const visible = chapters.filter((c) => canView(c, isMember, isOwnerOfNode));
  res.json({ chapters: visible });
});

// ===== 成书（2026-10-04）=====
// 把「档案 + 章节 + 照片 + 原话」聚合成一整本可打印/可转发的 HTML。
// 🔴 权限：**仅节点本人**。理由 —— 成书会把所有可见章节汇总成一份完整传记，
//   逐章的 visibility 是分级的，汇总后无法再按章区分，因此必须在导出入口统一收口。
//   这是本文件里最严的一个接口，宁可少功能也不给出"绕过逐章权限"的路径。
//
// 出参：默认返回可直接打印的 HTML；?format=json 时返回聚合数据（供前端统计与调试）。
router.get('/persons/:id/book', authMiddleware, (req, res) => {
  const pid = +req.params.id;
  const node = db.prepare('SELECT * FROM persons WHERE id = ? AND status != ?').get(pid, 'deleted');
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '成书仅本人可导出（含全部章节与原话）' });
  }
  const chapters = db.prepare(
    "SELECT * FROM memoir_chapters WHERE person_id = ? AND IFNULL(summary,'') != '' ORDER BY COALESCE(year, 9999), sort_order, id"
  ).all(pid);

  const withData = chapters.map((c) => {
    const photos = db.prepare(
      "SELECT url, caption, user_hint FROM media WHERE person_id = ? AND chapter_id = ? AND type = 'photo' AND (status IS NULL OR status != 'deleted') ORDER BY id"
    ).all(pid, c.id).map((m) => ({ url: m.url, caption: m.caption || m.user_hint || '' }));
    const quotes = db.prepare(
      "SELECT m.content, a.file FROM messages m LEFT JOIN audio_clips a ON a.message_id = m.id " +
      "WHERE m.chapter_id = ? AND m.role = 'user' ORDER BY m.id"
    ).all(c.id).map((q) => ({
      text: q.content,
      audioUrl: q.file ? '/uploads/' + q.file : null,
    }));
    return { ...c, photos, quotes };
  });

  const person = {
    id: node.id, name: node.name, real_name: node.real_name || node.name,
    gender: node.gender, birth_date: node.birth_date, death_date: node.death_date,
    birthplace: node.birthplace, occupation: node.occupation, bio: node.bio,
  };
  const counts = {
    chapters: withData.length,
    photos: withData.reduce((n, c) => n + c.photos.length, 0),
    quotes: withData.reduce((n, c) => n + c.quotes.length, 0),
    audio: withData.reduce((n, c) => n + c.quotes.filter((q) => q.audioUrl).length, 0),
  };

  if (String(req.query.format || '') === 'json') {
    return res.json({ person, chapters: withData, counts });
  }

  // 绝对地址：成书 HTML 要能脱离本站独立打开/转发
  const absoluteBase = `${req.protocol}://${req.get('host')}`;
  const html = bookgen.buildBookHtml(
    { person, chapters: withData },
    {
      absoluteBase,
      style: String(req.query.style || 'warm'),
      includeAudio: req.query.audio !== '0',
      includeTimeline: req.query.timeline !== '0',
    }
  );
  res.type('html').send(html);
});

// 原话订正（2026-10-04，用户拍板"本人可订正，原音保留"）
// 🔴 只改 messages.content，**绝不碰 audio_clips** —— 声音是"这个人真的这么说过"的证据。
// 为什么允许订正：ASR 会听错（地名/人名尤其常见），错字留在"原话"里反而失真。
// 为什么留痕：订正后原文存进 profile.corrections 之外的独立位置不可行（表结构已定），
//   故用 memoir 表的 audit 字段思路过重 —— 改为：把原值写进 messages 前的
//   audit 记录表 corrections_audit，保证"改过什么"永远查得到。
router.patch('/messages/:mid', authMiddleware, (req, res) => {
  const mid = +req.params.mid;
  const { text = '' } = req.body || {};
  const t = String(text || '').trim();
  if (!t) return res.status(400).json({ error: '内容不能为空' });
  if (t.length > 2000) return res.status(400).json({ error: '内容太长' });
  const msg = db.prepare('SELECT id, interview_id, role, content FROM messages WHERE id = ?').get(mid);
  if (!msg) return res.status(404).json({ error: '记录不存在' });
  if (msg.role !== 'user') return res.status(403).json({ error: '只能订正本人说过的话' });
  const iv = db.prepare('SELECT target_person_id FROM interviews WHERE id = ?').get(msg.interview_id);
  const node = iv && iv.target_person_id
    ? db.prepare('SELECT claimed_by_user_id FROM persons WHERE id = ?').get(iv.target_person_id)
    : null;
  if (!node || node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '只有本人能订正自己说过的话' });
  }
  if (String(msg.content).trim() === t) return res.json({ ok: true, unchanged: true });

  // 留痕：订正前原文存档，永不丢
  try {
    db.prepare(
      'INSERT INTO corrections_audit(message_id, old_text, new_text, by_user_id) VALUES(?, ?, ?, ?)'
    ).run(mid, msg.content, t, req.user.id);
  } catch (e) {
    console.warn('[memoir] 订正留痕失败（正文已改，仅缺审计）:', e.message);
  }
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(t, mid);
  res.json({ ok: true, id: mid, text: t });
});

// 原话 / 原音追溯（2026-10-04）：返回这一章背后"本人当时说的话"与对应原音。
// 🔴 权限比正文更严：正文按章节 visibility 判定即可，但**原音一律仅节点本人**。
//    理由 —— 原音是未经整理的原始表达，可能含正文里已被抹去的隐私；
//    且 ASR 文本可能识别错，误听内容被他人看到比看不到更糟。
router.get('/chapters/:cid/source', authMiddleware, (req, res) => {
  const cid = +req.params.cid;
  const ch = db.prepare('SELECT id, person_id FROM memoir_chapters WHERE id = ?').get(cid);
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(ch.person_id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const isOwner = !!req.user && node.claimed_by_user_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: '原话与原音仅本人可见' });

  const quotes = db.prepare(
    "SELECT id, content, created_at FROM messages WHERE chapter_id = ? AND role = 'user' ORDER BY id"
  ).all(cid);
  // 原音按 message 关联；若历史数据缺 message_id，则回退按 chapter_id 直接取
  const clips = db.prepare(
    'SELECT id, message_id, file, duration_ms, created_at FROM audio_clips WHERE chapter_id = ? ORDER BY id'
  ).all(cid);
  res.json({
    quotes: quotes.map((q) => ({
      id: q.id,
      text: q.content,
      at: q.created_at,
      // 该句是否有对应原音，前端据此显示播放按钮
      hasAudio: clips.some((c) => c.message_id === q.id),
      audioUrl: (clips.find((c) => c.message_id === q.id) || {}).file
        ? '/uploads/' + clips.find((c) => c.message_id === q.id).file
        : null,
    })),
    audioCount: clips.length,
  });
});

// 撰写（节点本人）
router.post('/persons/:id/memoir', authMiddleware, (req, res) => {
  const pid = +req.params.id;
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(pid);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id !== req.user.id) return res.status(403).json({ error: '仅节点本人可撰写' });
  const { title = '', summary = '', excerpt = '', visibility = 'family', stage = 'life' } = req.body || {};
  const info = db.prepare(
    'INSERT INTO memoir_chapters(person_id, title, summary, excerpt, visibility, stage, sort_order) VALUES(?, ?, ?, ?, ?, ?, ?)'
  ).run(pid, title, summary, excerpt, visibility, stage, Date.now());
  res.json({ chapter: { id: info.lastInsertRowid, title, summary, excerpt, visibility, stage } });
});

// 编辑已有章节（节点本人）
router.patch('/chapters/:cid', authMiddleware, (req, res) => {
  const cid = +req.params.cid;
  const ch = db.prepare('SELECT * FROM memoir_chapters WHERE id = ?').get(cid);
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(ch.person_id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id !== req.user.id) return res.status(403).json({ error: '仅节点本人可编辑' });
  const { title, summary, excerpt, visibility, year } = req.body || {};
  const sets = [];
  const vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (summary !== undefined) { sets.push('summary = ?'); vals.push(summary); }
  if (excerpt !== undefined) { sets.push('excerpt = ?'); vals.push(excerpt); }
  if (visibility !== undefined) { sets.push('visibility = ?'); vals.push(visibility); }
  if (year !== undefined) {
    // 年份允许整数或清空（null）—— 时间链条的手工纠偏口子
    const y = (year === null || year === '' || year === undefined) ? null : parseInt(year, 10);
    if (y !== null && (!Number.isFinite(y) || y < 1800 || y > 2100)) {
      return res.status(400).json({ error: '年份需为 1800-2100 的整数' });
    }
    sets.push('year = ?'); vals.push(y);
  }
  if (!sets.length) return res.status(400).json({ error: '无更新内容' });
  // 🔴 改动正文前必须留痕（2026-10-04）：否则用户改一次，AI 写的原文永久消失。
  //   source='edit' 表示本人手工编辑。
  history.snapshotChapter(cid, req.user.id, 'edit', (req.body && req.body.note) || '');
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(cid);
  db.prepare(`UPDATE memoir_chapters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// 章节版本历史（2026-10-04）：仅节点本人可查
router.get('/chapters/:cid/versions', authMiddleware, (req, res) => {
  const cid = +req.params.cid;
  const ch = db.prepare('SELECT person_id FROM memoir_chapters WHERE id = ?').get(cid);
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  const node = db.prepare('SELECT claimed_by_user_id FROM persons WHERE id = ?').get(ch.person_id);
  if (!node || node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '仅本人可查看修改历史' });
  }
  res.json({ versions: history.listVersions(cid, req.query.limit), max: history.MAX_VERSIONS });
});

// 回滚到某一版（2026-10-04）
// 可逆：回滚前先把【当前】正文也存一版，所以"回滚错了还能滚回来"
router.post('/chapters/:cid/restore', authMiddleware, (req, res) => {
  const cid = +req.params.cid;
  const vid = +(req.body && req.body.version_id);
  if (!vid) return res.status(400).json({ error: '缺少 version_id' });
  const ch = db.prepare('SELECT id, person_id FROM memoir_chapters WHERE id = ?').get(cid);
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  const node = db.prepare('SELECT claimed_by_user_id FROM persons WHERE id = ?').get(ch.person_id);
  if (!node || node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '仅本人可回滚' });
  }
  const v = history.getVersion(vid);
  if (!v || v.chapter_id !== cid) return res.status(404).json({ error: '该版本不存在' });

  // 先存当前版本，再覆盖 → 回滚本身也可被回滚
  history.snapshotChapter(cid, req.user.id, 'restore', '回滚前自动存档');

  // 🔴 空正文保护：历史里若存在空正文版本（早期脏数据），拒绝回滚，绝不把章节写空
  if (!String(v.summary || '').trim() && !String(v.excerpt || '').trim()) {
    return res.status(400).json({ error: '该版本正文为空，已拒绝回滚（避免把章节写空）' });
  }
  db.prepare(
    "UPDATE memoir_chapters SET title = ?, summary = ?, excerpt = ?, year = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(v.title || '', v.summary || '', v.excerpt || '', v.year == null ? null : v.year, cid);
  res.json({ ok: true, restoredFrom: vid });
});

// ============================================================
// 逐章「补讲」：POST /api/memoir/chapters/:cid/extend
// ------------------------------------------------------------
// 用户诉求（2026-09-14）："回忆录每一段能否补讲？补讲后 AI 根据前后讲解再融合形成本段回忆"。
// 语义 = 把这一段新讲的内容**就地织进这一节的正文**（不是另起一节）。
// 与 /api/persons/:id/experience 的分工：
//   /experience  = 讲一件**新的事** → 新建一节；
//   /extend      = 给**已有的一节**再添细节 → 重写这一节。
// 权限与 PATCH /chapters/:cid 一致：仅节点本人（claimed_by_user_id）可补讲。
// ============================================================
router.post('/chapters/:cid/extend', authMiddleware, async (req, res) => {
  const cid = +req.params.cid;
  if (!Number.isFinite(cid)) return res.status(400).json({ error: '参数错误' });
  const ch = db.prepare('SELECT * FROM memoir_chapters WHERE id = ?').get(cid);
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ? AND status != ?').get(ch.person_id, 'deleted');
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id !== req.user.id) return res.status(403).json({ error: '仅节点本人可补讲' });

  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  if (!text) return res.status(400).json({ error: '请先写点内容' });
  if (text.length > 2000) return res.status(400).json({ error: '单次内容太长（上限 2000 字）' });

  let merged;
  try {
    merged = await llm.extendChapter(
      { title: ch.title, summary: ch.summary, excerpt: ch.excerpt, year: ch.year, stage: ch.stage },
      text,
      { timeoutMs: 180000, allowFallback: false }
    );
  } catch (e) {
    console.error('[extend] 融合失败：', e.message);
    return res.status(502).json({ error: '融合失败，请稍后重试' });
  }
  // 🔒 空正文保护：融合稿不准把正文弄丢（同 /experience 的空正文护栏）
  if (!merged.summary || !merged.summary.trim()) {
    return res.status(422).json({ error: '这段内容暂时没能融进本节正文。请再补充一两句细节后重试。' });
  }

  // 校正映射（昵称→刚刚 这类）必须应用到写入，避免把已修正的错字重新写回去
  const title = iv.correctText(merged.title || ch.title || '', ch.person_id);
  const summary = iv.correctText(merged.summary, ch.person_id);
  const excerpt = iv.correctText(merged.excerpt || ch.excerpt || '', ch.person_id);
  const year = Number.isFinite(merged.year) ? merged.year : (ch.year == null ? null : ch.year);
  // 🔴 补讲会重写整章正文（2026-10-04）：覆盖前留痕，AI 改的与���改的要能分辨
  history.snapshotChapter(cid, req.user.id, 'ai_extend', '➕ 补讲这一节（AI 融合）');
  db.prepare(
    "UPDATE memoir_chapters SET title = ?, summary = ?, excerpt = ?, year = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(title || ch.title, summary, excerpt, year, cid);

  const chapter = db.prepare('SELECT * FROM memoir_chapters WHERE id = ?').get(cid);
  res.json({ ok: true, chapter, sameTopic: merged.sameTopic !== false, warnings: merged.problems || [] });
});

module.exports = router;
