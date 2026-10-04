// server/src/interview.js
// 赛博传记 — 访谈会话引擎（全局关系图模型，无 tree 维度）
// 双轨：前台叙事对话流（倾听者风格） + 后台静默抽取（建人/连边/去重）
// 阶段4（2026-08-24）：废除 tree_id，人物节点全局共享，关系网自然涌现；
// 开场必问「上三（父母/祖父母/外祖父母）+ 下三（子女/孙）+ 兄弟姐妹」，
// 用户提到的亲属自动抽成 stub 节点并连轻量关系边（不追问亲属生平）。
const db = require('./db');
const { runInterview, summarizeChapter, extendChapter, relLabel, inferStage, isSelfStory, STAGE_TITLE } = require('./llm');
const { getLLMConfig } = require('./config');
const { sanitizeExtract, sanitizeFacts } = require('./ingest-guard');

// 老库兜底：确保 memoir_chapters 含 stage / chapter_kind 列
let colsEnsured = false;
function ensureChapterColumns() {
  if (colsEnsured) return;
  colsEnsured = true;
  for (const col of ['chapter_kind TEXT DEFAULT \'summary\'', 'stage TEXT DEFAULT \'life\'', 'year INTEGER DEFAULT NULL']) {
    try { db.prepare(`ALTER TABLE memoir_chapters ADD COLUMN ${col}`).run(); }
    catch (_) { /* 已存在则忽略 */ }
  }
}
ensureChapterColumns();

// 全局图缓存：persons/relationships 改动后失效，避免每轮消息重算全图 BFS
let _graphCache = null;
function invalidateGraphCache() { _graphCache = null; }

const PERSON_FILLABLE = [
  'name', 'nickname', 'gender', 'birth_date', 'death_date',
  'birthplace', 'residence', 'occupation', 'education', 'bio',
];

function getPerson(id) {
  return db.prepare("SELECT * FROM persons WHERE id = ? AND status != 'deleted'").get(id);
}

// 全局图：按姓名或昵称找人（昵称是注册/访谈中记下的别名，身份匹配即可视为同一人）
function findPersonByName(name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM persons WHERE (name = ? OR nickname = ?) AND status != ? ORDER BY id LIMIT 1').get(name, name, 'deleted');
}

// 按姓名/昵称精确匹配（全局），用于"别人提到已存在的昵称"时链接到既有节点
function findPersonByAlias(alias) {
  if (!alias) return null;
  const n = normAlias(alias);
  if (n.length < 2) return null;
  return db.prepare('SELECT * FROM persons WHERE (name = ? OR nickname = ?) AND status != ? ORDER BY id LIMIT 1').get(alias, alias, 'deleted');
}

// 规范化别名：去首尾空格、去中间分隔点（·．.・）
function normAlias(s) {
  return (s || '').trim().replace(/[\s·．.・]/g, '');
}

// 读取本人节点的「纠正映射」（用户点改后持久化），用于在访谈中让模型统一用新名
function getCorrections(targetId) {
  if (!targetId) return [];
  try {
    const p = db.prepare('SELECT profile_json FROM persons WHERE id = ?').get(targetId);
    const prof = JSON.parse((p && p.profile_json) || '{}');
    return Array.isArray(prof.corrections) ? prof.corrections : [];
  } catch (_) { return []; }
}

// 把目标节点的纠正映射应用到一段文本/对象上，保证写入的新数据不会出现旧词
function correctText(text, targetId) {
  if (!text || !targetId) return text;
  const corrections = getCorrections(targetId);
  if (!corrections.length) return text;
  let s = String(text);
  for (const c of corrections) {
    if (c && c.from && c.from !== c.to) s = s.split(c.from).join(c.to);
  }
  return s;
}
function correctObject(obj, targetId) {
  if (!obj || !targetId) return obj;
  if (typeof obj === 'string') return correctText(obj, targetId);
  if (Array.isArray(obj)) return obj.map((x) => correctObject(x, targetId));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = correctObject(v, targetId);
    return out;
  }
  return obj;
}

// 关系角色对应的默认性别（用于候选集合裁剪）
function relCandidateGender(rel) {
  return (['father', 'son', 'grandfather', 'grandson', 'brother', 'maternal-grandfather'].includes(rel)) ? '男'
    : (['mother', 'daughter', 'grandmother', 'granddaughter', 'sister', 'maternal-grandmother'].includes(rel)) ? '女' : '';
}

// 收集与本人有「正确关系角色」的候选人物（用于昵称/姓名对齐，避免跨角色误并）
function findRelCandidates(targetId, rel) {
  if (!targetId) return [];
  const gender = relCandidateGender(rel);
  if (isDirectRel(rel)) {
    if (['father', 'mother', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother'].includes(rel)) {
      return db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id WHERE r.to_person_id = ? AND r.type='parent' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)`).all(targetId, gender);
    }
    if (['son', 'daughter', 'grandson', 'granddaughter'].includes(rel)) {
      return db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id WHERE r.from_person_id = ? AND r.type='parent' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)`).all(targetId, gender);
    }
    // 兄弟姐妹：与本人直接有 sibling 边（双向）；UNION 去重避免同一人出现两次
    return db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id WHERE r.to_person_id = ? AND r.type='sibling' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)
      UNION
      SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id WHERE r.from_person_id = ? AND r.type='sibling' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)`).all(targetId, gender, targetId, gender);
  }
  if (rel === 'spouse') {
    return db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id WHERE r.to_person_id = ? AND r.type='spouse' AND r.status='active' AND p.status != 'deleted' UNION ALL SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id WHERE r.from_person_id = ? AND r.type='spouse' AND r.status='active' AND p.status != 'deleted'`).all(targetId, targetId);
  }
  return [];
}

// 关系人对齐：在「正确关系角色」的候选中，按 姓名/昵称 精确或包含匹配找到既有节点；
// 找不到再退到全局 姓名/昵称 精确匹配（覆盖"注册昵称被他人提及"等跨角色情形）。
// 身份(关系角色)匹配是前提，绝不做跨角色合并。
// 补充：若该关系角色下【只有一个】候选（如只有一个哥哥），用户换了个叫法（昵称/别名）提到 TA，
// 只要名字无重叠冲突，视为同一人（"只要身份匹配就可以对上"），把新叫法补成昵称并链接。
function findRelMatch(targetId, rel, name) {
  const n = normAlias(name);
  if (n.length < 2) return null;
  const cands = findRelCandidates(targetId, rel);
  // 1) 精确/包含匹配（姓名或昵称）
  for (const p of cands) {
    const pn = normAlias(p.name);
    const pk = normAlias(p.nickname);
    if (pn === n || pk === n || pn.includes(n) || n.includes(pn) || (pk && (pk.includes(n) || n.includes(pk)))) return p;
  }
  // 2) 身份匹配：该关系角色下只有一个候选，且新叫法与既有名字无重叠冲突 → 同一人
  if (cands.length === 1) {
    const only = cands[0];
    const pn = normAlias(only.name);
    const pk = normAlias(only.nickname);
    const conflict = pn && (pn.includes(n) || n.includes(pn) || pn === n);
    const nickConflict = pk && (pk.includes(n) || n.includes(pk) || pk === n);
    if (!conflict && !nickConflict) return only;
  }
  // 3) 全局 姓名/昵称 精确匹配（注册昵称等跨角色情形）
  const g = findPersonByAlias(name);
  if (g) return g;
  return null;
}

// 把抽到的称呼(incoming)与既有节点(person)做昵称/真名调和：
// - 同一人既可能先被叫昵称、后被叫真名，也可能反过来。
// - 规则：incoming 更长 → 视为真名，旧短名降级为昵称；incoming 更短 → 视为昵称，补进 nickname。
// 返回更新后的 person（或原样）。
function reconcilePersonAlias(person, incoming) {
  if (!person) return person;
  const curName = (person.name || '').trim();
  const curNick = (person.nickname || '').trim();
  const inc = (incoming || '').trim();
  if (!inc || inc === curName) {
    if (inc && !curNick) {
      db.prepare("UPDATE persons SET nickname = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(inc, person.id);
      return getPerson(person.id);
    }
    return person;
  }
  const updates = [];
  const vals = [];
  const incomingIsReal = inc.length >= curName.length && curName.length > 0;
  if (incomingIsReal) {
    if (!curNick) { updates.push('nickname = ?'); vals.push(curName); }
    updates.push('name = ?'); vals.push(inc);
  } else {
    if (!curNick || curNick === curName) { updates.push('nickname = ?'); vals.push(inc); }
  }
  if (updates.length) {
    updates.push("updated_at = datetime('now','localtime')");
    db.prepare('UPDATE persons SET ' + updates.join(', ') + ' WHERE id = ?').run(...vals, person.id);
    return getPerson(person.id);
  }
  return person;
}

// 列出与本人（userId 认领节点）相关的已知人物，用于抽取层去重提示
function listKnownPersons(selfId) {
  if (!selfId) return [];
  // 仅列出与本人直接/间接相连的其他人物（沿关系边 2 跳内）。
  // 注意：刻意【不包含本人节点自身】——本人是谈话对象，不是"已知家族成员"，
  // 否则 LLM 会把本人真名误读成某个亲属（曾出现"你爸叫李烨"的幻觉）。
  const rows = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.nickname, p.gender, p.birth_date, p.status
    FROM persons p
    WHERE p.status != 'deleted'
      AND p.id != ?
      AND (
        p.id IN (SELECT to_person_id FROM relationships WHERE from_person_id = ? AND status='active')
        OR p.id IN (SELECT from_person_id FROM relationships WHERE to_person_id = ? AND status='active')
        OR p.id IN (SELECT to_person_id FROM relationships WHERE from_person_id IN (SELECT to_person_id FROM relationships WHERE from_person_id = ? AND status='active') AND status='active')
        OR p.id IN (SELECT from_person_id FROM relationships WHERE to_person_id IN (SELECT from_person_id FROM relationships WHERE to_person_id = ? AND status='active') AND status='active')
      )
  `).all(selfId, selfId, selfId, selfId, selfId);
  return rows;
}

// 仅填充空字段，避免覆盖已有信息；返回本轮实际新写入的字段名（用于前端回执）
function applyPersonFields(personId, data) {
  const p = getPerson(personId);
  if (!p) return [];
  const sets = [];
  const vals = [];
  const captured = [];
  for (const k of PERSON_FILLABLE) {
    if (data[k] !== undefined && data[k] !== '' && (p[k] === '' || p[k] == null)) {
      sets.push(`${k} = ?`);
      vals.push(correctText(data[k], personId));
      captured.push(k);
    }
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now','localtime')");
    db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...vals, personId);
  }
  if (data.profile && typeof data.profile === 'object') {
    let cur = {};
    try { cur = JSON.parse(p.profile_json || '{}'); } catch (_) { cur = {}; }
    const correctedProfile = correctObject(data.profile, personId);
    let changed = false;
    for (const [k, v] of Object.entries(correctedProfile)) {
      if (v && !(k in cur)) { cur[k] = v; changed = true; captured.push('profile.' + k); }
    }
    if (changed) {
      db.prepare("UPDATE persons SET profile_json = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(JSON.stringify(cur), personId);
    }
  }
  return captured;
}

// 把履历/团体/爱好/城市/事件等数组维度合并进 profile_json（不覆盖已有，按值去重）
function mergePersonProfile(personId, data) {
  const p = getPerson(personId);
  if (!p) return [];
  const captured = [];
  const arrKeys = ['career', 'organizations', 'hobbies', 'places', 'life_events'];
  let cur = {};
  try { cur = JSON.parse(p.profile_json || '{}'); } catch (_) { cur = {}; }
  let changed = false;
  for (const k of arrKeys) {
    if (Array.isArray(data[k]) && data[k].length) {
      const have = cur[k] || [];
      const haveKeys = new Set(have.map((x) => JSON.stringify(x)));
      const correctedArr = correctObject(data[k], personId);
      const incoming = k === 'career'
        ? correctedArr
        : correctedArr.map((v) => (typeof v === 'string' ? v : String(v)));
      const norm = k === 'career'
        ? incoming
        : incoming.map((v) => v.trim()).filter(Boolean);
      let added = 0;
      for (const item of norm) {
        const key = JSON.stringify(item);
        if (!haveKeys.has(key)) { have.push(item); haveKeys.add(key); added++; }
      }
      if (added) { cur[k] = have; changed = true; captured.push(k); }
    }
  }
  if (data.profile && typeof data.profile === 'object') {
    const correctedProfile = correctObject(data.profile, personId);
    for (const [k, v] of Object.entries(correctedProfile)) {
      if (v && !(k in cur)) { cur[k] = v; changed = true; captured.push('profile.' + k); }
    }
  }
  if (changed) {
    db.prepare("UPDATE persons SET profile_json = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(JSON.stringify(cur), personId);
  }
  return captured;
}

// 全局图：确保某姓名的人节点存在（默认轻量「待认领」节点 status='pending_claim'）。
// pending_claim = 访谈中提及、但本人尚未注册的亲属：先把家属网骨架立起来，
// 并记录来源（source_user_id=谁抽出的、source_interview_id=哪次访谈），
// 等该亲属真正上线注册后，由 auth.js 的 ensure-self 按真名/昵称自动认领联系起来。
// 昵称一并记录，便于后续对齐同一人（避免重复建节点）。
function ensurePerson(name, gender, status = 'pending_claim', nickname = '', sourceUserId = null, sourceInterviewId = null) {
  let p = findPersonByName(name) || findPersonByAlias(name);
  if (p) return { person: p, created: false };
  const info = db.prepare(
    'INSERT INTO persons(name, gender, status, nickname, source_user_id, source_interview_id) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(name, gender || '', status, nickname || name || '', sourceUserId || null, sourceInterviewId || null);
  return { person: getPerson(Number(info.lastInsertRowid)), created: true };
}

// 按亲属类型 + 目标节点，在 DB 中查找已存在的同 rel 节点（用于复查纠错时复用，避免双节点）
// 返回 { person, relId } 或 null
function findExistingRelNode(targetId, rel) {
  if (!targetId) return null;
  // 直亲关系（父/母/子/女/祖/孙）共用 type='parent' 边，无法在 relationships 表里区分父/母，
  // 若按 (to=target, type=parent) 查重会命中"父亲边"误当"母亲已存在"，导致母亲节点永不创建。
  // 故直亲关系不做跨边复用，完全依赖 ensurePerson(name) 的全局姓名查重来避免双节点
  // （父亲/母亲同名属极罕见血缘冲突，可接受合并）。仅配偶/兄弟姐妹走边查重。
  if (['father', 'mother', 'son', 'daughter', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother', 'grandson', 'granddaughter'].includes(rel)) {
    return null;
  }
  const REL_EDGE = {
    father: ['parent', 'from'], // 父亲节点 → 指向 target（from=父, to=target, type=parent）
    mother: ['parent', 'from'],
    grandfather: ['parent', 'from'], // 祖父 = 父亲的父亲（以父亲为跳板连）
    grandmother: ['parent', 'from'],
    'maternal-grandfather': ['parent', 'from'],
    'maternal-grandmother': ['parent', 'from'],
    son: ['parent', 'to'],      // 儿子节点 ← 由 target 指向（from=target, to=子, type=parent）
    daughter: ['parent', 'to'],
    grandson: ['parent', 'to'],
    granddaughter: ['parent', 'to'],
    spouse: ['spouse', 'either'],
    brother: ['sibling', 'either'],
    sister: ['sibling', 'either'],
  };
  const cfg = REL_EDGE[rel];
  if (!cfg) return null;
  const [type, dir] = cfg;
  let rows;
  if (dir === 'from') {
    rows = db.prepare(`SELECT p.*, r.id AS rel_id FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'`).all(targetId, type);
  } else if (dir === 'to') {
    rows = db.prepare(`SELECT p.*, r.id AS rel_id FROM relationships r JOIN persons p ON p.id = r.to_person_id
      WHERE r.from_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'`).all(targetId, type);
  } else if (type === 'spouse') {
    rows = db.prepare(`SELECT p.*, r.id AS rel_id FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'
      UNION ALL
      SELECT p.*, r.id AS rel_id FROM relationships r JOIN persons p ON p.id = r.to_person_id
      WHERE r.from_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'`).all(targetId, type, targetId, type);
  } else {
    // sibling：兄弟姐妹与本人直接有 sibling 边（双向）；UNION 去重
    rows = db.prepare(`SELECT p.*, r.id AS rel_id FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id = ? AND r.type='sibling' AND r.status='active' AND p.status != 'deleted'
      UNION
      SELECT p.*, r.id AS rel_id FROM relationships r JOIN persons p ON p.id = r.to_person_id
      WHERE r.from_person_id = ? AND r.type='sibling' AND r.status='active' AND p.status != 'deleted'`).all(targetId, targetId);
  }
  rows.sort((a, b) => b.id - a.id);
  return rows[0] ? { person: rows[0], relId: rows[0].rel_id } : null;
}

// 直亲判定
function isDirectRel(rel) {
  return ['father', 'mother', 'son', 'daughter', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother', 'grandson', 'granddaughter', 'brother', 'sister'].includes(rel);
}

// 直亲（父/母/子/女/祖/孙/兄弟姐妹）安全去重：
// 同一位亲属被转写成两种叫法（如「大明」vs「明」）时，按「同 target + 同边方向 + 同性别 + 名字重叠」复用既有节点，
// 而非新建第二节点。绝不做跨性别/跨 rel 的并（那会把母亲误并入父亲，正是早期 bug）。
function findDirectRelDup(targetId, rel, name) {
  if (!targetId || !rel || !name || !isDirectRel(rel)) return null;
  const gender = (['father', 'son', 'grandfather', 'grandson', 'brother', 'maternal-grandfather'].includes(rel)) ? '男'
    : (['mother', 'daughter', 'grandmother', 'granddaughter', 'sister', 'maternal-grandmother'].includes(rel)) ? '女' : '';
  const norm = (s) => (s || '').trim().replace(/[\s·．.・]/g, '');
  const n = norm(name);
  if (n.length < 2) return null; // 单字（爸/妈）不足以判定，交给全局姓名查重
  let rows = [];
  if (rel === 'father' || rel === 'mother' || rel === 'grandfather' || rel === 'grandmother' || rel === 'maternal-grandfather' || rel === 'maternal-grandmother') {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id WHERE r.to_person_id = ? AND r.type='parent' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)`).all(targetId, gender);
  } else if (rel === 'son' || rel === 'daughter' || rel === 'grandson' || rel === 'granddaughter') {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id WHERE r.from_person_id = ? AND r.type='parent' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)`).all(targetId, gender);
  } else if (rel === 'brother' || rel === 'sister') {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id WHERE r.to_person_id IN (SELECT to_person_id FROM relationships WHERE from_person_id = ? AND type='parent' AND status='active') AND r.type='sibling' AND r.status='active' AND p.status != 'deleted' AND (p.gender = ? OR p.gender = '' OR p.gender IS NULL)`).all(targetId, gender);
  }
  for (const p of rows) {
    const pn = norm(p.name);
    if (pn.length < 2) continue;
    if (pn === n || pn.includes(n) || n.includes(pn)) return { person: p, relId: null };
  }
  return null;
}

function addEdge(fromId, toId, type, note = '') {
  if (!fromId || !toId || fromId === toId) return null;
  const exists = db.prepare('SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ? AND status = \'active\'').get(fromId, toId, type);
  if (exists) {
    if (note && !exists.note) {
      db.prepare("UPDATE relationships SET note = ? WHERE id = ?").run(note, exists.id);
    }
    return exists;
  }
  const info = db.prepare('INSERT INTO relationships(from_person_id, to_person_id, type, note, source) VALUES(?, ?, ?, ?, ?)').run(fromId, toId, type, note || '', null);
  return { id: Number(info.lastInsertRowid) };
}

// 把 dropId 合并进 keepId：关系、媒体、章节、认领都迁移；profile 合并；然后软删 dropId
function mergePersons(keepId, dropId) {
  if (!keepId || !dropId || keepId === dropId) return { merged: false };
  const keep = getPerson(keepId);
  const drop = getPerson(dropId);
  if (!keep || !drop) return { merged: false };

  // 1. 合并标量字段（keep 已有则保留，空则用 drop 补）
  const fillable = ['gender', 'birth_date', 'death_date', 'birthplace', 'residence', 'occupation', 'education', 'phone', 'avatar_url', 'bio'];
  const updates = [];
  const vals = [];
  for (const k of fillable) {
    if ((!keep[k] || keep[k] === '') && drop[k]) {
      updates.push(`${k} = ?`);
      vals.push(drop[k]);
    }
  }
  const keepName = (keep.name || '').trim();
  const dropName = (drop.name || '').trim();
  const betterName = keepName.length >= dropName.length && keepName !== '未命名' ? keepName : (dropName || keepName);
  if (betterName && betterName !== keepName) {
    updates.push('name = ?');
    vals.push(betterName);
  }
  if (updates.length) {
    updates.push("updated_at = datetime('now','localtime')");
    db.prepare(`UPDATE persons SET ${updates.join(', ')} WHERE id = ?`).run(...vals, keepId);
  }

  // 2. 合并 profile_json
  let kp = {}, dp = {};
  try { kp = JSON.parse(keep.profile_json || '{}'); } catch (_) { kp = {}; }
  try { dp = JSON.parse(drop.profile_json || '{}'); } catch (_) { dp = {}; }
  const arrKeys = ['career', 'organizations', 'hobbies', 'places', 'life_events'];
  let profileChanged = false;
  for (const k of arrKeys) {
    const have = Array.isArray(kp[k]) ? kp[k] : [];
    const inc = Array.isArray(dp[k]) ? dp[k] : [];
    const keySet = new Set(have.map((x) => JSON.stringify(x)));
    for (const item of inc) {
      const key = JSON.stringify(item);
      if (!keySet.has(key)) { have.push(item); keySet.add(key); profileChanged = true; }
    }
    if (profileChanged && have.length) kp[k] = have;
  }
  for (const [k, v] of Object.entries(dp)) {
    if (!arrKeys.includes(k) && v !== undefined && v !== '' && !(k in kp)) { kp[k] = v; profileChanged = true; }
  }
  if (profileChanged) {
    db.prepare("UPDATE persons SET profile_json = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(JSON.stringify(kp), keepId);
  }

  // 3. 迁移关系边（drop 的 from/to 都改成 keep，避免自环）
  const rels = db.prepare('SELECT * FROM relationships WHERE (from_person_id = ? OR to_person_id = ?) AND status = \'active\'').all(dropId, dropId);
  for (const r of rels) {
    const newFrom = r.from_person_id === dropId ? keepId : r.from_person_id;
    const newTo = r.to_person_id === dropId ? keepId : r.to_person_id;
    if (newFrom === newTo) {
      db.prepare("UPDATE relationships SET status = 'deleted' WHERE id = ?").run(r.id);
      continue;
    }
    const exists = db.prepare('SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ? AND status = \'active\'').get(newFrom, newTo, r.type);
    if (exists) {
      db.prepare("UPDATE relationships SET status = 'deleted' WHERE id = ?").run(r.id);
    } else {
      db.prepare('UPDATE relationships SET from_person_id = ?, to_person_id = ? WHERE id = ?').run(newFrom, newTo, r.id);
    }
  }

  // 4. 迁移媒体、章节、认领
  db.prepare('UPDATE media SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
  db.prepare('UPDATE memoir_chapters SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
  if (drop.claimed_by_user_id && !keep.claimed_by_user_id) {
    db.prepare('UPDATE persons SET claimed_by_user_id = ? WHERE id = ?').run(drop.claimed_by_user_id, keepId);
  }
  // 5. 软删 drop
  db.prepare("UPDATE persons SET status = 'deleted', merged_into = ?, name = ? || ' (已合并)', updated_at = datetime('now','localtime') WHERE id = ?")
    .run(keepId, dropName || '未命名', dropId);
  return { merged: true, keepId, dropId };
}

// 对 target 的某个 rel 类型，找出所有相关节点并合并成一个（用于纠音/纠错后的去重）
function dedupeRelNodes(targetId, rel) {
  if (!targetId || !rel) return [];
  // 直亲关系（父/母/子/女/祖/孙）各自天然可有多条合法实例（父+母、多子女、多祖辈），
  // 且 applyExtraction 建节点前已用 findExistingRelNode 按 rel 查重复用，不会双节点。
  // 这里若按"指向本人的所有 parent 边"跨 rel 去重，会把母亲的 parent 边误并入父亲而软删，
  // 导致母亲/祖父母节点凭空消失。故直亲关系跳过 dedupe，仅对 spouse/sibling 做去重。
  if (['father', 'mother', 'son', 'daughter', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother', 'grandson', 'granddaughter'].includes(rel)) {
    return [];
  }
  const existing = findExistingRelNode(targetId, rel);
  if (!existing) return [];

  const REL_EDGE = {
    father: ['parent', 'from'],
    mother: ['parent', 'from'],
    son: ['parent', 'to'],
    daughter: ['parent', 'to'],
    spouse: ['spouse', 'either'],
    brother: ['sibling', 'either'],
    sister: ['sibling', 'either'],
  };
  const cfg = REL_EDGE[rel];
  if (!cfg) return [];
  const [type, dir] = cfg;
  let rows;
  if (dir === 'from') {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'`).all(targetId, type);
  } else if (dir === 'to') {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id
      WHERE r.from_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'`).all(targetId, type);
  } else if (type === 'spouse') {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'
      UNION
      SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id
      WHERE r.from_person_id = ? AND r.type = ? AND r.status = 'active' AND p.status != 'deleted'`).all(targetId, type, targetId, type);
  } else {
    rows = db.prepare(`SELECT p.* FROM relationships r JOIN persons p ON p.id = r.from_person_id
      WHERE r.to_person_id = ? AND r.type='sibling' AND r.status='active' AND p.status != 'deleted'
      UNION
      SELECT p.* FROM relationships r JOIN persons p ON p.id = r.to_person_id
      WHERE r.from_person_id = ? AND r.type='sibling' AND r.status='active' AND p.status != 'deleted'`).all(targetId, targetId);
  }
  if (rows.length <= 1) return [];

  const keeper = rows[0];
  const merged = [];
  for (let i = 1; i < rows.length; i++) {
    const r = mergePersons(keeper.id, rows[i].id);
    if (r.merged) merged.push(r);
  }
  return merged;
}

// 建谱人/被访谈者本人的节点（claimed 绑定）
function ensureSelfNode(userId) {
  let p = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status != ?').get(userId, 'deleted');
  if (p) return p;
  // 若无本人节点，用 users.real_name 创建（真名锚）
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const name = (u && u.real_name) ? u.real_name : ('用户' + userId);
  const nick = (u && u.nickname) ? u.nickname : '';
  const info = db.prepare('INSERT INTO persons(real_name, claimed_by_user_id, founder_user_id, name, nickname, surname, gender, generation, status) VALUES(?, ?, ?, ?, ?, ?, ?, 0, \'active\')')
    .run(name, userId, userId, name, nick, (name || '')[0] || '', (u && u.gender) || '');
  return getPerson(Number(info.lastInsertRowid));
}

// 把"上三/下三/兄弟姐妹"里提到的亲属，按关系挂到本人关系网（pending_claim 轻量连线）
// 这是阶段4核心：开场必问，提到的亲属名字 → 建待认领节点 + 连边，不追问生平。
// sourceUserId/sourceInterviewId：记录来源，供后续该亲属注册时自动认领关联。
function linkRelatives(targetId, rel, name, gender, sourceUserId = null, sourceInterviewId = null) {
  if (!targetId || !rel || !name) return null;
  const relGender =
    gender ||
    (['father', 'son', 'grandfather', 'grandson', 'brother', 'maternal-grandfather'].includes(rel) ? '男'
      : ['mother', 'daughter', 'grandmother', 'granddaughter', 'sister', 'maternal-grandmother'].includes(rel) ? '女' : '');
  const existing = findRelMatch(targetId, rel, name);
  let relPerson;
  let created = false;
  if (existing) {
    relPerson = reconcilePersonAlias(existing, name);
    if (!relPerson.gender && relGender) {
      db.prepare("UPDATE persons SET gender = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(relGender, relPerson.id);
      relPerson = getPerson(relPerson.id);
    }
  } else {
    const e = ensurePerson(name, relGender, 'pending_claim', name, sourceUserId, sourceInterviewId);
    relPerson = e.person;
    created = e.created;
  }

  // 连边（parent/spouse/sibling 轻量连线）
  if (rel === 'father' || rel === 'mother' || rel === 'grandfather' || rel === 'grandmother' || rel === 'maternal-grandfather' || rel === 'maternal-grandmother') {
    addEdge(relPerson.id, targetId, 'parent');
    // 祖父/外祖父：再向上挂一层（祖父是父亲的父亲）
    if (rel === 'grandfather' || rel === 'maternal-grandfather') {
      const father = findExistingRelNode(targetId, 'father');
      if (father && father.person.name && father.person.name !== relPerson.name) {
        addEdge(relPerson.id, father.person.id, 'parent');
      }
    }
    if (rel === 'grandmother' || rel === 'maternal-grandmother') {
      const mother = findExistingRelNode(targetId, 'mother');
      if (mother && mother.person.name && mother.person.name !== relPerson.name) {
        addEdge(relPerson.id, mother.person.id, 'parent');
      }
    }
  } else if (rel === 'son' || rel === 'daughter' || rel === 'grandson' || rel === 'granddaughter') {
    addEdge(targetId, relPerson.id, 'parent');
    if (rel === 'grandson' || rel === 'granddaughter') {
      const son = findExistingRelNode(targetId, 'son');
      const daughter = findExistingRelNode(targetId, 'daughter');
      const child = son || daughter;
      if (child && child.person.name && child.person.name !== relPerson.name) {
        addEdge(child.person.id, relPerson.id, 'parent');
      }
    }
  } else if (rel === 'spouse') {
    addEdge(targetId, relPerson.id, 'spouse');
    addEdge(relPerson.id, targetId, 'spouse');
  } else if (rel === 'brother' || rel === 'sister') {
    // 兄弟姐妹：与本人共享父母（parent 边由本人→父母派生，这里补一条 sibling 标注边）
    addEdge(targetId, relPerson.id, 'sibling');
    addEdge(relPerson.id, targetId, 'sibling');
  }

  // 兜底去重（纠音后防止双节点）
  dedupeRelNodes(targetId, rel);
  return { person: relPerson, created };
}

function applyExtraction(interview, extract, relayMode = false) {
  const newNodes = [];
  const newEdges = [];
  const captured = [];
  const coveredRel = []; // 本轮采集到的关系线 name，统一标记进 covered_fields 防重复问
  const targetId = interview.target_person_id;

  const target = targetId ? getPerson(targetId) : null;
  const self = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status != ? LIMIT 1').get(interview.user_id, 'deleted');
  const guard = sanitizeExtract(extract, target, relayMode ? { selfName: self ? self.name : '' } : false);
  if (guard.warnings.length) console.warn('[ingest-guard] applyExtraction:', guard.warnings.join(' | '));
  extract = guard.safeExtract;

  if (relayMode) {
    return applyRelayExtraction(interview, extract, targetId);
  }

  if (targetId && extract.person) {
    const got = applyPersonFields(targetId, extract.person);
    captured.push(...got);
    const prof = mergePersonProfile(targetId, extract.person);
    for (const k of prof) captured.push(k);
    // 落库后把已采集字段持久化到 covered_fields（换手机/换天再进也永不重复问）
    db.addCoveredFields(targetId, [...got, ...prof.map((k) => 'person.' + k)]);
  }

  for (const r of extract.relations || []) {
    const relGender =
      r.gender ||
      (['father', 'son', 'grandfather', 'grandson', 'brother', 'maternal-grandfather'].includes(r.rel) ? '男'
        : ['mother', 'daughter', 'grandmother', 'granddaughter', 'sister', 'maternal-grandmother'].includes(r.rel) ? '女' : '');

    let relPerson;
    let created = false;
    const corrections = extract.__corrections || [];
    let existing = (r.name) ? findRelMatch(targetId, r.rel, r.name) : null;
    // 【关键修复】若新名字命中某条纠正的"正确写法(to)"，则把那条"错误写法(from)"的已有同关系节点就地改名，
    // 避免对话里纠正父母名时系统又建一个重复正确节点、而错字节点残留。
    if (!existing && r.name && corrections.length) {
      for (const c of corrections) {
        if (c.to === r.name && c.from) {
          const wrong = findRelMatch(targetId, r.rel, c.from);
          if (wrong) {
            db.prepare("UPDATE persons SET name = ?, surname = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(r.name, (r.name[0] || ''), wrong.id);
            existing = wrong;
            break;
          }
        }
      }
    }
    if (existing) {
      relPerson = reconcilePersonAlias(existing, r.name);
      if (!relPerson.gender && relGender) {
        db.prepare("UPDATE persons SET gender = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(relGender, relPerson.id);
        relPerson = getPerson(relPerson.id);
      }
      // 该亲属的称呼/姓名已采集，标记进 covered_fields（防后续再去问"TA叫什么"）
      coveredRel.push('relation.' + r.rel + '.name');
    } else if (r.name) {
      const e = ensurePerson(r.name, relGender, 'pending_claim', r.name, interview.user_id, interview.id);
      relPerson = e.person;
      created = e.created;
    } else {
      continue; // 无姓名的弱关系不建节点
    }

    if (created) {
      newNodes.push(relPerson);
      captured.push('relation.' + r.rel);
      if (r.name) coveredRel.push('relation.' + r.rel + '.name');
    }

    if (r.note) {
      mergePersonProfile(relPerson.id, { profile: { note: r.note } });
    }

    let edge = null;
    if (r.rel === 'father' || r.rel === 'mother' || r.rel === 'grandfather' || r.rel === 'grandmother' || r.rel === 'maternal-grandfather' || r.rel === 'maternal-grandmother') {
      edge = addEdge(relPerson.id, targetId, 'parent');
      if (r.rel === 'grandfather' || r.rel === 'maternal-grandfather') {
        const father = findExistingRelNode(targetId, 'father');
        if (father && father.person.name && father.person.name !== relPerson.name) addEdge(relPerson.id, father.person.id, 'parent');
      }
      if (r.rel === 'grandmother' || r.rel === 'maternal-grandmother') {
        const mother = findExistingRelNode(targetId, 'mother');
        if (mother && mother.person.name && mother.person.name !== relPerson.name) addEdge(relPerson.id, mother.person.id, 'parent');
      }
    } else if (r.rel === 'son' || r.rel === 'daughter' || r.rel === 'grandson' || r.rel === 'granddaughter') {
      edge = addEdge(targetId, relPerson.id, 'parent');
      if (r.rel === 'grandson' || r.rel === 'granddaughter') {
        const son = findExistingRelNode(targetId, 'son');
        const daughter = findExistingRelNode(targetId, 'daughter');
        const child = son || daughter;
        if (child && child.person.name && child.person.name !== relPerson.name) addEdge(child.person.id, relPerson.id, 'parent');
      }
    } else if (r.rel === 'spouse') {
      addEdge(targetId, relPerson.id, 'spouse');
      addEdge(relPerson.id, targetId, 'spouse');
      edge = { id: 'spouse' };
    } else if (r.rel === 'brother' || r.rel === 'sister') {
      addEdge(targetId, relPerson.id, 'sibling');
      addEdge(relPerson.id, targetId, 'sibling');
      edge = { id: 'sibling' };
    } else {
      addEdge(targetId, relPerson.id, 'acquaintance', r.rel || '');
      edge = { id: 'acquaintance' };
    }
    if (edge && edge.id && typeof edge.id === 'number' && r.rel !== 'spouse' && r.rel !== 'brother' && r.rel !== 'sister') newEdges.push(edge.id);

    dedupeRelNodes(targetId, r.rel);
  }

  // 本轮采集到的关系线 name 统一持久化到 covered_fields（防换设备/换天再进重复问）
  if (coveredRel.length) db.addCoveredFields(targetId, coveredRel);

  const linked = [];
  for (const name of extract.link_names || []) {
    const p = findPersonByName(name);
    if (p && p.id !== targetId) linked.push(name);
  }
  invalidateGraphCache();
  return { newNodes, newEdges, linked, captured };
}

// 代录关系线模式：target 就是被代录的亲属节点，只更新其 name/gender（若用户说），且只处理
// 「用户与 TA 的关系」这一条——即反过来在 target 上补一条指向本人(self)的 parent/spouse 边。
function applyRelayExtraction(interview, extract, targetId) {
  const newNodes = [];
  const newEdges = [];
  const captured = [];
  if (!targetId) return { newNodes, newEdges, linked: [], captured };

  const target = getPerson(targetId);
  if (!target) return { newNodes, newEdges, linked: [], captured };

  const self = db.prepare('SELECT id FROM persons WHERE claimed_by_user_id = ? AND status != ? LIMIT 1').get(interview.user_id, 'deleted');
  const selfId = self ? self.id : null;
  let nameUpdated = false;
  if (extract.person && extract.person.name && (!target.name || target.name === '未命名')) {
    const g = extract.person.gender || target.gender || '';
    db.prepare("UPDATE persons SET name = ?, gender = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(extract.person.name.trim(), g, target.id);
    nameUpdated = true;
  }

  for (const r of extract.relations || []) {
    if (!r.rel || r.rel === 'other' || ['friend', 'colleague', 'teacher', 'neighbor'].includes(r.rel)) continue;
    if (r.name && target.name && r.name.trim() && target.name.indexOf(r.name.trim()) === -1 && (r.name.trim().indexOf(target.name) === -1)) continue;
    if (r.rel === 'father' || r.rel === 'mother') {
      if (selfId) addEdge(target.id, selfId, 'parent');
    } else if (r.rel === 'son' || r.rel === 'daughter') {
      if (selfId) addEdge(selfId, target.id, 'parent');
    } else if (r.rel === 'spouse') {
      if (selfId) { addEdge(selfId, target.id, 'spouse'); addEdge(target.id, selfId, 'spouse'); }
    }
    if (r.note) mergePersonProfile(target.id, { profile: { note: r.note } });
    captured.push('relation.' + r.rel);
    break;
  }

  if (nameUpdated) captured.push('name');
  invalidateGraphCache();
  return { newNodes, newEdges: [], linked: [], captured };
}

// 代际分层（全局图，按关系边 BFS）
function getGraph(selfId) {
  if (_graphCache) return _graphCache;
  const persons = db.prepare('SELECT id, name, gender, status, birth_date, claimed_by_user_id, visibility FROM persons WHERE status != ?').all('deleted');
  const rels = db.prepare("SELECT from_person_id, to_person_id, type FROM relationships WHERE status = 'active'").all();

  const parentsOf = {};
  const spouses = {};
  rels.forEach((r) => {
    if (r.type === 'parent') (parentsOf[r.to_person_id] = parentsOf[r.to_person_id] || []).push(r.from_person_id);
    else if (r.type === 'spouse') (spouses[r.from_person_id] = spouses[r.from_person_id] || []).push(r.to_person_id);
  });

  const gen = {};
  persons.forEach((p) => (gen[p.id] = 0));
  let changed = true, guard = 0;
  while (changed && guard++ < 2000) {
    changed = false;
    rels.forEach((r) => {
      if (r.type === 'parent') {
        const g = gen[r.from_person_id] + 1;
        if (g > gen[r.to_person_id]) { gen[r.to_person_id] = g; changed = true; }
      }
    });
  }
  changed = true; guard = 0;
  while (changed && guard++ < 2000) {
    changed = false;
    rels.forEach((r) => {
      if (r.type === 'spouse') {
        const g = Math.max(gen[r.from_person_id], gen[r.to_person_id]);
        if (gen[r.from_person_id] !== g || gen[r.to_person_id] !== g) { gen[r.from_person_id] = g; gen[r.to_person_id] = g; changed = true; }
      }
    });
  }

  const nodes = persons.map((p) => ({ ...p, gen: gen[p.id] ?? 0 }));
  const edges = rels.map((r) => ({ from: r.from_person_id, to: r.to_person_id, type: r.type }));
  _graphCache = { nodes, edges };
  return _graphCache;
}

function userTurnCount(interviewId) {
  const row = db.prepare("SELECT COUNT(*) c FROM messages WHERE interview_id = ? AND role = 'user'").get(interviewId);
  return row.c;
}

// 开场引导：上三/下三/兄弟姐妹（阶段4）
function buildOpeningSeed(isRelay, target) {
  if (isRelay) {
    return target && target.name
      ? ('你帮我记一下「' + (target.name || '这位亲属') + '」和你是什么关系、该怎么称呼这位亲属、还有没有什么想顺带说一句的？')
      : '你帮我记一下这位亲人和你的关系、怎么称呼，以及有没有什么想顺带说一句的？';
  }
  // 本人补全：开场按已采集情况决定，绝不重复问已记录项（尤其父母姓名）
  if (target && target.name && target.gender) {
    let parentsKnown = false;
    try {
      const rows = db.prepare(
        "SELECT 1 FROM relationships r JOIN persons p ON (p.id=r.from_person_id OR p.id=r.to_person_id) " +
        "WHERE (r.from_person_id=? OR r.to_person_id=?) AND r.type='parent' AND r.to_person_id=? AND p.status!='deleted' LIMIT 1"
      ).get(target.id, target.id, target.id);
      parentsKnown = !!rows;
    } catch (_) {}
    if (!parentsKnown) {
      return '咱们慢慢聊——你家里兄弟姐妹几个？你在家里排行老几？';
    }
    // 基本信息+父母都已记录：用中性开场，把话题主导权交给用户与 covered 去重逻辑
    return '咱们接着慢慢聊——你愿意先从哪儿讲起都行。比如你小时候最爱玩什么、或者家里哪件老物件你到现在还记得？';
  }
  return '咱们慢慢聊——你愿意先从哪儿讲起都行。要不先从你家里人聊起？你爸、你妈，他们叫什么名字呀？';
}

async function startInterview({ userId, type = 'person_claim', targetPersonId = null, relayMode = false, nickname = '', era = '', focusPersonId = null, focusRelation = '', chapterId = null }) {
  const isRelay = !!relayMode && type === 'person_claim' && !!targetPersonId;
  let targetId = targetPersonId;
  if (type === 'person_claim' && !targetId) {
    const self = ensureSelfNode(userId);
    targetId = self.id;
  }

  // ===== 章节聚焦（2026-09-14 新增）=====
  // 来源：人生书「📖 回忆录」里每一章的「🎙 接着聊」。
  // 语义：这一场谈话是**就着某一章**讲的 → 沉淀时必须把它**融进那一章**（extendChapter），
  //       而不是按窗口另起新章。
  // 背景：原时间线页的「再聊聊这段」只传阶段名（continueStory 的 ch 参数压根没用上），
  //       点某一章进去其实是阶段级访谈 —— 名不副实，这里一并修正。
  // 只认属于本次谈话对象的那一章，避免 A 的补讲写进 B 的传记。
  let focusChapter = null;
  if (chapterId != null && chapterId !== '' && !isRelay) {
    const ch = db.prepare('SELECT id, person_id, title FROM memoir_chapters WHERE id = ?').get(Number(chapterId));
    if (ch && String(ch.person_id) === String(targetId)) focusChapter = ch;
    else if (ch) console.warn('[interview] chapterId 不属于本次谈话对象，已忽略：', chapterId, '→', targetId);
  }
  const focusChapterId = focusChapter ? focusChapter.id : null;

  // ===== 续聊：同一 (user, 谈话对象, 本人/代录, 聚焦章节) 只保留一条访谈 =====
  // 2026-09-14 用户决策（"接着上次继续" + "避免再产生这种空壳"）：
  //   此前每次进访谈页都 INSERT 一条新访谈 → 36 条里 28 条是"只有 AI 开场白"的空壳；
  //   更糟的是讲述者的历史发言被切碎在不同访谈里（喂给模型的上下文只剩当前这一条，
  //   于是 AI 反复问同样的问题）。现在：
  //     ① 优先复用"有用户发言"的最近一条 → 真正的续聊，历史回到上下文；
  //     ② 否则复用最近一条空壳 → 误点一次不再多一条垃圾；
  //     ③ 都没有才新建。
  // 同日补充：**聚焦章节也进键**。否则从章节 A「接着聊」讲的内容会和章节 B 的混在同一条访谈里，
  //   沉淀时只能归给"当前聚焦的那一章"，必然串章。进键后每章各自一条会话，互不污染。
  const relayFlag = isRelay ? 1 : 0;
  const sameKey = db
    .prepare(
      `SELECT i.id,
              (SELECT COUNT(*) FROM messages m WHERE m.interview_id = i.id AND m.role = 'user') AS u
         FROM interviews i
        WHERE i.user_id = ? AND i.relay_mode = ? AND IFNULL(i.target_person_id, 0) = IFNULL(?, 0)
          AND IFNULL(i.focus_chapter_id, 0) = IFNULL(?, 0)
        ORDER BY i.id DESC`
    )
    .all(userId, relayFlag, targetId, focusChapterId);
  const spokenIds = sameKey.filter((r) => r.u > 0).map((r) => r.id);
  const shellIds = sameKey.filter((r) => r.u === 0).map((r) => r.id);

  let iid = spokenIds.length ? spokenIds[0] : (shellIds.length ? shellIds[0] : null);
  const resumed = !!iid;

  // 防复发：同键的多余空壳直接清掉（有用户发言的一律不动）——
  // 于是空壳至多留一条，且下次会被"复用"而不是再新建一条。
  const staleShellIds = shellIds.filter((id) => id !== iid);
  if (staleShellIds.length) {
    try {
      const ph = staleShellIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE interview_id IN (${ph})`).run(...staleShellIds);
      db.prepare(`DELETE FROM interviews WHERE id IN (${ph})`).run(...staleShellIds);
    } catch (e) {
      console.warn('[interview] 空壳清理失败：', e.message);
    }
  }

  if (resumed) {
    // 直接回放既有对话（含 AI 开场白），不再花一次模型调用重新开场。
    // 兼容性：除 history 外仍返回 reply（=最后一条 AI 消息），旧调用方 / 回归脚本照旧能读。
    const hist = getMessages(iid);
    const lastAssistant = [...hist].reverse().find((m) => m.role === 'assistant');
    return {
      interviewId: iid,
      resumed: true,
      history: hist,
      reply: lastAssistant ? lastAssistant.content : '',
      target: targetId ? getPerson(targetId) : null,
      demoMode: getLLMConfig().demoMode,
      relayMode: isRelay,
    };
  }

  const info = db.prepare('INSERT INTO interviews(user_id, target_person_id, type, status, relay_mode, focus_chapter_id) VALUES(?, ?, ?, ?, ?, ?)')
    .run(userId, targetId, type, 'active', relayFlag, focusChapterId);
  iid = Number(info.lastInsertRowid);

  const selfNode = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status != ? LIMIT 1').get(userId, 'deleted');
  const selfId = selfNode ? selfNode.id : null;
  const known = listKnownPersons(selfId);
  const target = targetId ? getPerson(targetId) : null;
  // 谈话称呼优先用用户昵称（注册时填的昵称），让 AI 用昵称而非真名提问，更自然不僵硬
  const callName = (nickname && nickname.trim()) ? nickname.trim() : (target && target.name ? target.name : null);
  const coveredFields = db.getCoveredFields(targetId);
  const corrections = getCorrections(targetId);

  const focusPerson = (focusPersonId && !isRelay) ? getPerson(focusPersonId) : null;
  let reply;
  if (focusPerson && !isRelay) {
    // 从人物线「围绕某人补讲」进入：聚焦该人物，让用户先发言
    const relText = focusRelation ? `（${focusRelation}）` : '';
    reply = `好，那我们就围绕「${focusPerson.name}」${relText}慢慢聊。${callName ? callName + '，' : '你'}想从你们之间的哪件印象最深的小事讲起？慢慢说，我听着。`;
  } else if (focusChapter && !isRelay) {
    // 从人生书某章的「🎙 接着聊」进入：点明"接着这一节讲"，让用户先发言
    const t = focusChapter.title ? `「${focusChapter.title}」` : '这一节';
    reply = `好，那我们就接着${t}往下讲。${callName ? callName + '，' : '你'}想到什么就说什么，不用讲顺序，我听着。`;
  } else if (era && !isRelay) {
    // 从时间线/人生书某阶段「补讲」进入：让用户先发言，只给一个开放式邀请
    reply = `好，那我们就围绕「${era}」时期慢慢聊。${callName ? callName + '，' : '你'}想从哪件印象最深的小事讲起？慢慢说，我听着。`;
  } else {
    const seedText = buildOpeningSeed(isRelay, target);
    const r = await runInterview([{ role: 'user', content: seedText }], known, callName, target, null, isRelay, coveredFields, corrections);
    reply = r.reply;
  }
  const correctedReply = correctText(reply, targetId);
  db.prepare('INSERT INTO messages(interview_id, role, content) VALUES(?, ?, ?)').run(iid, 'assistant', correctedReply);
  return { interviewId: iid, reply: correctedReply, target: target, demoMode: getLLMConfig().demoMode, relayMode: isRelay };
}

async function sendMessage(interviewId, text, opts = {}) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) throw new Error('访谈不存在');
  const isRelay = !!interview.relay_mode || !!opts.relayMode;
  const nickname = opts.nickname || '';
  const selfNode = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status != ? LIMIT 1').get(interview.user_id, 'deleted');
  const selfId = selfNode ? selfNode.id : null;
  const target = interview.target_person_id ? getPerson(interview.target_person_id) : null;
  const known = listKnownPersons(selfId);
  // 上下文窗口化：只取最近 N 条历史喂给模型，避免长访谈 token 无限膨胀
  // （结构化事实由 known/target/confirmedPaths/coveredFields/corrections 单独传入，不依赖全量历史）
  const MAX_CTX_MESSAGES = 60; // 约 30 轮对话
  const rawHistory = db
    .prepare('SELECT role, content FROM messages WHERE interview_id = ? ORDER BY id')
    .all(interviewId)
    .map((m) => ({ role: m.role, content: m.content }));
  const history = rawHistory.slice(-MAX_CTX_MESSAGES);
  const messages = [...history, { role: 'user', content: text }];

  const ins = db.prepare('INSERT INTO messages(interview_id, role, content) VALUES(?, ?, ?)').run(interviewId, 'user', text);
  // 原音追溯（2026-10-04）：把这段真人原声关联到刚插入的这条原话上。
  // 失败不影响正文 —— 传记内容优先于音频留存。
  if (opts.audioId) {
    try {
      db.prepare(
        'UPDATE audio_clips SET message_id = ?, person_id = ? WHERE id = ? AND interview_id = ?'
      ).run(Number(ins.lastInsertRowid), interview.target_person_id || null, Number(opts.audioId), interviewId);
    } catch (e) {
      console.warn('[interview] 原音关联失败（不影响传记正文）:', e.message);
    }
  }

  const confirmedRows = db.prepare('SELECT path FROM interview_confirmed WHERE interview_id = ?').all(interviewId);
  const confirmedPaths = new Set(confirmedRows.map((r) => r.path));
  const coveredFields = db.getCoveredFields(interview.target_person_id);
  const corrections = getCorrections(interview.target_person_id);

  // 谈话称呼优先用昵称
  const callName = (nickname && nickname.trim()) ? nickname.trim() : (target && target.name ? target.name : null);
  const { reply, extract } = await runInterview(messages, known, callName, target, confirmedPaths, isRelay, coveredFields, corrections);
  const result = applyExtraction(interview, extract, isRelay);
  const targetId = interview.target_person_id;
  const correctedReply = correctText(reply, targetId);
  db.prepare('INSERT INTO messages(interview_id, role, content) VALUES(?, ?, ?)').run(interviewId, 'assistant', correctedReply);

  // 回忆录章节沉淀（每 5 轮或用户示意结束）
  // P0-2 修复：改用增量游标（interviews.chapter_cursor），只对上次沉淀以来的新消息窗口做
  // isSelfStory 判定与 summarizeChapter。此前用全量历史，导致：① 早期讲过一次亲属经历后，
  // 后续本人经历被永久判非本人、再也无法沉淀；② 每次沉淀都全量总结+追加，章节无限膨胀。
  let chapter = null;
  const doneWords = /(讲完了|今天就到这|差不多了|先到这|先聊到这|今天就讲到这|聊到这儿|结束|就这样|说完了|没有了|就这些|到此为止|结束吧|不说了|没了)/;
  const isDone = doneWords.test(text);
  // 【2026-09-14 修复】触发条件改为「游标之后新增的用户轮数 ≥ 5」，而不是「该访谈历史总轮数 % 5 === 0」。
  // 原是 ucount % 5：总轮数取模与游标窗口两套口径并存 ——
  //   ① 一次访谈若在第 4 轮后中断，再也不会满足 %5，永远不沉淀；
  //   ② 游标停在 0 的访谈（批量重建脚本不会推进游标）一旦满足 %5，
  //      会把**整段历史**重新总结一遍，产出与现有章节重复的新章节。
  // 改成增量口径后，每 5 轮必然沉淀一次，且窗口永远只覆盖未沉淀的新消息。
  const cursorBefore = interview.chapter_cursor || 0;
  const pendingUser = db
    .prepare("SELECT COUNT(*) c FROM messages WHERE interview_id = ? AND id > ? AND role = 'user' AND kind = 'chat'")
    .get(interviewId, cursorBefore).c;
  if (pendingUser >= 5 || isDone) {
    const cursor = cursorBefore;
    const rows = db
      .prepare("SELECT id, role, content FROM messages WHERE interview_id = ? AND id > ? AND kind = 'chat' ORDER BY id")
      .all(interviewId, cursor);
    if (rows.length) {
      const lastId = rows[rows.length - 1].id;
      let chapterMessages = rows.map((m) => ({
        id: m.id,   // 原话追溯必需：沉淀时要回写 messages.chapter_id（此前 map 漏掉 id）
        role: m.role,
        content: m.role === 'assistant' ? correctText(m.content, targetId) : m.content,
      }));
      // 结束语本身不进章节
      if (
        isDone &&
        chapterMessages.length &&
        chapterMessages[chapterMessages.length - 1].role === 'user' &&
        doneWords.test(chapterMessages[chapterMessages.length - 1].content)
      ) {
        chapterMessages = chapterMessages.slice(0, -1);
      }
      const userTexts = chapterMessages.filter((m) => m.role === 'user').map((m) => m.content);
      // 【2026-09-14】章节聚焦会话（从某章的「🎙 接着聊」进来）：本窗口内容**融进那一章**，
      // 不新建章节 —— 否则用户点着"接着这一节讲"讲了一通，传记里却多出一节不相干的新章。
      if (interview.focus_chapter_id) {
        chapter = await sedimentIntoFocusChapter(interview, chapterMessages, targetId);
        if (!chapter) console.log('[interview] 章节聚焦会话本轮未产生章节更新');
      // 关键：如果本轮窗口的讲述主要是亲属自己的经历，不写入本人回忆录（只保留关系线/备注）；
      // 无论写入与否都推进游标——被跳过的亲属经历不应留到下个窗口继续污染判定
      } else if (chapterMessages.length && isSelfStory(userTexts)) {
        const stage = inferStage(extract, userTexts);
        // 跨章去重：把该人物已有章节标题传给总结器，避免新章节重复已写过的内容
        let existingTitles = db.prepare(
          "SELECT title FROM memoir_chapters WHERE person_id = ? AND IFNULL(title,'') <> '' ORDER BY id"
        ).all(targetId).map((r) => r.title);
        // 话题切段：用户在窗口中途说「换个话题」时，各话题独立成章，不再硬塞进同一章
        const segments = splitSegmentsByTopicShift(chapterMessages);
        for (const seg of segments) {
          const segUsers = seg.filter((m) => m.role === 'user').map((m) => m.content);
          if (!segUsers.length) continue;
          const ch = await summarizeChapter(seg, '', { existingTitles });
          if (!ch.title && !ch.summary && !ch.excerpt) continue; // 噪声段不建章
          // 【2026-09-14】空正文保护：只有标题/摘录、没有正文的"薄章节"渲染出来就是一节空白，
          // 对传记毫无价值。宁可跳过——原始消息仍在 messages 表里，用户补写或重讲仍可成章。
          if (!String(ch.summary || '').trim()) {
            console.warn('[interview] 该段未产出正文，跳过建章（避免空白章节）：', ch.title || '(无标题)');
            continue;
          }
          ch.stage = stage;
          // 原话追溯：传本段（seg）自己的消息 id，不传整窗 —— 否则同窗多章会共享同一批原话
          ch.sourceMessageIds = seg.filter((m) => m.role === 'user' && m.id).map((m) => m.id);
          chapter = upsertChapter(targetId, ch);
          if (ch.title) existingTitles = existingTitles.concat(ch.title);
        }
      } else {
        console.log('[interview] 本轮主要为亲属经历，跳过本人回忆录章节沉淀');
      }
      db.prepare('UPDATE interviews SET chapter_cursor = ? WHERE id = ?').run(lastId, interviewId);
    }
  }

  const updatedTarget = interview.target_person_id ? getPerson(interview.target_person_id) : null;
  return {
    interviewId,
    reply: correctedReply,
    extract,
    review: extract.review || [],
    captured: result.captured || [],
    target: updatedTarget,
    graph: getGraph(selfId),
    newNodes: result.newNodes,
    newEdges: result.newEdges,
    linked: result.linked,
    chapter,
  };
}

async function resayMessage(interviewId, text, opts = {}) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) throw new Error('访谈不存在');
  const selfNode = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status != ? LIMIT 1').get(interview.user_id, 'deleted');
  const selfId = selfNode ? selfNode.id : null;
  const target = interview.target_person_id ? getPerson(interview.target_person_id) : null;
  const isRelay = !!interview.relay_mode;
  const nickname = opts.nickname || '';
  const known = listKnownPersons(selfId);

  // P1-3 修复：重说 = 用新文本「替换」库里最后一条 user 消息（识别错误的旧版本不再留在 history，
  // 后续 LLM 上下文 / coveredTopics 都只看正确版本），而不是只在内存里追加一条不落库的临时消息。
  const lastUserRow = db
    .prepare("SELECT id FROM messages WHERE interview_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
    .get(interviewId);
  if (lastUserRow) {
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(text, lastUserRow.id);
  } else {
    db.prepare('INSERT INTO messages(interview_id, role, content) VALUES(?, ?, ?)').run(interviewId, 'user', text);
  }
  const history = db
    .prepare('SELECT role, content FROM messages WHERE interview_id = ? ORDER BY id')
    .all(interviewId)
    .map((m) => ({ role: m.role, content: m.content }));
  const messages = history; // 最后一条 user 已是新文本，抽取逻辑取 lastUserText 即为新说的内容

  const confirmedRows = db.prepare('SELECT path FROM interview_confirmed WHERE interview_id = ?').all(interviewId);
  const confirmedPaths = new Set(confirmedRows.map((r) => r.path));
  const coveredFields = db.getCoveredFields(interview.target_person_id);
  const corrections = getCorrections(interview.target_person_id);

  // 谈话称呼优先用昵称
  const callName = (nickname && nickname.trim()) ? nickname.trim() : (target && target.name ? target.name : null);
  const { extract } = await runInterview(messages, known, callName, target, confirmedPaths, isRelay, coveredFields, corrections);
  const result = applyExtraction(interview, extract, isRelay);

  const targetId = interview.target_person_id;
  const lastAsst = db
    .prepare("SELECT content FROM messages WHERE interview_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get(interviewId);
  const reply = correctText(lastAsst ? lastAsst.content : '嗯，我听着呢，你接着说。', targetId);

  const updatedTarget = targetId ? getPerson(targetId) : null;
  return {
    interviewId,
    reply,
    extract,
    review: extract.review || [],
    captured: result.captured || [],
    target: updatedTarget,
    graph: getGraph(selfId),
    newNodes: result.newNodes,
    newEdges: result.newEdges,
    linked: result.linked,
  };
}

async function finishInterview(interviewId) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) throw new Error('访谈不存在');
  const targetId = interview.target_person_id;

  db.prepare("UPDATE interviews SET status = 'done', finished_at = datetime('now','localtime') WHERE id = ?").run(interviewId);

  if (interview.relay_mode) return { ok: true, chapter: null };

  // 收尾沉淀：只处理游标之后剩余的窗口（此前 5 轮倍数未覆盖到的尾部轮次）
  const cursor = interview.chapter_cursor || 0;
  const rows = db
    .prepare("SELECT id, role, content FROM messages WHERE interview_id = ? AND id > ? AND kind = 'chat' ORDER BY id")
    .all(interviewId, cursor);
  let chapter = null;
  if (rows.length) {
    const lastId = rows[rows.length - 1].id;
    const msgs = rows.map((m) => ({ id: m.id, role: m.role, content: m.role === 'assistant' ? correctText(m.content, targetId) : m.content }));
    const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.content);
    // 章节聚焦会话（见 sedimentIntoFocusChapter 注释）：收尾也融进那一章，不另起
    if (interview.focus_chapter_id) {
      chapter = await sedimentIntoFocusChapter(interview, msgs, targetId);
    } else if (isSelfStory(userTexts)) {
      const stage = inferStage({}, userTexts);
      let existingTitles = db.prepare(
        "SELECT title FROM memoir_chapters WHERE person_id = ? AND IFNULL(title,'') <> '' ORDER BY id"
      ).all(targetId).map((r) => r.title);
      for (const seg of splitSegmentsByTopicShift(msgs)) {
        const segUsers = seg.filter((m) => m.role === 'user').map((m) => m.content);
        if (!segUsers.length) continue;
        const ch = await summarizeChapter(seg, '', { existingTitles });
        if (!ch.title && !ch.summary && !ch.excerpt) continue;
        // 【2026-09-14】同 sendMessage：空正文的薄章节一律不落库
        if (!String(ch.summary || '').trim()) {
          console.warn('[interview] 收尾沉淀该段未产出正文，跳过建章：', ch.title || '(无标题)');
          continue;
        }
        ch.stage = stage;
        chapter = upsertChapter(targetId, ch);
        if (ch.title) existingTitles = existingTitles.concat(ch.title);
      }
    }
    db.prepare('UPDATE interviews SET chapter_cursor = ? WHERE id = ?').run(lastId, interviewId);
  }
  return { ok: true, chapter };
}

// 话题切段（2026-09-13）：用户在窗口中途说「换个话题」时，把沉淀窗口按该边界切段，
// 各段独立成章——防止不同主题被生硬塞进同一章（此前「鬼故事章」混入画画/工资/兄弟情即此问题）。
// 切段边界只认用户消息里的明确换话题表述，措辞保守避免误切。
const TOPIC_SHIFT_RE = /换(?:个|下|一下|一个)?(?:的)?话题/;
function splitSegmentsByTopicShift(msgs) {
  const segments = [];
  let cur = [];
  for (const m of msgs || []) {
    if (m.role === 'user' && TOPIC_SHIFT_RE.test(String(m.content || '').replace(/\s/g, ''))) {
      if (cur.some((x) => x.role === 'user')) segments.push(cur);
      cur = [];
      continue; // 「换个话题」这句本身是流程用语，不进任何章节
    }
    cur.push(m);
  }
  if (cur.some((x) => x.role === 'user')) segments.push(cur);
  return segments.length ? segments : [msgs || []].filter((s) => s.some((x) => x.role === 'user'));
}

// 章节沉淀（2026-09-13「每次成章」改造，用户拍板）：
// 每个沉淀窗口独立成章。此前「同阶段追加 = 无脑拼接」已两次产出垃圾：
//   ① CH#4 同一段总结重复堆 5 遍（用户已确认删除）；
//   ② CH#3 童年画国画与工作选择混在同一章，文风断裂。
// stage/year 只作为前端分组展示的标签，不再作为「同章合并」依据。
// 忠实原话原则：宁可多章，也不做「总结的总结」层层失真。
// 空章节防护：标题/正文/摘录全空 → 不建章（此前曾产生全空幽灵章节 CH#2）。
// ============================================================
// 章节聚焦会话的沉淀（2026-09-14 新增）
// ------------------------------------------------------------
// 场景：用户从人生书某一章的「🎙 接着聊」进来，用语音把这一节讲细。
// 与普通会话的区别 —— 不按窗口另起新章，而是调 extendChapter 把这一窗口的新内容
// **融进那一章**（旧正文信息一条不丢、也不重复），这正是"接着聊"该有的结果。
// 两点刻意取舍：
//   ① **跳过 isSelfStory 闸门**：那个闸门是为"闲聊里混进亲属经历"设计的启发式判断；
//      而这里是用户明确点选"接着这一章讲" —— 显式意图优先于启发式，
//      否则讲了半天不落库，用户看到的就是"AI 记住了但传记没变"。
//   ② 空正文保护同样生效：融合稿没有正文就整段跳过，绝不把这一节写空。
// 返回更新后的章节对象；未更新则返回 null（原文仍在 messages 里，可重讲或走「➕补充经历」）。
// ============================================================
async function sedimentIntoFocusChapter(interview, messages, targetId) {
  const cid = interview.focus_chapter_id;
  if (!cid) return null;
  const ch = db.prepare('SELECT * FROM memoir_chapters WHERE id = ?').get(cid);
  if (!ch) {
    console.warn('[interview] 聚焦章节已不存在，本次不沉淀：', cid);
    return null;
  }
  const userTexts = messages
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content || '').trim())
    .filter(Boolean);
  if (!userTexts.length) return null;
  let merged;
  try {
    merged = await extendChapter(
      { title: ch.title, summary: ch.summary, excerpt: ch.excerpt, year: ch.year, stage: ch.stage },
      userTexts.join('\n'),
      { timeoutMs: 180000, allowFallback: false }
    );
  } catch (e) {
    console.warn('[interview] 章节聚焦融合失败（本次不落库，原文仍在 messages）：', e.message);
    return null;
  }
  if (!merged || !String(merged.summary || '').trim()) {
    console.warn('[interview] 章节聚焦融合未产出正文，跳过（不把这一节写空）');
    return null;
  }
  const title = correctText(merged.title || ch.title || '', targetId);
  const summary = correctText(merged.summary, targetId);
  const excerpt = correctText(merged.excerpt || ch.excerpt || '', targetId);
  const year = Number.isFinite(merged.year) ? merged.year : (ch.year == null ? null : ch.year);
  // 🔴 AI 融合会重写整章正文（2026-10-04）：覆盖前必须留痕。
  //   这条路径最容易漏 —— 用户看不到自己"改"了，是 AI 在覆盖。
  //   source='ai_extend' 便于日后区分"人改的"与"AI 改的"。
  require('./chapter-history').snapshotChapter(cid, interview.user_id, 'ai_extend', '🎙 接着聊（AI 融合）');
  db.prepare(
    "UPDATE memoir_chapters SET title = ?, summary = ?, excerpt = ?, year = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(title || ch.title, summary, excerpt, year, cid);
  // 🔗 原话追溯（2026-10-04）：把本窗口的用户原话与原音挂到本章，章节页可回看/回听
  linkSourceMessages(cid, messages.filter((m) => m.role === 'user' && m.id).map((m) => m.id));
  const updated = db.prepare('SELECT * FROM memoir_chapters WHERE id = ?').get(cid);
  return { ...updated, appended: false, focused: true };
}

function upsertChapter(personId, ch) {
  ensureChapterColumns();
  const stage = ch.stage || 'life';
  const year = Number.isFinite(ch.year) ? ch.year : null;
  const title = correctText(ch.title || '', personId);
  const summary = correctText(ch.summary || '', personId);
  const excerpt = correctText(ch.excerpt || '', personId);
  if (!summary && !excerpt) return null;
  // 标题兜底：用阶段名（如「童年时光」）+ 年份，比「人生的一段回忆」有信息量
  const fallbackTitle = (STAGE_TITLE[stage] || '人生的一段回忆') + (year ? '（' + year + '）' : '');
  const info = db.prepare(
    'INSERT INTO memoir_chapters(person_id, title, summary, excerpt, visibility, stage, year, sort_order) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(personId, title || fallbackTitle, summary, excerpt, 'family', stage, year, Date.now());
  const newId = Number(info.lastInsertRowid);
  // 🔗 原话追溯（2026-10-04）：把本窗口的用户原话回写 messages.chapter_id，
  // 章节页才能展开「我当时说过的话」。只标记未归属的，不覆盖历史归属。
  linkSourceMessages(newId, ch.sourceMessageIds);
  return { id: newId, title: title || fallbackTitle, summary, excerpt, stage, year, appended: false };
}

// 把源消息挂到章节上（原话追溯的公共实现，失败绝不影响正文落库）
// 同时把该批消息对应的原音也挂到同一章 —— 章节页要能"看原话 + 听原音"一起出现。
function linkSourceMessages(chapterId, ids) {
  if (!chapterId || !Array.isArray(ids) || !ids.length) return;
  const list = ids.filter((x) => Number.isInteger(x) && x > 0);
  if (!list.length) return;
  try {
    db.prepare(
      `UPDATE messages SET chapter_id = ? WHERE id IN (${list.map(() => '?').join(',')}) AND chapter_id IS NULL`
    ).run(chapterId, ...list);
  } catch (e) {
    console.warn('[interview] 原话回写章节关联失败（不影响正文）:', e.message);
  }
  try {
    db.prepare(
      `UPDATE audio_clips SET chapter_id = ? WHERE message_id IN (${list.map(() => '?').join(',')}) AND chapter_id IS NULL`
    ).run(chapterId, ...list);
  } catch (e) {
    console.warn('[interview] 原音回写章节关联失败（不影响正文）:', e.message);
  }
}

function applyReview(interviewId, facts) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) throw new Error('访谈不存在');
  const targetId = interview.target_person_id;

  const target = targetId ? getPerson(targetId) : null;
  const guard = sanitizeFacts(facts, target);
  if (guard.warnings.length) console.warn('[ingest-guard] applyReview:', guard.warnings.join(' | '));
  facts = guard.safeFacts;
  if (targetId && facts.person) {
    applyPersonFields(targetId, facts.person);
    mergePersonProfile(targetId, facts.person);
    // 复核确认后持久化到 covered_fields（防重复问）
    db.addCoveredFields(targetId, Object.keys(facts.person).map((k) => 'person.' + k));
  }
  const coveredRelReview = [];
  for (const r of facts.relations || []) {
    const relGender =
      r.gender ||
      (['father', 'son', 'grandfather', 'grandson', 'brother', 'maternal-grandfather'].includes(r.rel) ? '男'
        : ['mother', 'daughter', 'grandmother', 'granddaughter', 'sister', 'maternal-grandmother'].includes(r.rel) ? '女' : '');
    let relPerson;
    const existing = (r.name) ? findRelMatch(targetId, r.rel, r.name) : null;
    if (existing) {
      relPerson = reconcilePersonAlias(existing, r.name);
      if (!relPerson.gender && relGender) {
        db.prepare("UPDATE persons SET gender = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(relGender, relPerson.id);
        relPerson = getPerson(relPerson.id);
      }
    } else if (r.name) {
      const e = ensurePerson(r.name, relGender, 'pending_claim', r.name, interview.user_id, interview.id);
      relPerson = e.person;
    } else {
      continue;
    }
    if (r.name) coveredRelReview.push('relation.' + r.rel + '.name');
    if (r.note) mergePersonProfile(relPerson.id, { profile: { note: r.note } });

    if (!r.rel || r.rel === 'spouse') {
      addEdge(targetId, relPerson.id, 'spouse');
      addEdge(relPerson.id, targetId, 'spouse');
    } else if (r.rel === 'father' || r.rel === 'mother' || r.rel === 'grandfather' || r.rel === 'grandmother' || r.rel === 'maternal-grandfather' || r.rel === 'maternal-grandmother') {
      addEdge(relPerson.id, targetId, 'parent');
      if (r.rel === 'grandfather' || r.rel === 'maternal-grandfather') {
        const father = findExistingRelNode(targetId, 'father');
        if (father && father.person.name && father.person.name !== relPerson.name) addEdge(relPerson.id, father.person.id, 'parent');
      }
      if (r.rel === 'grandmother' || r.rel === 'maternal-grandmother') {
        const mother = findExistingRelNode(targetId, 'mother');
        if (mother && mother.person.name && mother.person.name !== relPerson.name) addEdge(relPerson.id, mother.person.id, 'parent');
      }
    } else if (r.rel === 'son' || r.rel === 'daughter' || r.rel === 'grandson' || r.rel === 'granddaughter') {
      addEdge(targetId, relPerson.id, 'parent');
      if (r.rel === 'grandson' || r.rel === 'granddaughter') {
        const son = findExistingRelNode(targetId, 'son');
        const daughter = findExistingRelNode(targetId, 'daughter');
        const child = son || daughter;
        if (child && child.person.name && child.person.name !== relPerson.name) addEdge(child.person.id, relPerson.id, 'parent');
      }
    } else {
      addEdge(targetId, relPerson.id, 'acquaintance', r.rel || '');
    }

    dedupeRelNodes(targetId, r.rel);
  }
  if (coveredRelReview.length) db.addCoveredFields(targetId, coveredRelReview);

  const confirmedPaths = [];
  if (facts.person) {
    for (const k of Object.keys(facts.person)) {
      if (['career', 'organizations', 'hobbies', 'places', 'life_events'].includes(k)) {
        if (Array.isArray(facts.person[k])) facts.person[k].forEach((_, i) => confirmedPaths.push(`person.${k}[${i}]`));
      } else {
        confirmedPaths.push('person.' + k);
      }
    }
  }
  (facts.relations || []).forEach((r, i) => {
    for (const k of Object.keys(r)) {
      if (r[k] !== undefined && r[k] !== '') confirmedPaths.push(`relations[${i}].${k}`);
    }
  });
  (facts.link_names || []).forEach((_, i) => confirmedPaths.push(`link_names[${i}]`));
  const insConf = db.prepare('INSERT OR IGNORE INTO interview_confirmed(interview_id, path) VALUES(?, ?)');
  for (const p of confirmedPaths) insConf.run(interviewId, p);

  return { ok: true };
}

function getMessages(interviewId) {
  return db.prepare('SELECT id, role, content, created_at FROM messages WHERE interview_id = ? ORDER BY id').all(interviewId);
}

module.exports = {
  startInterview,
  sendMessage,
  resayMessage,
  finishInterview,
  applyExtraction,
  applyReview,
  getMessages,
  getGraph,
  invalidateGraphCache,
  getPerson,
  findPersonByName,
  findPersonByAlias,
  findRelMatch,
  reconcilePersonAlias,
  ensurePerson,
  ensureSelfNode,
  normAlias,
  relLabel,
  mergePersons,
  linkRelatives,
  upsertChapter,
  splitSegmentsByTopicShift,
  correctText,
};
