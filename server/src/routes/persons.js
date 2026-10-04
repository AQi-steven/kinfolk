// server/src/routes/persons.js
// 赛博传记 — 人物路由（全局图模型，无 tree 维度；需登录）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const iv = require('../interview');
const llm = require('../llm');
const { invalidateGraphCache } = iv;
function getDetect() {
  try {
    const m = require('./merge');
    return typeof m.detectMergeCandidates === 'function' ? m.detectMergeCandidates : null;
  } catch (e) { console.error('[merge require]', e.message); return null; }
}

const FIELDS = ['name', 'gender', 'birth_date', 'death_date', 'birthplace', 'residence', 'occupation', 'education', 'phone', 'avatar_url', 'bio', 'real_name', 'surname', 'generation'];

// 递归替换对象/数组中所有字符串值（保留 key 与结构）
function deepReplaceStrings(obj, from, to) {
  if (!from || from === to) return obj;
  if (typeof obj === 'string') return obj.split(from).join(to);
  if (Array.isArray(obj)) return obj.map((x) => deepReplaceStrings(x, from, to));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepReplaceStrings(v, from, to);
    return out;
  }
  return obj;
}

// 对一组人员做全量字符串替换：bio/nickname/profile_json/memoir_chapters/访谈消息
// 注意：name/surname 由调用方原有逻辑精确维护，这里不重复处理
function globalReplaceForPersons(personIds, from, to, currentUserId) {
  if (!from || from === to || !personIds || !personIds.length) return;
  const ids = Array.from(new Set(personIds)).filter((x) => x && Number(x) > 0);
  if (!ids.length) return;
  const like = '%' + from + '%';

  // 1) persons 静态字段 + profile_json
  for (const pid of ids) {
    try {
      const p = db.prepare('SELECT id, name, bio, nickname, profile_json FROM persons WHERE id = ?').get(pid);
      if (!p) continue;
      const sets = [];
      const vals = [];
      if (p.bio && p.bio.includes(from)) { sets.push('bio = ?'); vals.push(p.bio.split(from).join(to)); }
      if (p.nickname && p.nickname.includes(from)) { sets.push('nickname = ?'); vals.push(p.nickname.split(from).join(to)); }
      let prof = {};
      try { prof = JSON.parse(p.profile_json || '{}'); } catch (_) {}
      const savedCorrections = prof.corrections;
      delete prof.corrections; // 保护纠正映射本身不被污染
      prof = deepReplaceStrings(prof, from, to);
      if (savedCorrections) prof.corrections = savedCorrections;
      const newProf = JSON.stringify(prof);
      if (newProf !== (p.profile_json || '{}')) { sets.push('profile_json = ?'); vals.push(newProf); }
      if (sets.length) {
        sets.push("updated_at = datetime('now','localtime')");
        db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...vals, pid);
      }
    } catch (e) { console.error('[correct] profile replace', e.message); }
  }

  // 2) 回忆录章节（该人员及关联人员的章节）
  try {
    const inIds = ids.map(() => '?').join(',');
    db.prepare(`UPDATE memoir_chapters SET title = REPLACE(title, ?, ?), summary = REPLACE(summary, ?, ?), excerpt = REPLACE(excerpt, ?, ?) WHERE person_id IN (${inIds}) AND (title LIKE ? OR summary LIKE ? OR excerpt LIKE ?)`)
      .run(from, to, from, to, from, to, ...ids, like, like, like);
  } catch (e) { console.error('[correct] chapter replace', e.message); }

  // 3) 访谈消息：当前用户 + 这些人员的认领用户（全局纠音/纠字）
  try {
    const userIds = new Set([currentUserId]);
    for (const pid of ids) {
      const row = db.prepare('SELECT claimed_by_user_id FROM persons WHERE id = ?').get(pid);
      if (row && row.claimed_by_user_id) userIds.add(row.claimed_by_user_id);
    }
    const uids = Array.from(userIds).filter(Boolean);
    if (uids.length) {
      const inUids = uids.map(() => '?').join(',');
      db.prepare(`UPDATE messages SET content = REPLACE(content, ?, ?) WHERE interview_id IN (SELECT id FROM interviews WHERE user_id IN (${inUids})) AND content LIKE ?`)
        .run(from, to, like);
    }
  } catch (e) { console.error('[correct] messages replace', e.message); }
}

router.use(authMiddleware);

// 详情读取的列集合。
// 🔴 2026-09-14 修复「✏️ 编辑资料保存后还是原样」：
//   此前这里是硬写的短列清单，漏了 birthplace/residence/occupation/education/phone/avatar_url。
//   写入侧 FIELDS 允许写这些列（数据库确实写进去了），但 GET 回来永远是 undefined，
//   前端渲染成空白 → 用户以为"没保存"（数据其实在库里）。
//   🔑 铁律：读列集合必须与写白名单同源 —— 能写就必须能读，故直接展开 FIELDS。
const INFO_COLS = [
  'id', 'nickname', 'status', 'visibility', 'claimed_by_user_id', 'founder_user_id',
  'source_user_id', 'source_interview_id', 'profile_json', 'created_at', 'updated_at',
  ...FIELDS,
];

function personInfo(pid) {
  return db.prepare(`SELECT ${INFO_COLS.join(', ')} FROM persons WHERE id = ? AND status != 'deleted'`).get(pid);
}

// 关系列表（含对方节点的姓名/状态/是否已认领）：
// 前端据此渲染关系 chip 及「待本人自述」灰态徽标。
// 注：此前只回传 from/to 的 id，前端 person.js 期望 r.id/r.name/r.status → 渲染成 undefined，此处补齐。
function relationsOf(pid) {
  const rows = db.prepare(`
    SELECT r.id AS edge_id, r.from_person_id, r.to_person_id, r.type, r.note,
           p.id, p.name, p.nickname, p.gender, p.status, p.claimed_by_user_id
    FROM relationships r
    JOIN persons p ON (
      (r.from_person_id = ? AND p.id = r.to_person_id)
      OR (r.to_person_id = ? AND p.id = r.from_person_id)
    )
    WHERE r.status = 'active' AND p.status != 'deleted'
    ORDER BY r.type, p.name
  `).all(pid, pid);
  return rows.map((r) => ({
    edge_id: r.edge_id,
    from_person_id: r.from_person_id,
    to_person_id: r.to_person_id,
    type: r.type,
    note: r.note,
    id: r.id,
    name: r.name,
    nickname: r.nickname,
    gender: r.gender,
    status: r.status,
    claimed: !!r.claimed_by_user_id,
    claimed_by_user_id: r.claimed_by_user_id,
  }));
}

// 「等待加入」节点的来源人姓名（谁在访谈中提及了 TA），用于展示"由 李烨 在访谈中提及"
function sourceUserName(sourceUserId) {
  if (!sourceUserId) return '';
  try {
    const u = db.prepare('SELECT real_name, nickname FROM users WHERE id = ?').get(sourceUserId);
    return (u && (u.real_name || u.nickname)) || '';
  } catch (_) { return ''; }
}

// 是否有权读/写某人节点（授权门禁 B_X）
// 本人认领的 → 完全可写；否则需 relay_requests 已批准，或仅读 stub（公开可见的结构）。
function canWrite(pid, uid) {
  const p = personInfo(pid);
  if (!p) return { ok: false, reason: 'not found' };
  if (p.claimed_by_user_id === uid) return { ok: true, self: true };
  // 建档人（在访谈中录入该节点的人）可维护自己录入的节点资料。
  // 说明：这是"录入者维护"，不等于"代写他人传记"——relay 授权仍另走 relay_requests。
  if (p.founder_user_id === uid) return { ok: true, founder: true };
  const granted = db.prepare("SELECT id FROM relay_requests WHERE requester_user_id = ? AND target_person_id = ? AND status = 'approved'").get(uid, pid);
  if (granted) return { ok: true, self: false };
  return { ok: false, reason: '需要获得本人的授权才能记录 TA 的生平' };
}

// 列表（全部非 deleted，按 id）
router.get('/', (req, res) => {
  const rows = db.prepare("SELECT id, name, real_name, gender, birth_date, status, visibility, claimed_by_user_id, generation FROM persons WHERE status != 'deleted' ORDER BY id").all();
  res.json({ persons: rows });
});

// 详情
router.get('/:id', (req, res) => {
  const id = +req.params.id;
  const p = personInfo(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const isSelf = p.claimed_by_user_id === req.user.id;
  // 他人未授权 → 只读结构（名字+关系），不暴露生平 bio
  const granted = db.prepare("SELECT id FROM relay_requests WHERE requester_user_id = ? AND target_person_id = ? AND status = 'approved'").get(req.user.id, id);
  if (!isSelf && !granted && p.visibility !== 'public') {
    return res.json({
      person: {
        id: p.id, name: p.name, gender: p.gender, status: p.status, generation: p.generation,
        // 2026-09-13：补回 real_name —— 与完整分支保持同一个「展示名」来源（前端统一用 real_name || name）。
        // 此前受限分支只给 name，一旦 name 被脏数据污染，受限视角就会显示错名（姓名本身就是可见信息，
        // 回传 real_name 不扩大权限面）。仍不返回 bio/profile，写权限也不放开。
        real_name: p.real_name,
        claimed_by_user_id: p.claimed_by_user_id, claimed: !!p.claimed_by_user_id,
        source_user_id: p.source_user_id, source_user_name: sourceUserName(p.source_user_id),
      },
      relations: relationsOf(id),
      media: [],
      restricted: true,
      needsAuth: true,
    });
  }
  let profile = {};
  try { profile = JSON.parse(p.profile_json || '{}'); } catch (_) { profile = {}; }
  const media = db.prepare("SELECT * FROM media WHERE person_id = ? AND status != 'deleted' ORDER BY id").all(id);
  // profile_json 是原始字符串，已解析成 profile 返回，不再原样重复下发（避免两处真值）
  const personOut = { ...p, profile, claimed: !!p.claimed_by_user_id, source_user_name: sourceUserName(p.source_user_id) };
  delete personOut.profile_json;
  res.json({
    person: personOut,
    relations: relationsOf(id),
    media,
    restricted: false,
  });
});

// 创建 / 更新
router.post('/', (req, res) => {
  const b = req.body || {};
  if (b.id) {
    return updatePerson(Number(b.id), b, req, res);
  }
  // 新建：默认 active；若指定 relay 他人且未授权则只允许 stub
  const info = db.prepare(
    `INSERT INTO persons(name, gender, birth_date, death_date, birthplace, residence, occupation, education, phone, avatar_url, bio, profile_json, real_name, surname, generation, status, founder_user_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.name || '未命名', b.gender || '', b.birth_date || '', b.death_date || '', b.birthplace || '',
    b.residence || '', b.occupation || '', b.education || '', b.phone || '', b.avatar_url || '',
    b.bio || '', JSON.stringify(b.profile || {}), b.real_name || '', b.surname || ((b.name || '')[0] || ''), b.generation || 0,
    b.status || 'active', req.user.id
  );
  res.json(db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(info.lastInsertRowId)));
});

// 显式按 id 更新（前端 lifebook 补录用 POST /persons/:id）
router.post('/:id', (req, res) => {
  return updatePerson(Number(req.params.id), req.body || {}, req, res);
});

function updatePerson(id, b, req, res) {
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const w = canWrite(p.id, req.user.id);
  if (!w.ok) return res.status(403).json({ error: w.reason });
  const sets = []; const vals = [];
  for (const k of FIELDS) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  }
  // 配偶 / 民族没有独立列，落在 profile_json 里（对应前端「✏️ 编辑资料」的 spouse_name / ethnicity）。
  // 🔴 2026-09-14：此前 updatePerson 只认 FIELDS，这两个字段被静默丢弃 —— 编辑框里填了也白填。
  // ⚠️ 必须与既有 profile_json **合并**，绝不能整块覆盖：否则会把访谈沉淀的
  //    爱好/团体/走过的城市/人生事件/履历（hobbies/organizations/places/life_events/career）一起抹掉。
  const PROFILE_ALIAS = { spouse_name: 'spouse', ethnicity: 'ethnicity' };
  const incomingProfile = (b.profile && typeof b.profile === 'object') ? { ...b.profile } : {};
  for (const [k, pk] of Object.entries(PROFILE_ALIAS)) {
    if (b[k] !== undefined) incomingProfile[pk] = b[k];
  }
  if (Object.keys(incomingProfile).length) {
    let cur = {};
    try { cur = JSON.parse(p.profile_json || '{}'); } catch (_) { cur = {}; }
    sets.push('profile_json = ?');
    vals.push(JSON.stringify({ ...cur, ...incomingProfile }));
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now','localtime')");
    db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  return res.json(db.prepare('SELECT * FROM persons WHERE id = ?').get(id));
}

// 补充一段经历（A 任务）：把用户手写的生平片段交给 AI 整理成一章回忆录。
// 与「编辑资料」互补——后者改静态档案，这个真正"补一段故事"。
// 复用 summarizeChapter（含质量硬闸门：章内复述/臆造年份/失控长度），不合格自动重写一次。
router.post('/:id/experience', async (req, res) => {
  const pid = +req.params.id;
  if (!Number.isFinite(pid)) return res.status(400).json({ error: '参数错误' });
  const person = db.prepare("SELECT * FROM persons WHERE id = ? AND status != 'deleted'").get(pid);
  if (!person) return res.status(404).json({ error: '人物不存在' });
  const w = canWrite(person.id, req.user.id);
  if (!w.ok) return res.status(403).json({ error: w.reason });
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  if (!text) return res.status(400).json({ error: '请先写点内容' });
  if (text.length > 2000) return res.status(400).json({ error: '单次内容太长（上限 2000 字）' });

  const messages = [{ role: 'user', content: text }];
  // 注意：补充经历是用户「主动写一段新记忆」，不传 existingTitles（关闭跨章去重规则 #9）。
  // 否则 hy3 会把它误判为「已被现有章节覆盖」而把 summary 清空，反而丢内容。
  let ch;
  try {
    ch = await llm.summarizeChapter(messages, '', { allowFallback: false, timeoutMs: 180000 });
  } catch (e) {
    console.error('[experience] summarize 失败：', e.message);
    return res.status(502).json({ error: '整理失败，请稍后重试' });
  }
  // 🔒 空正文保护：AI 偶尔会对「素材过短」的输入返回空 summary（宁可写短也不准空）。
  // 这种情况下绝不落库成一张空白章节——明确提示用户补充细节，比留一张空章更有用。
  if (!ch.summary || !ch.summary.trim()) {
    return res.status(422).json({ error: '这段内容暂时没能整理成回忆录正文。请再补充一两句细节（如大概时间、在哪里、当时心情）后重试。' });
  }
  // 质量闸门：不合格带违规原因重写一次，仍不优则取较优稿
  let probs = llm.validateChapter(ch.summary || '', [text]);
  if (probs.length) {
    console.warn('[experience] 首稿未过闸门：', probs.join('；'), '→ 重写一次');
    try {
      const retry = await llm.summarizeChapter(messages, '上一稿被退回，原因：' + probs.join('；') + '。请据此重写，严格遵守"禁止复述/一章一主题/不臆造"。', { allowFallback: false, timeoutMs: 180000 });
      const probs2 = llm.validateChapter(retry.summary || '', [text]);
      if (!probs2.length || probs2.length < probs.length) ch = retry;
    } catch (_) {}
  }
  const stage = llm.inferStage({}, [text]);
  ch.stage = stage || ch.stage || 'life';
  ch.year = Number.isFinite(ch.year) ? ch.year : null;
  const chapter = iv.upsertChapter(pid, ch);
  if (!chapter) return res.status(400).json({ error: '内容不足，未能生成章节' });
  invalidateGraphCache();
  res.json({ ok: true, chapter });
});

// 删除（本人或创始人）
router.post('/:id/delete', (req, res) => {
  const id = +req.params.id;
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.claimed_by_user_id !== req.user.id && p.founder_user_id !== req.user.id) {
    return res.status(403).json({ error: '无权删除' });
  }
  db.prepare("UPDATE persons SET status = 'deleted', updated_at = datetime('now','localtime') WHERE id = ?").run(id);
  db.prepare("UPDATE relationships SET status = 'deleted' WHERE from_person_id = ? OR to_person_id = ?").run(id, id);
  // 媒体软删（与其余实体一致，便于恢复/审计），不物理抹除
  db.prepare("UPDATE media SET status = 'deleted' WHERE person_id = ? AND status != 'deleted'").run(id);
  invalidateGraphCache();
  res.json({ ok: true });
});

// 建立关系边（访谈抽取后写入；带 source=本人）
router.post('/:id/relate', (req, res) => {
  const id = +req.params.id;
  const b = req.body || {};
  const otherId = +b.to_person_id;
  const type = b.type; // 'parent' | 'spouse'
  if (!otherId || !['parent', 'spouse'].includes(type)) return res.status(400).json({ error: '参数错误' });
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  const o = db.prepare('SELECT * FROM persons WHERE id = ?').get(otherId);
  if (!p || !o) return res.status(404).json({ error: '人物不存在' });
  // 鉴权：建关系边属于"记录 TA 的生平"，对「起点或终点任一人物」有写权限即可
  // （例：为自己的节点添加父母时，用户对父节点无权限、但对自己节点有）
  const w = canWrite(id, req.user.id).ok ? canWrite(id, req.user.id) : canWrite(otherId, req.user.id);
  if (!w.ok) return res.status(403).json({ error: w.reason });
  // 去重：同 from/to/type 已存在则忽略
  const exists = db.prepare('SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ? AND status != \'deleted\'').get(id, otherId, type);
  if (exists) return res.json({ ok: true, existed: true });
  db.prepare('INSERT INTO relationships(from_person_id, to_person_id, type, source, confidence) VALUES(?, ?, ?, ?, ?)')
    .run(id, otherId, type, req.user.id, 1.0);
  // 阶段3：新建关系后，对两个端点各自扫描全库同名+同角色候选
  const detect = getDetect();
  if (detect) {
    try {
      detect(id, req.user.id);
      detect(otherId, req.user.id);
    } catch (e) { console.error('[merge detect]', e.message); }
  }
  res.json({ ok: true });
});

// 代录授权：请求
router.post('/:id/request-relay', (req, res) => {
  const id = +req.params.id;
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.claimed_by_user_id === req.user.id) return res.status(400).json({ error: '这是你自己的节点，无需授权' });
  const { reason = '' } = req.body || {};
  // 已存在 pending/approved 则不重复
  const ex = db.prepare('SELECT id, status FROM relay_requests WHERE requester_user_id = ? AND target_person_id = ?').get(req.user.id, id);
  if (ex) return res.json({ ok: true, status: ex.status, existed: true });
  db.prepare('INSERT INTO relay_requests(requester_user_id, target_person_id, reason, status) VALUES(?, ?, ?, \'pending\')')
    .run(req.user.id, id, reason);
  res.json({ ok: true, status: 'pending' });
});

// 代录授权：本人审批列表
router.get('/relay/inbox', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.requester_user_id, r.target_person_id, r.reason, r.status, r.created_at,
           u.real_name AS requester_name, p.name AS target_name
    FROM relay_requests r
    JOIN users u ON u.id = r.requester_user_id
    JOIN persons p ON p.id = r.target_person_id
    WHERE p.claimed_by_user_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all(req.user.id);
  res.json({ requests: rows });
});

// 代录授权：本人审批
router.post('/relay/:rid/review', (req, res) => {
  const rid = +req.params.rid;
  const { action } = req.body || {}; // 'approve' | 'reject'
  const r = db.prepare('SELECT * FROM relay_requests WHERE id = ?').get(rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(r.target_person_id);
  if (!p || p.claimed_by_user_id !== req.user.id) return res.status(403).json({ error: '无权审批' });
  db.prepare("UPDATE relay_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?")
    .run(action === 'approve' ? 'approved' : 'rejected', req.user.id, rid);
  res.json({ ok: true, status: action === 'approve' ? 'approved' : 'rejected' });
});

// ===== 字段更正（访谈中用户纠正 AI 抓错的名字/时间等）=====
// PATCH /api/persons/:id/correct
// body: { field, oldValue, newValue }
//   field 形如：
//     'name' / 'birth_date' / 'birthplace' / 'residence' / 'gender' / 'occupation' / 'education' / 'death_date'  → 直接改 persons 表该列
//     'relation.<relId>.name'  → 改某个关系节点（relId 为 persons.id）的 name（会话内追加的关系人改名）
// 返回 { field, oldValue, newValue }，前端据此遍历会话 DOM 把旧值就地换成新值（B 类气泡改写）。
router.patch('/:id/correct', (req, res) => {
  const id = +req.params.id;
  const p = db.prepare('SELECT * FROM persons WHERE id = ? AND status != \'deleted\'').get(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const w = canWrite(id, req.user.id);
  if (!w.ok) return res.status(403).json({ error: w.reason });
  const { field, oldValue, newValue } = req.body || {};
  if (!field || newValue === undefined || newValue === null) {
    return res.status(400).json({ error: '缺少 field 或 newValue' });
  }
  const nv = String(newValue).trim();

  // 便捷分支：bulk_replace —— 前端气泡"全局改人名"时调用：
  // 把本人 name（若等于 oldValue）以及所有与该人直接关联节点的 name（若等于 oldValue）统一改成 newValue。
  // 注意：本接口【不】改写 covered_fields——关系线的"已采集"标记由访谈引擎 applyExtraction/applyReview
  // 在正常聊天流里以 `relation.<relType>.name` 格式维护，bulk_replace 只是纠错拼写，避免污染 covered 格式。
  // 返回所有被改的关联节点 id 供前端 DOM 替换参考。
  if (field === 'bulk_replace') {
    const ov = String(oldValue || '').trim();
    if (!ov) return res.status(400).json({ error: '缺少 oldValue' });
    const changed = [];
    const changedRelIds = [];
    // 本人
    if (p.name && p.name.trim() === ov) {
      db.prepare('UPDATE persons SET name = ?, surname = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(nv, (nv[0] || ''), id);
      changed.push('name');
    }
    // 关联节点（直接关系边）
    const rels = db.prepare('SELECT from_person_id, to_person_id FROM relationships WHERE (from_person_id = ? OR to_person_id = ?) AND status != \'deleted\'').all(id, id);
    const relIds = new Set();
    rels.forEach((r) => { relIds.add(r.from_person_id); relIds.add(r.to_person_id); });
    relIds.delete(id);
    relIds.forEach((rid) => {
      const rp = db.prepare('SELECT id, name FROM persons WHERE id = ? AND status != \'deleted\'').get(rid);
      if (rp && rp.name && rp.name.trim() === ov) {
        db.prepare('UPDATE persons SET name = ?, surname = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(nv, (nv[0] || ''), rid);
        changed.push('relation.' + rid + '.name');
        changedRelIds.push(rid);
      }
    });
    // 【关键修复】全局替换：把旧词从这个节点及其关联节点的 bio/nickname/profile_json/章节/消息里全部清掉。
    // 仅替换文本内容，不动其他人员数据；消息层覆盖当前用户 + 关联节点的认领用户。
    globalReplaceForPersons([id, ...changedRelIds], ov, nv, req.user.id);

    // 【关键修复】持久化纠正映射，注入后续 LLM 系统提示，彻底避免模型忘性导致再次用旧词。
    // 必须从数据库重新读取最新 profile_json（globalReplaceForPersons 可能已更新它）。
    try {
      const latest = db.prepare('SELECT profile_json FROM persons WHERE id = ?').get(id);
      const prof = {};
      try { Object.assign(prof, JSON.parse((latest && latest.profile_json) || '{}')); } catch (_) {}
      prof.corrections = Array.isArray(prof.corrections) ? prof.corrections : [];
      prof.corrections.push({ from: ov, to: nv });
      if (prof.corrections.length > 40) prof.corrections = prof.corrections.slice(-40);
      db.prepare('UPDATE persons SET profile_json = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(JSON.stringify(prof), id);
    } catch (_) {}
    invalidateGraphCache();
    return res.json({ field: 'bulk_replace', oldValue: ov, newValue: nv, changed, changedRelIds });
  }

  const reqOld = String(oldValue || '').trim();
  let realOld = '';
  const affectedIds = [id];
  if (field.startsWith('relation.')) {
    // relation.<relPersonId>.name
    const m = field.match(/^relation\.(\d+)\.name$/);
    if (!m) return res.status(400).json({ error: '不支持的关系字段' });
    const relId = Number(m[1]);
    affectedIds.push(relId);
    const rel = db.prepare('SELECT * FROM persons WHERE id = ? AND status != \'deleted\'').get(relId);
    if (!rel) return res.status(404).json({ error: '关系节点不存在' });
    // 改名：同时更新 name 与 surname（首字）
    realOld = rel.name || '';
    db.prepare('UPDATE persons SET name = ?, surname = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(nv, (nv[0] || ''), relId);
    invalidateGraphCache();
  } else if (FIELDS.includes(field)) {
    realOld = p[field] || '';
    db.prepare(`UPDATE persons SET ${field} = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(nv, id);
  } else if (field === 'real_name') {
    realOld = p.real_name || '';
    db.prepare('UPDATE persons SET real_name = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(nv, id);
  } else {
    return res.status(400).json({ error: '不支持的字段：' + field });
  }
  // 【关键修复】全局替换：以用户输入的 oldValue 为锚，把旧词从受影响节点的 bio/nickname/profile_json/章节/消息里全部清掉。
  // 不能用 realOld（例如 bio 字段的 realOld 是整句话），否则无法命中片段。
  const replaceFrom = reqOld || realOld;
  if (replaceFrom) {
    globalReplaceForPersons(affectedIds, replaceFrom, nv, req.user.id);
  }
  // 持久化纠正映射（注入后续 LLM，避免模型忘性再次用旧词）
  if (replaceFrom) {
    try {
      const latest = db.prepare('SELECT profile_json FROM persons WHERE id = ?').get(id);
      const prof = {};
      try { Object.assign(prof, JSON.parse((latest && latest.profile_json) || '{}')); } catch (_) {}
      prof.corrections = Array.isArray(prof.corrections) ? prof.corrections : [];
      prof.corrections.push({ from: replaceFrom, to: nv });
      if (prof.corrections.length > 40) prof.corrections = prof.corrections.slice(-40);
      db.prepare('UPDATE persons SET profile_json = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(JSON.stringify(prof), id);
    } catch (_) {}
  }
  // 更正后把该字段标记为已覆盖（避免后续重复问），并清除旧值对应的「已确认」歧义
  try {
    const arr = db.getCoveredFields(id);
    if (!arr.includes(field)) { arr.push(field); db.addCoveredFields(id, [field]); }
  } catch (_) {}
  res.json({ field, oldValue: realOld, newValue: nv });
});

// ===== 节点认领邀请（全局图模型：锚定 persons 节点，无 tree 维度）=====
// POST /api/persons/:id/invite → 为待认领节点生成专属 token，返回认领链接
router.post('/:id/invite', (req, res) => {
  const crypto = require('crypto');
  const id = +req.params.id;
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  if (!p || p.status === 'deleted') return res.status(404).json({ error: '节点不存在' });
  if (p.claimed_by_user_id) return res.status(409).json({ error: '该节点已被认领' });
  // 鉴权：本人可写（认领/已授权）或节点创始人，才可发出认领邀请
  const w = canWrite(id, req.user.id);
  const isFounder = p.founder_user_id === req.user.id;
  if (!w.ok && !isFounder) return res.status(403).json({ error: '无权为该节点生成认领邀请' });
  const token = crypto.randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    'INSERT INTO invitations(node_id, token, created_by, status, expires_at) VALUES(?, ?, ?, ?, ?)'
  ).run(id, token, req.user.id, 'pending', expires);
  res.json({ token, link: '/claim.html?token=' + token, node: { id: p.id, name: p.name } });
});

// ===== 老谱补录（决策5）：向上追溯补录祖先 =====
// POST /api/persons/:id/ancestor → 为 id 补录一位祖先（stub 节点 + parent 边，待本人自述）
router.post('/:id/ancestor', (req, res) => {
  const id = +req.params.id;
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  if (!p || p.status === 'deleted') return res.status(404).json({ error: '节点不存在' });
  const w = canWrite(id, req.user.id);
  const isFounder = p.founder_user_id === req.user.id;
  if (!w.ok && !isFounder) return res.status(403).json({ error: w.reason || '无权补录' });
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: '祖先姓名必填' });
  const surname = (b.surname || '').trim() || name[0] || '';
  const info = db.prepare(
    `INSERT INTO persons(name, gender, birth_date, death_date, birthplace, surname, generation, status, founder_user_id, source_user_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(name, b.gender || '', b.birth_date || '', b.death_date || '', b.birthplace || '', surname,
    (p.generation || 0) - 1, 'stub', req.user.id, req.user.id);
  const ancId = Number(info.lastInsertRowid);
  // parent 边方向：from=父母，to=子女
  const exists = db.prepare("SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = 'parent' AND status = 'active'").get(ancId, id);
  if (!exists) {
    db.prepare("INSERT INTO relationships(from_person_id, to_person_id, type, note, source) VALUES(?, ?, 'parent', ?, ?)")
      .run(ancId, id, '老谱补录', req.user.id);
  }
  invalidateGraphCache();
  res.json({ ok: true, ancestor_id: ancId });
});

// GET /api/persons/:id/ancestors → 沿 parent 边向上列出祖先（含补录的 stub 节点）
router.get('/:id/ancestors', (req, res) => {
  const id = +req.params.id;
  const p = personInfo(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const seen = new Set([id]);
  const ancestors = [];
  let frontier = [id];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.surname, p.gender, p.birth_date, p.death_date, p.status
      FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id IN (${frontier.map(() => '?').join(',')}) AND r.type = 'parent'
        AND r.status = 'active' AND p.status != 'deleted'
      ORDER BY p.id
    `).all(...frontier);
    const next = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      ancestors.push({ ...r, depth: depth + 1 });
      next.push(r.id);
    }
    frontier = next;
  }
  res.json({ ancestors });
});

// ===== 人物线：列出与 id 相关的所有重要人物（亲属 + 重要他人）=====
// 用于前端「人物线」视图，按人物聚合回忆入口。
// 亲属（parent/spouse/sibling）会出现在家谱中；非亲属熟人（acquaintance）只在人物线展示。
router.get('/:id/figures', (req, res) => {
  const id = +req.params.id;
  const p = personInfo(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare(`
    SELECT r.id AS edge_id, r.from_person_id, r.to_person_id, r.type, r.note,
           p.id, p.name, p.nickname, p.gender, p.status, p.claimed_by_user_id
    FROM relationships r
    JOIN persons p ON (
      (r.from_person_id = ? AND p.id = r.to_person_id)
      OR (r.to_person_id = ? AND p.id = r.from_person_id)
    )
    WHERE r.status = 'active' AND p.status != 'deleted'
    ORDER BY r.type, p.name
  `).all(id, id);

  const REL_LABELS = {
    father: '父亲', mother: '母亲', spouse: '配偶',
    son: '儿子', daughter: '女儿', child: '子女',
    brother: '兄弟', sister: '姐妹', sibling: '兄弟姐妹',
    grandfather: '祖父', grandmother: '祖母',
    'maternal-grandfather': '外祖父', 'maternal-grandmother': '外祖母',
    friend: '朋友', colleague: '同事', teacher: '师长', neighbor: '邻居', other: '他人',
  };
  const FAMILY_TYPES = new Set(['parent', 'spouse', 'sibling']);

  function inferRel(r) {
    const otherGender = r.gender || '';
    if (r.type === 'parent') {
      if (r.from_person_id === id) {
        return otherGender === '女' ? 'daughter' : (otherGender === '男' ? 'son' : 'child');
      }
      return otherGender === '女' ? 'mother' : (otherGender === '男' ? 'father' : 'parent');
    }
    if (r.type === 'spouse') return 'spouse';
    if (r.type === 'sibling') {
      return otherGender === '女' ? 'sister' : (otherGender === '男' ? 'brother' : 'sibling');
    }
    // acquaintance：优先用 note 里存的具体关系类型，否则 'other'
    const note = (r.note || '').trim();
    if (note && REL_LABELS[note]) return note;
    return 'other';
  }

  const seen = new Map(); // personId -> figure
  for (const r of rows) {
    const rel = inferRel(r);
    const existing = seen.get(r.id);
    if (existing) {
      if (!existing.rels.includes(rel)) existing.rels.push(rel);
      // 任一边是亲属类型即算亲属（修复：冗余 acquaintance 边字母序先于 parent 时误判非亲属）
      if (FAMILY_TYPES.has(r.type)) {
        existing.is_family = true;
        if (!existing.familyRel) existing.familyRel = rel;
      }
      continue;
    }
    seen.set(r.id, {
      person: {
        id: r.id,
        name: r.name,
        nickname: r.nickname,
        gender: r.gender,
        status: r.status,
        claimed_by_user_id: r.claimed_by_user_id,
      },
      rels: [rel],
      edge_type: r.type,
      is_family: FAMILY_TYPES.has(r.type),
      familyRel: FAMILY_TYPES.has(r.type) ? rel : null,
    });
  }

  const figures = Array.from(seen.values()).map((f) => {
    // 优先用家族关系标签（如 父亲），避免冗余 acquaintance 边把亲属标成「他人 / 父亲」
    const primaryRel = f.familyRel || f.rels[0];
    return {
      ...f,
      rel: primaryRel,
      rel_label: (f.is_family ? [primaryRel] : f.rels).map((x) => REL_LABELS[x] || x).join(' / '),
    };
  });

  res.json({ figures });
});

module.exports = router;
