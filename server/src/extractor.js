// server/src/extractor.js
// ============================================================
// 第二层（解耦层）：统一的"静默抽取"入口
// ------------------------------------------------------------
// 设计目标：把"从用户话语里抽取结构化家谱信息"这件事，从聊天流里
// 彻底拆出来，成为单一职责的模块。无论真实模型还是演示模式，都走
// 同一个 extractFromText()，结果统一过第一层(extract-rules.js)的
// 校验闸门（normalize + isLikelyName 复核），保证"抽取口径一致"。
//
// 第二层相对第一层的升级：
//   1) 真实模型走【独立的轻量抽取调用】——专用 schema，只抽取不聊天，
//      与倾听者回复（runInterview 里的 reply）解耦。
//   2) 抽取 prompt 带【few-shot 反例】，把第一层踩过的坑（K1-K6）用
//      自然语言+示例喂给模型，从源头减少"2008结婚当出生""江苏武进人当姓名"。
//   3) 模型返回后再过第一层硬规则闸门（normalizeExtract + isLikelyName），
//      双保险：模型犯的错，规则兜底拦；规则兜不住的，模型理解补。
// ============================================================

const { getLLMConfig } = require('./config');
const {
  ruleExtract,
  buildRuleReview,
  augmentMissingFamilyNames,
  relLabel,
  normalizeExtract,
  isLikelyName,
  isLikelyPlace,
  isJunkListItem,
} = require('./extract-rules');

// ---------- 抽取输出的 JSON 契约 ----------
// ⚠️ 重大变更（2026-09-13）：
//   原先走 OpenAI function-calling（tools + tool_choice）。实测发现 **TokenHub 的 hy3 模型
//   不支持 tools 参数** —— 只要请求体带 tools，上游必返 HTTP 502 upstream_error，
//   导致【每一轮抽取都失败并静默降级为正则保底】（问句路径不带 tools，所以聊天一直正常）。
//   证据：同一把 key、同一句内容，仅增删 tools 即 200 与 502 的差别；
//   且 hy4-preview / glm-5.3 / minimax-m3 支持 tools，而 deepseek-v4-pro、
//   deepseek-flash、kimi-k3 分别因 tool_choice/temperature 报 400。
//   决策（用户 2026-09-13 选 A）：改为**纯 JSON 模式** —— 不用 tools，
//   把 schema 以文字契约写进 system prompt，从 message.content 里解析 JSON。
//   好处：继续用 hy3（快、已验证可用），改动仅限本文件。
//   ⚠️ 副作用：失去 schema 的 enum 强约束，模型可能回英文 gender（male/female）、
//      或超出 rel 取值 —— 已在 extract-rules.js 的 normGender / REL_TYPES 兜底。
const EXTRACTION_SCHEMA_TEXT = `{
  "person": {
    "name": "本人姓名（用户明确自报时才有）",
    "gender": "只能是 男 或 女 或 空字符串（必须用中文，不要用 male/female）",
    "birth_date": "出生年份/日期，仅当用户明确说出生时才填",
    "death_date": "去世日期，通常留空",
    "birthplace": "籍贯/出生地",
    "residence": "现居地",
    "occupation": "职业",
    "education": "学历/学校",
    "bio": "一句话概述，可留空",
    "career": [ { "year": "年份或年代", "org": "单位/学校", "role": "职务/身份", "detail": "简述" } ],
    "organizations": ["单位或组织名"],
    "hobbies": ["爱好"],
    "places": ["与本人相关的地点（只填真实地名，如 芜湖、新疆、东北；形容程度的短语一律不准填，例如『起到了很重要的作用』里的『很重』不是地名）"],
    "life_events": ["人生事件，如 2008年结婚"]
  },
  "relations": [
    {
      "rel": "只能取以下之一：father|mother|spouse|son|daughter|brother|sister|grandfather|grandmother|maternal-grandfather|maternal-grandmother|grandson|granddaughter|friend|colleague|teacher|neighbor|other",
      "name": "亲属姓名，未提及则留空字符串，绝不编造",
      "gender": "只能是 男 或 女 或 空字符串（必须用中文）",
      "note": "用户顺嘴提到的亲属背景，如 我爸是老兵；仅备注，不追问"
    }
  ],
  "link_names": ["角色不明但被提到的家族成员姓名"]
}`;

// 保留导出名以兼容既有引用（其内容已不再是 function tool，而是一段说明文本）
const EXTRACTION_TOOL = { type: 'json-contract', schema: EXTRACTION_SCHEMA_TEXT };

// ---------- 带有 few-shot 反例的抽取系统提示 ----------
// 把第一层沉淀的 K1-K6 踩坑经验，用"正例/反例"形式喂给模型
function buildExtractionSystemPrompt(knownPersons, targetName, confirmed) {
  const catalog = knownPersons && knownPersons.length
    ? knownPersons
        .map((p) => `- ${p.name}（${p.gender || '未知'}${(p.status === 'stub' || p.status === 'pending_claim') ? '，待补全' : ''}）`)
        .join('\n')
    : '（暂无已知成员）';

  const confirmedList = confirmed && confirmed.length
    ? confirmed.map((p) => `- ${p}`).join('\n')
    : '（尚无）';
  const CONFIRMED_HINT = `下面这些【用户已经当面确认过】的字段，本次抽取不要再次列入复核清单，除非用户主动提到要改它：
${confirmedList}`;

  return `你是家谱信息抽取器。给定一段长辈的口述，输出结构化 JSON。不要寒暄、不要回应，只抽取。

已知家族成员（若用户提起其中某人，用 relations/link_names 关联，勿重复新建）：
${catalog}

${CONFIRMED_HINT}

【铁律 · 绝对不能犯的错误（每条都带反例）】：
1. 出生年份只认"我出生于X年/我X年出生/我的生日是X年"这类明确说法。"我2008年结婚""2008年工作"的事件年份，绝不等于 birth_date —— 应放入 life_events 或 career。
   ❌ 反例：用户说"我2008年结婚" → 绝不能把 2008 填进 person.birth_date。
   ✅ 正例：用户说"我出生于1949年" → person.birth_date = "1949"。
2. 姓名必须像人名。"江苏武进人""苏州人""家族里的老大""我父亲是做老师的"这些【不是姓名】，绝不能填进任何 name 字段。籍贯/描述走 birthplace。
   ❌ 反例：用户说"我父亲是江苏武进人" → relations[0].name 绝不能填"江苏武进人"，应填 father 的姓名（若未提及则留空），birthplace 填"江苏武进"。
   ❌ 反例：用户说"我的父亲名字叫李冰伟" → 李冰伟是【父亲】的名字，绝不能同时当成【本人】的 name。
   ✅ 正例：用户说"我叫李烨" → person.name = "李烨"。
3. 关系人（配偶/父母/子女）姓名必须列进输出；若用户只说了关系没说名字，name 留空字符串，不要编造。
4. 亲属节点只保留【姓名 + 关系 + 性别 + note（顺嘴提到的背景）】。不要采集亲属的生日、籍贯、单位、职业、住址等深度字段——这些属于亲属自己的传记，不是讲述者这篇传记该挖的。若用户顺嘴说"我爸是老兵"，把"老兵"放进 note 即可，不要问"爸哪年当兵、打过哪些仗"。
5. 配偶、父母、子女的性别按关系推断默认（父男/母女/儿男/女女），但用户明确说的以用户为准。
6. 兄弟姐妹是【平辈】，绝不可标成 son/daughter！用户说"我弟弟/哥哥/姐姐/妹妹" → rel 必须是 brother/sister；只有"我儿子/女儿"才标 son/daughter。误把弟弟标成 son 会导致家谱代际错乱。
7. 祖父母辈：用户说"我爷爷/祖父" → grandfather，"我奶奶/祖母" → grandmother，"我外公" → maternal-grandfather，"我外婆" → maternal-grandmother。
8. 绝不要编造信息。未提及的字段一律留空字符串或空数组。
9. 【places 只填真实地名】形容程度/性质的短语不是地名。
   ❌ 反例：用户说"画画技术对我日后选择建筑学专业起到了很重要的作用" → 绝不能把"很重"填进 places，正确的做法是【不填任何地点】，因为这句话里没有地名。
   ✅ 正例：用户说"我后来搬到了芜湖" → places 填"芜湖"。
   同理"对我帮助很大""影响很深"这类短语都不产生地点。

【输出格式 · 必须严格遵守】：
只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块围栏、不要前后缀说明。
必须包含 person 和 relations 两个顶层字段（以及可选的 link_names）。结构如下：
${EXTRACTION_SCHEMA_TEXT}

现在开始抽取。记住：只输出 JSON，第一个字符必须是 {，最后一个字符必须是 }。`;
}

// ---------- 模型专用抽取调用（与聊天解耦，纯 JSON 模式） ----------
// 从模型回复的 content 里稳健地抠出 JSON 对象：
// 依次尝试 ① 直接 parse ② 去掉 ```json 围栏 ③ 截取首个 { 到末个 }
// ④ 截断修复（hy3 是推理模型，reasoning_content 常吃掉 1600-2700 token，
//    若 max_tokens 偏小或响应被截断，content 会停在半个 JSON 上，此时补齐闭合符号）
function repairTruncatedJson(s) {
  // 从末尾回删到最近一个完整的 "key": value 边界，再补齐括号
  let t = s;
  for (let cut = 0; cut < 400 && t.length > 2; cut++) {
    const cand = t + '"'.repeat(0);
    // 统计未闭合的引号与括号
    let inStr = false, esc = false, depthCurly = 0, depthBrack = 0;
    for (let i = 0; i < cand.length; i++) {
      const ch = cand[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depthCurly++;
      else if (ch === '}') depthCurly--;
      else if (ch === '[') depthBrack++;
      else if (ch === ']') depthBrack--;
    }
    let fixed = cand;
    if (inStr) fixed += '"';
    // 去掉尾部悬挂的 , 或 "key": 之类不完整片段
    fixed = fixed.replace(/,\s*$/, '').replace(/:\s*$/, ':""').replace(/"\s*:\s*"$/, '":""');
    fixed += ']'.repeat(Math.max(0, depthBrack)) + '}'.repeat(Math.max(0, depthCurly));
    try {
      const o = JSON.parse(fixed);
      if (o && typeof o === 'object') return o;
    } catch (_) { /* 再删一个字符重试 */ }
    t = t.slice(0, -1);
  }
  return null;
}

function parseJsonLoose(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const attempts = [];
  attempts.push(s);
  // 去 Markdown 代码块围栏
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) attempts.push(fenced[1].trim());
  // 截取首个 { 到末个 }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) attempts.push(s.slice(a, b + 1));
  for (const t of attempts) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') return o;
    } catch (_) { /* 试下一种 */ }
  }
  // 全部失败 → 尝试截断修复（取首个 { 之后的部分）
  const fromBrace = a >= 0 ? s.slice(a) : s;
  return repairTruncatedJson(fromBrace);
}

async function modelExtract(messages, knownPersons, targetName, confirmedPaths, signal) {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) throw new Error('no-api-key');
  // ⚠️ 绝不带 tools / tool_choice —— hy3 不支持，会 502（见文件头说明）
  // 也不设 max_tokens：hy3 是推理模型，reasoning_content 可能占 2000+ token，
  // 设小了会导致 content 被截断成半个 JSON。
  const body = {
    model: cfg.model || 'hy3',
    messages,
    temperature: 0.2, // 抽取要稳，低温减少幻觉
  };
  const controller = new AbortController();
  let externalAbort;
  if (signal) {
    if (signal.aborted) controller.abort();
    else { externalAbort = () => controller.abort(); signal.addEventListener('abort', externalAbort); }
  } else {
    controller._timer = setTimeout(() => controller.abort(), 30000);
  }
  let data;
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    data = await res.json();
  } finally {
    if (controller._timer) clearTimeout(controller._timer);
    if (externalAbort) signal.removeEventListener('abort', externalAbort);
  }
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) return null;
  // 兼容：万一某模型仍回 tool_calls（本项目已不发 tools，此处仅兜底）
  const tc = msg.tool_calls && msg.tool_calls[0];
  if (tc && tc.function && tc.function.name === 'submit_extraction') {
    const viaTool = parseJsonLoose(tc.function.arguments || '{}');
    if (viaTool) return viaTool;
  }
  return parseJsonLoose(msg.content);
}

// ---------- 公共入口：从单条用户文本抽取（解耦后的唯一抽取入口） ----------
// 返回 normalizeExtract 后的 { person, relations, link_names, review }
async function extractFromText(text, { knownPersons = [], targetName = '', target = null, confirmedPaths = [], signal = null } = {}) {
  const cfg = getLLMConfig();
  let rawExtract = null;

  if (!cfg.demoMode && cfg.apiKey) {
    try {
      const confirmed = confirmedPaths instanceof Set ? [...confirmedPaths] : (confirmedPaths || []);
      const sys = { role: 'system', content: buildExtractionSystemPrompt(knownPersons, targetName, confirmed) };
      const userMsg = { role: 'user', content: text };
      rawExtract = await modelExtract([sys, userMsg], knownPersons, targetName, confirmed, signal);
    } catch (e) {
      console.error('[extractor] 真实模型抽取失败，降级规则保底：', e.message);
      rawExtract = null;
    }
  }

  // 演示模式 / 真实模型失败 / 真实模型返回空 → 用第一层规则保底
  if (!rawExtract) {
    rawExtract = ruleExtract(text, targetName);
  }

  // 统一过校验闸门：normalize（截断/类型归一）+ isLikelyName 复核（防模型漏过姓名误抓）
  const normalized = normalizeExtract(rawExtract);

  // 二次闸门：对 relations.name / person.name 再过 isLikelyName，模型若漏掉则清掉
  if (normalized.person.name && !isLikelyName(normalized.person.name)) {
    // 本人姓名误抓（极少见，规则层已挡，这里兜底）
    if (!targetName) normalized.person.name = '';
  }
  for (const r of normalized.relations) {
    if (r.name && !isLikelyName(r.name)) r.name = '';
  }

  // review 清单：规则生成（含已确认过滤 + 关系人去重）
  const confirmed = confirmedPaths instanceof Set ? confirmedPaths : new Set(confirmedPaths || []);
  let review = buildRuleReview(normalized, confirmed);
  // 真实模型可能漏掉关键亲属姓名（K6），用规则兜底补全
  review = augmentMissingFamilyNames(review, text, confirmedPaths);

  normalized.review = review;
  return normalized;
}

module.exports = { extractFromText, buildExtractionSystemPrompt, EXTRACTION_TOOL, relLabel, parseJsonLoose };
