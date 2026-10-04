// server/src/routes/suggestions.js
// 赛博传记 — 家人补充建议（P5，2026-10-04）
//
// 闭环：家人（有代录授权）写补充 → 本人在回忆录里看到待确认 → 点「采纳」即时入正文。
//
// 🔴 三条权限铁律（这是本功能的全部价值所在，改动前务必确认没破）：
//   1. 家人**只能提交建议**，永远不能直接改正文 —— 正文只能由本人点「采纳」后写入。
//   2. 只有节点本人能查看建议列表、采纳或驳回。
//   3. 采纳只改章节正文；**原话（messages.content）与原音（audio_clips）一律不动**
//      —— 那是"这个人当时真的这么说的"证据，任何人无权改写，包括本人自己也不行
//      （本人只能新增订正，见 memoir 的 /chapters/:cid/source 下的订正接口）。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');

router.use(authMiddleware);

// 写权限：与 media/代录同一口径 —— 本人认领 / 已获代录授权 / 节点创建人
function canContribute(pid, uid) {
  const p = db.prepare('SELECT claimed_by_user_id, founder_user_id FROM persons WHERE id = ?').get(pid);
  if (!p) return { ok: false, code: 404, msg: '节点不存在' };
  if (p.claimed_by_user_id === uid) return { ok: true, asOwner: true };
  if (p.founder_user_id === uid) return { ok: true, asOwner: false };
  const granted = db.prepare(
    "SELECT id FROM relay_requests WHERE requester_user_id = ? AND target_person_id = ? AND status = 'approved'"
  ).get(uid, pid);
  if (!granted) {
    return { ok: false, code: 403, msg: '需要本人授权才能补充 TA 的传记' };
  }
  return { ok: true, asOwner: false };
}

function isOwnerOf(pid, uid) {
  const p = db.prepare('SELECT claimed_by_user_id FROM persons WHERE id = ?').get(pid);
  return !!p && p.claimed_by_user_id === uid;
}

// 提交建议
router.post('/', (req, res) => {
  const { person_id, chapter_id = null, content = '', kind = 'story' } = req.body || {};
  if (!person_id) return res.status(400).json({ error: '缺少 person_id' });
  const txt = String(content || '').trim();
  if (!txt) return res.status(400).json({ error: '内容不能为空' });
  if (txt.length > 2000) return res.status(400).json({ error: '内容太长（上限 2000 字）' });
  if (!['story', 'photo', 'fact'].includes(kind)) return res.status(400).json({ error: 'kind 不合法' });

  const perm = canContribute(+person_id, req.user.id);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.msg });
  // 本人也能提交（等于记给自己看的备忘），但没必要走待确认，直接拒绝以免混淆
  if (perm.asOwner) return res.status(400).json({ error: '这是你自己的传记，请直接用「✏️ 改文字」修改' });

  // 章节必须属于该人物，防止挂错章
  if (chapter_id) {
    const ch = db.prepare('SELECT id FROM memoir_chapters WHERE id = ? AND person_id = ?').get(+chapter_id, +person_id);
    if (!ch) return res.status(400).json({ error: '章节不属于该传记' });
  }

  // 署名：优先用注册时填的昵称/真名，其次用户名 —— 本人要能认出"这是谁写的"
  const u = db.prepare('SELECT real_name, nickname, identifier FROM users WHERE id = ?').get(req.user.id) || {};
  const authorName = (u.nickname || u.real_name || '').trim() || ('家人' + String(req.user.id).slice(-2));

  const info = db.prepare(
    'INSERT INTO suggestions(person_id, chapter_id, author_user_id, author_name, content, kind) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(+person_id, chapter_id ? +chapter_id : null, req.user.id, authorName, txt, kind);
  res.json({ id: Number(info.lastInsertRowid), ok: true, authorName });
});

// 本人查看待确认（也返回已处理的，便于回看）
router.get('/person/:pid', (req, res) => {
  const pid = +req.params.pid;
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(pid);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  // 🔴 仅本人可见别人的意见（避免家庭内部尴尬，也避免被当成攻击面）
  if (node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '只有本人能查看收到的补充建议' });
  }
  const list = db.prepare(
    'SELECT id, chapter_id, author_name, content, kind, status, adopted_chapter_id, created_at ' +
    'FROM suggestions WHERE person_id = ? ORDER BY status = \'pending\' DESC, id DESC LIMIT 100'
  ).all(pid);
  res.json({ suggestions: list, pending: list.filter((s) => s.status === 'pending').length });
});

// 本人采纳：内容直接并入目标章节正文（走 AI 融合，保留旧信息不丢不重复）
router.post('/:id/adopt', async (req, res) => {
  const sid = +req.params.id;
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(sid);
  if (!s) return res.status(404).json({ error: '建议不存在' });
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(s.person_id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '只有本人能决定是否采纳' });
  }
  if (s.status !== 'pending') return res.status(409).json({ error: '这条已经处理过了' });

  const { chapter_id = null } = req.body || {};
  const targetCid = chapter_id ? +chapter_id : s.chapter_id;
  const target = targetCid
    ? db.prepare('SELECT * FROM memoir_chapters WHERE id = ? AND person_id = ?').get(targetCid, s.person_id)
    : null;
  if (targetCid && !target) return res.status(400).json({ error: '章节不属于该传记' });

  // 无指定章节 → 新建一章。标题由内容首句生成，避免整段文字当标题
  let cid = targetCid;
  if (!cid) {
    const title = String(s.content).replace(/\s+/g, ' ').slice(0, 20) || '家人补充';
    const info = db.prepare(
      "INSERT INTO memoir_chapters(person_id, title, summary, excerpt, visibility, stage, sort_order) VALUES(?, ?, '', '', 'family', 'life', ?)"
    ).run(s.person_id, title, Date.now());
    cid = Number(info.lastInsertRowid);
  }

  // 已有正文 → 用 extendChapter 让 AI 融合（旧信息不丢不重复）；新章 → 直接作为正文
  const llm = require('../llm');
  const cur = db.prepare('SELECT title, summary, excerpt, year, stage FROM memoir_chapters WHERE id = ?').get(cid);
  let newSummary = String(s.content || '').trim();
  if (String(cur.summary || '').trim()) {
    try {
      const merged = await llm.extendChapter(
        { title: cur.title, summary: cur.summary, excerpt: cur.excerpt, year: cur.year, stage: cur.stage },
        newSummary,
        { timeoutMs: 180000, allowFallback: false }
      );
      if (merged && String(merged.summary || '').trim()) {
        newSummary = merged.summary;
        if (merged.title) cur.title = merged.title;
        if (merged.excerpt) cur.excerpt = merged.excerpt;
      }
      // 融合失败则退为拼接，宁可内容长一点也不丢家人写的
    } catch (e) {
      console.warn('[suggestions] AI 融合失败，退为追加：', e.message);
      newSummary = String(cur.summary || '').trim() + '\n\n' + newSummary;
    }
  }
  if (!String(newSummary || '').trim()) {
    return res.status(400).json({ error: '内容为空，未采纳' });
  }
  // 🔴 采纳家人建议会重写正文（2026-10-04）：留痕，注明是谁的建议
  //   source='suggestion' + note 记建议人，日后能看出这段是家人补的还是本人写的
  require('../chapter-history').snapshotChapter(
    cid, req.user.id, 'suggestion',
    '采纳「' + (s.author_name || '家人') + '」的补充'
  );
  db.prepare(
    "UPDATE memoir_chapters SET title = ?, summary = ?, excerpt = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(cur.title, newSummary, cur.excerpt || '', cid);
  db.prepare(
    "UPDATE suggestions SET status = 'adopted', adopted_chapter_id = ?, adopted_at = datetime('now','localtime') WHERE id = ?"
  ).run(cid, sid);

  // 🔴 注意：这里**刻意不动** messages / audio_clips —— 原话与原音是证据，不可被建议覆盖
  res.json({ ok: true, chapterId: cid, title: cur.title });
});

// 本人驳回
router.post('/:id/dismiss', (req, res) => {
  const sid = +req.params.id;
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(sid);
  if (!s) return res.status(404).json({ error: '建议不存在' });
  const node = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(s.person_id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: '只有本人能处理这些建议' });
  }
  if (s.status !== 'pending') return res.status(409).json({ error: '这条已经处理过了' });
  db.prepare("UPDATE suggestions SET status = 'dismissed' WHERE id = ?").run(sid);
  res.json({ ok: true });
});

module.exports = router;
