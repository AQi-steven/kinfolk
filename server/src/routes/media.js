// server/src/routes/media.js
// 赛博传记 — 媒体路由（全局图模型：无 tree 维度，鉴权 = 对人物节点的写权限）
//   POST /api/media         → 记录一条已存在的媒体（url 由前端/外部提供）
//   POST /api/media/upload  → 接收原始二进制图片（fetch raw body），存盘并返回可访问 URL
//   POST /api/media/:id/caption → AI 为照片生成一句配文（基于人物上下文 + 用户描述）
//   DELETE /api/media/:id   → 删除
const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../auth');
const { chatCompletion } = require('../llm');
const { getLLMConfig } = require('../config');

router.use(authMiddleware);

// 上传目录：<项目根>/web/uploads（被 express.static 托管，可直接 /uploads/xxx 访问）
const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'web', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 写权限：本人认领 / 已获代录授权 / 节点创始人
function canWritePerson(pid, uid) {
  const p = db.prepare('SELECT claimed_by_user_id, founder_user_id FROM persons WHERE id = ?').get(pid);
  if (!p) return false;
  if (p.claimed_by_user_id === uid) return true;
  if (p.founder_user_id === uid) return true;
  const granted = db.prepare("SELECT id FROM relay_requests WHERE requester_user_id = ? AND target_person_id = ? AND status = 'approved'").get(uid, pid);
  return !!granted;
}

// 记录外部 url 的媒体
router.post('/', (req, res) => {
  const b = req.body || {};
  const personId = Number(b.person_id);
  if (!personId || !b.url) return res.status(400).json({ error: 'person_id & url required' });
  if (!canWritePerson(personId, req.user.id)) return res.status(403).json({ error: '无权操作该人物的资料' });
  const info = db.prepare('INSERT INTO media(person_id, url, type, caption) VALUES(?, ?, ?, ?)').run(personId, b.url, b.type || 'photo', b.caption || '');
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

// 上传原始图片二进制（前端用 fetch blob，不加 multipart，零依赖）
// 限制 8MB，仅允许常见图片类型；兼容旧前端多传的 tree_id 参数（忽略）
router.post('/upload', express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
  const personId = +req.query.person_id;
  if (!personId) return res.status(400).json({ error: '缺少 person_id' });
  if (!canWritePerson(personId, req.user.id)) return res.status(403).json({ error: '无权操作该人物的资料' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: '空文件' });
  const ct = (req.headers['content-type'] || 'image/jpeg').split(';')[0];
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[ct] || 'jpg';
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fname = `m_${personId}_${stamp}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  const url = '/uploads/' + fname;
  // 可选上下文（2026-10-04 照片破冰）：挂在哪次访谈 / 哪一章；都不传则退化为"人物相册"
  const chapterId = req.query.chapter_id ? +req.query.chapter_id : null;
  const interviewId = req.query.interview_id ? +req.query.interview_id : null;
  const hint = typeof req.query.hint === 'string' ? req.query.hint.slice(0, 200) : '';
  const info = db.prepare(
    "INSERT INTO media(person_id, url, type, caption, chapter_id, interview_id, user_hint) VALUES(?, ?, ?, '', ?, ?, ?)"
  ).run(personId, url, 'photo', chapterId, interviewId, hint);
  res.json({ id: Number(info.lastInsertRowid), url, ok: true, chapter_id: chapterId, interview_id: interviewId });
});

// 照片破冰：老人翻出一张老照片时，用它把访谈从"空白"里拽出来。
// 设计取舍（2026-10-04）：不上通用视觉大模型。理由是成本、延迟、隐私三重负担，
// 且 hy3 不支持 tools；而照片本身已经提供了上下文，AI 真正要做的是"问出照片里那件具体的事"。
// 因此用「已有浅层人物档案 + 用户一句补充 + 本次主题」拼一个针对性破冰问题。
router.post('/icebreak', async (req, res) => {
  const { person_id, hint = '', topic = '' } = req.body || {};
  if (!person_id) return res.status(400).json({ error: '缺少 person_id' });
  if (!canWritePerson(+person_id, req.user.id)) return res.status(403).json({ error: '无权操作该人物的资料' });
  const cfg = getLLMConfig();
  const fallback = hint
    ? `这张照片里一定有故事。${hint}——那时候旁边还有谁？`
    : '看着这张照片，浮上来第一个念头是什么？是哪一年、还是谁？';
  if (cfg.demoMode || !cfg.apiKey) return res.json({ reply: fallback, demo: true });
  // 只取有助于破冰的浅层字段，不碰隐私深度项
  const p = db.prepare('SELECT name, gender, birth_date, birthplace, occupation FROM persons WHERE id = ?').get(+person_id) || {};
  const who = p.name || '这位长辈';
  const known = [
    p.birth_date ? `${p.birth_date}前后出生` : '',
    p.birthplace ? `籍贯${p.birthplace}` : '',
    p.occupation ? `做过${p.occupation}` : '',
  ].filter(Boolean).join('、');
  try {
    const r = await chatCompletion([
      {
        role: 'system',
        content: `你是「${who}」的老朋友，在陪 TA 回忆往事。TA 刚翻出一张老照片。

要求：
1. 像朋友一样自然起个话头，不要像采访
2. 只问【一个】具体、好回答的小问题，最好直接指向照片里某个人、物或场景
3. 不编造照片里看不到的内容；看不清就问"这是谁呀""这是什么时候拍的"
4. 称呼用「${who}」或"你"，别用"老人""用户""讲述者"
5. 全文两三句以内，最后一句是那个问题`,
      },
      {
        role: 'user',
        content: [
          known ? `已知信息：${known}` : '',
          topic ? `这次想聊的主题：${topic}` : '',
          hint ? `TA 对这张照片的补充：${hint}` : 'TA 没多说什么，只说"这是以前的一张照片"。',
        ].filter(Boolean).join('\n'),
      },
    ], {});
    return res.json({ reply: (r.reply || '').trim() || fallback, demo: false });
  } catch (e) {
    console.error('[media] 破冰提问失败，用兜底：', e.message);
    return res.json({ reply: fallback, demo: true, degraded: true });
  }
});

// 列出某个人物（可选按章节过滤）的照片，供回忆录/人物页回看
// 注意：media 有 status 软删列（db.js 幂等迁移新增），查询必须过滤，否则已删照片会重新出现
router.get('/persons/:id', (req, res) => {
  const pid = +req.params.id;
  const chapterId = req.query.chapter_id ? +req.query.chapter_id : null;
  const base = "SELECT id, url, type, caption, user_hint, chapter_id, created_at FROM media WHERE person_id = ? AND type = 'photo' AND (status IS NULL OR status != 'deleted')";
  const rows = chapterId
    ? db.prepare(base + ' AND chapter_id = ? ORDER BY id DESC').all(pid, chapterId)
    : db.prepare(base + ' ORDER BY id DESC').all(pid);
  res.json({ media: rows });
});

// AI 为照片生成一句配文
router.post('/:id/caption', async (req, res) => {
  const id = +req.params.id;
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!canWritePerson(m.person_id, req.user.id)) return res.status(403).json({ error: '无权操作' });
  const person = db.prepare('SELECT name, gender, birth_date, occupation, bio FROM persons WHERE id = ?').get(m.person_id);
  const ctx = person ? `照片主人公：${person.name}（${person.gender || '未知'}${person.birth_date ? '，生于' + person.birth_date : ''}${person.occupation ? '，' + person.occupation : ''}）。` : '';
  const hint = (req.body && req.body.hint) || '';
  const cfg = getLLMConfig();
  let caption = '';
  if (cfg.demoMode || !cfg.apiKey) {
    caption = hint ? `「${hint}」——定格此刻的温柔。` : '一张值得被记住的老照片。';
  } else {
    try {
      const msgs = [
        { role: 'system', content: '你是家族史书的配文师。根据照片主人公信息和用户补充的描述，写一句有温度、克制、像子孙给老照片题字的话（不超过 40 字，不要使用引号包裹，不要解释）。' },
        { role: 'user', content: `${ctx}${hint ? '\n用户补充：' + hint : ''}\n请为这张照片题一句配文。` },
      ];
      const r = await chatCompletion(msgs, {});
      caption = (r.reply || '').replace(/^["'「]|["'」]$/g, '').trim() || (hint ? hint : '一张值得被记住的老照片。');
    } catch (e) {
      caption = hint || '一张值得被记住的老照片。';
    }
  }
  db.prepare('UPDATE media SET caption = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(caption, id);
  res.json({ id, caption, ok: true });
});

router.delete('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!canWritePerson(m.person_id, req.user.id)) return res.status(403).json({ error: '无权操作' });
  // 同时删物理文件（仅限本应用上传目录内的相对 /uploads/ 文件）
  if (m.url && m.url.startsWith('/uploads/')) {
    const fp = path.join(__dirname, '..', '..', '..', 'web', m.url);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
  }
  db.prepare('DELETE FROM media WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
