// server/src/ingest-guard.js
// 第三层 —— 入库前校验兜底（最后一道闸）
//
// 第一层（extract-rules.js）：轻规则保底抽取 + 校验闸门 normalizeExtract
// 第二层（extractor.js）：抽取调用与聊天解耦，专用 schema + 反例 few-shot
// 第三层（本文件）：抽取/复核结果真正写进数据库之前，再拦一道闸 ——
//   绝不能让脏数据落库：非姓名当姓名、本人名错挂关系、性别脏值、非法日期、
//   重复关系、空维度污染 profile。
//
// 设计原则：
//   - 守卫是"硬闸"——非法项直接清零/剔除，而非抛错阻断访谈体验。
//   - 被拦截/修正的项记入 warnings（调用方可记录日志、前端可提示）。
//   - 不依赖数据库，纯函数，便于单测；target 仅用于"本人防护"判断。

const {
  isLikelyName,
  cleanName,
  formatDate,
} = require('./extract-rules');

// 关系类型白名单（与 interview.js / db CHECK 约束一致）
const REL_TYPES = ['father', 'mother', 'son', 'daughter', 'brother', 'sister', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother', 'grandson', 'granddaughter', 'spouse', 'friend', 'colleague', 'teacher', 'neighbor', 'other'];

const PERSON_STRING_FIELDS = ['name', 'gender', 'birth_date', 'death_date', 'birthplace', 'residence', 'occupation', 'education', 'bio'];
const PERSON_ARRAY_FIELDS = ['career', 'organizations', 'hobbies', 'places', 'life_events'];

// ---------------------------------------------------------------------------
// 工具：性别归一
function normalizeGender(g) {
  if (g === '男' || g === '女') return g;
  if (typeof g === 'string') {
    if (/男/.test(g)) return '男';
    if (/女/.test(g)) return '女';
  }
  return '';
}

// 工具：日期归一（仅 YYYY / YYYY-MM / YYYY-MM-DD）
// 🔴 修复（2026-09-13）：改为纯 JSON 抽取后，模型会自然回中文日期（"1953年"、"1953年5月"），
//   原正则 /^\d{4}(-\d{1,2}(-\d{1,2})?)?$/ 只认裸数字，导致这类**正确信息被静默清空**
//   （日志: [日期归一] 非法出生日期被清空: "1953年"）。先剥离中文年月日再校验。
function normalizeDate(d) {
  if (!d) return '';
  let s = String(d).trim();
  // 剥离中文/全角日期单位，统一为 YYYY-MM-DD 形态
  s = s.replace(/[年]/g, '-').replace(/[月]/g, '-').replace(/[日号]/g, '')
       .replace(/[．。]/g, '-')
       .replace(/-+$/, '')                     // 去掉结尾残留的 -
       .replace(/^-+/, '');                    // 去掉开头残留的 -
  // 处理"1953-5-"这类中间空段
  s = s.split('-').filter((x) => x !== '').join('-');
  if (!/^\d{4}(-\d{1,2}(-\d{1,2})?)?$/.test(s)) return '';
  // 借 formatDate 做补全校验
  const parts = s.split('-');
  const out = formatDate(parts[0], parts[1], parts[2]);
  return out || '';
}

// 工具：清洗单个人物对象（本人节点或关系人）
function sanitizePersonObject(person, targetName, warnings, ctx) {
  if (!person || typeof person !== 'object') return null;
  const out = {};

  // 姓名终审：isLikelyName 否决 → 当非姓名剔除
  let name = (person.name || '').toString().trim();
  if (name) {
    name = cleanName(name);
    if (!isLikelyName(name)) {
      warnings.push(`[姓名终审] 疑似非姓名被剔除: "${name}" (来源:${ctx})`);
      name = '';
    }
  }
  if (!name && !person.__allowEmptyName) {
    // 没有任何可用姓名：整个对象无意义（关系人必须有名才能建节点）
    return null;
  }
  out.name = name;

  // 性别
  out.gender = normalizeGender(person.gender);

  // 日期
  out.birth_date = normalizeDate(person.birth_date);
  out.death_date = normalizeDate(person.death_date);
  if (person.birth_date && !out.birth_date) {
    warnings.push(`[日期归一] 非法出生日期被清空: "${person.birth_date}" (${ctx})`);
  }

  // 其他字符串字段：去空白截断
  for (const k of ['birthplace', 'residence', 'occupation', 'education', 'bio']) {
    out[k] = (person[k] || '').toString().trim().slice(0, k === 'bio' ? 1000 : 60);
  }

  // 数组维度清洗
  for (const k of PERSON_ARRAY_FIELDS) {
    if (k === 'career') {
      if (Array.isArray(person.career)) {
        out.career = person.career
          .filter((c) => c && (c.year || c.org || c.role || c.detail))
          .map((c) => ({
            year: (c.year || '').toString().trim().slice(0, 40),
            org: (c.org || '').toString().trim().slice(0, 80),
            role: (c.role || '').toString().trim().slice(0, 60),
            detail: (c.detail || '').toString().trim().slice(0, 200),
          }))
          .slice(0, 50);
      }
    } else if (Array.isArray(person[k])) {
      out[k] = person[k]
        .map((x) => (typeof x === 'string' ? x.trim() : (x && x.toString ? x.toString().trim() : '')))
        .filter(Boolean)
        .slice(0, 50);
    }
  }

  // profile 透传（对象）
  if (person.profile && typeof person.profile === 'object') {
    out.profile = person.profile;
  }

  return out;
}

// 工具：relations 去重（同名同 rel 合并，保留首个，后续补充字段）
function dedupeRelations(relations, warnings) {
  const seen = new Map(); // key: rel|name(小写) -> index
  const out = [];
  for (const r of relations || []) {
    if (!r || !r.name) continue;
    const key = `${r.rel || 'other'}|${cleanName(r.name).toLowerCase()}`;
    if (seen.has(key)) {
      const idx = seen.get(key);
      // 合并空字段：base 为空/未定义则用 r 的非空值补
      const base = out[idx];
      for (const [k, v] of Object.entries(r)) {
        if (v && (!base[k] || base[k].toString().trim() === '')) base[k] = v;
      }
      warnings.push(`[关系去重] 同名同关系合并: ${r.rel}/${r.name}`);
      continue;
    }
    seen.set(key, out.length);
    out.push({ ...r });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入口1：自动抽取落库前校验
function sanitizeExtract(extract, target, relayMode) {
  const warnings = [];
  const isRelay = !!relayMode;
  if (!extract || typeof extract !== 'object') return { safeExtract: { person: {}, relations: [], link_names: [] }, warnings };

  const targetName = (target && (target.name || '')).toString().trim();

  // 代录关系线模式：target 就是被代录的亲属节点（如「李斌伟」），
  // 此时本人防护的"本人"反而是当前登录用户(self)，而非 target。
  // 因此把本人防护的基准切换为 self（即访谈发起者），避免把"用户提及 TA 的名字"误判为本人同名。
  // 这里 targetName 仍传 target 名用于非代录场景；代录时由调用方传入真正的本人名作为 selfName。
  const selfName = (relayMode && relayMode.selfName) ? String(relayMode.selfName).trim() : targetName;

  // 本人节点（代录模式下不处理本人节点字段，留给正常访谈流程）
  let person = isRelay ? {} : (sanitizePersonObject(extract.person, targetName, warnings, 'person') || {});

  if (!isRelay) {
    // 本人防护：本人姓名兜底（抽取没抽到名字但 target 有）
    if (targetName && !person.name) {
      person.name = cleanName(targetName);
    }
  }

  // 关系人列表：逐条清洗 + 本人防护（关系人若与本人同名 → 不建关系节点）
  const cleanRels = [];
  const relList = dedupeRelations(extract.relations, warnings);
  for (const r of relList) {
    if (!r || !r.name) continue;
    const rname = cleanName(r.name);
    // 本人防护：关系人名 == 本人名 → 跳过（防止"把父亲名当自己"或反向错挂）
    if (selfName && rname.toLowerCase() === cleanName(selfName).toLowerCase()) {
      warnings.push(`[本人防护] 关系人姓名与本人相同，已跳过: "${rname}" (rel=${r.rel})`);
      continue;
    }
    const rel = REL_TYPES.includes(r.rel) ? r.rel : 'other';
    const relGender = r.gender || (rel === 'father' || rel === 'son' ? '男' : rel === 'mother' || rel === 'daughter' ? '女' : '');
    // 亲属节点只保留轻量关系线：姓名 + 关系 + 性别 + note（顺嘴背景）
    // 生日/籍贯/单位/职业等深度字段属于亲属自己的传记，不在讲述者篇挖掘
    const sPerson = sanitizePersonObject(
      { name: rname, gender: relGender },
      targetName,
      warnings,
      `relation.${rel}`
    );
    if (!sPerson) continue; // 非姓名被剔除
    const item = { rel, name: sPerson.name, gender: sPerson.gender };
    if (r.note) item.note = String(r.note).trim().slice(0, 100);
    cleanRels.push(item);
  }

  // link_names：仅保留库内真实存在名的引用（清洗 + isLikelyName）
  const linkNames = (extract.link_names || [])
    .map((n) => cleanName(String(n).trim()))
    .filter((n) => n && isLikelyName(n) && (!targetName || n.toLowerCase() !== cleanName(targetName).toLowerCase()));

  // review：剔除已被本人防护/非姓名拒绝的脏项（防脏值进复核框）
  let review = Array.isArray(extract.review) ? extract.review : [];
  review = review
    .filter((x) => x && x.label && x.value)
    .map((x) => ({ label: String(x.label).slice(0, 40), value: String(x.value).slice(0, 120), path: String(x.path || '').slice(0, 80) }))
    .filter((x) => {
      // review.value 不应是非姓名（除非 label 明显是籍贯/描述类）
      if (/姓名|叫什么|名字/.test(x.label) && !isLikelyName(cleanName(x.value))) {
        warnings.push(`[复核框净化] 非姓名被移出复核框: label="${x.label}" value="${x.value}"`);
        return false;
      }
      return true;
    })
    .slice(0, 60);

  return {
    safeExtract: isRelay ? { person: {}, relations: cleanRels, link_names: [], review: [] } : { person, relations: cleanRels, link_names: linkNames, review },
    warnings,
  };
}

// 入口2：人工复核落库前校验（双保险，模型预填的 facts 也可能带偏）
function sanitizeFacts(facts, target) {
  const warnings = [];
  if (!facts || typeof facts !== 'object') return { safeFacts: { person: {}, relations: [] }, warnings };

  const targetName = (target && (target.name || '')).toString().trim();
  let person = sanitizePersonObject(facts.person, targetName, warnings, 'person') || {};
  if (targetName && !person.name) person.name = cleanName(targetName);

  const cleanRels = [];
  const relList = dedupeRelations(facts.relations, warnings);
  for (const r of relList) {
    if (!r || !r.name) continue;
    const rname = cleanName(r.name);
    if (targetName && rname.toLowerCase() === cleanName(targetName).toLowerCase()) {
      warnings.push(`[本人防护] 复核关系人姓名与本人相同，已跳过: "${rname}" (rel=${r.rel})`);
      continue;
    }
    const rel = REL_TYPES.includes(r.rel) ? r.rel : 'other';
    const relGender = r.gender || (rel === 'father' || rel === 'son' ? '男' : rel === 'mother' || rel === 'daughter' ? '女' : '');
    // 亲属节点只保留轻量关系线：姓名 + 关系 + 性别 + note
    const sPerson = sanitizePersonObject(
      { name: rname, gender: relGender },
      targetName, warnings, `relation.${rel}`
    );
    if (!sPerson) continue;
    const item = { rel, name: sPerson.name, gender: sPerson.gender };
    if (r.note) item.note = String(r.note).trim().slice(0, 100);
    cleanRels.push(item);
  }

  const linkNames = (facts.link_names || [])
    .map((n) => cleanName(String(n).trim()))
    .filter((n) => n && isLikelyName(n) && (!targetName || n.toLowerCase() !== cleanName(targetName).toLowerCase()));

  return {
    safeFacts: { person, relations: cleanRels, link_names: linkNames },
    warnings,
  };
}

module.exports = {
  sanitizeExtract,
  sanitizeFacts,
  normalizeGender,
  normalizeDate,
  dedupeRelations,
  REL_TYPES,
};
