// server/src/extract-rules.js
// ============================================================
// 第一层（保底层）：轻规则抽取模块
// ------------------------------------------------------------
// 设计目标：用确定性的正则 + 语义约束，解决"板上钉钉错"的抽取问题，
// 不负责理解，只负责不犯低级错。这是后续"模型抽取层 / 校验层"的基础。
//
// 沉淀的踩坑经验（每条都在 test/extract-rules.test.js 有回归用例）：
//   K1 生日误抓 —— "我2008年结婚"的年份不能当 birth_date
//   K2 名字误抓 —— 籍贯（"江苏武进人"）、描述（"家族里的老大"）不能当姓名；
//                  父亲名字不能误抓成本人姓名
//   K3 籍贯误抓 —— "是XX人"优先走 birthplace，不污染 relations.name
//   K4 关系人去重 —— 同 rel 多次提及只生成一个条目
//   K5 口语日期 —— "1951年的7月2号"要能正确解析
//   K6 配偶漏抽 —— 真实模型可能漏掉配偶姓名，需规则兜底（见 augmentMissingFamilyNames）
// ============================================================

// ---------- 基础工具 ----------

// 清洗名字片段：去标点/引号/括号/空白，截到首个句末标点之前，最长 12 字
function cleanName(s) {
  if (!s) return '';
  return s
    .replace(/[「」""''【】()（）\s]/g, '')
    .replace(/[，。！？、；：,.!?;:\s].*$/, '')
    .trim()
    .slice(0, 12);
}

// K2：判断一个字符串是否"像人名"，而非籍贯/描述/代词/身份词
// 这是防误抓的核心闸门——所有关系人/本人名字在写入前都必须过这一关
function isLikelyName(s) {
  if (!s || s.length < 2 || s.length > 8) return false;
  // 拒绝以代词/地名/亲属称谓/排行开头的内容（如"江苏""家族""父亲""老大"）
  const denyPrefix =
    /^(我|你|他|她|它|这|那|谁|什么|哪里|江苏|苏州|上海|北京|广州|深圳|杭州|南京|成都|武汉|西安|重庆|天津|浙江|安徽|山东|河南|河北|湖南|湖北|福建|江西|辽宁|吉林|黑龙江|山西|陕西|四川|云南|贵州|甘肃|青海|宁夏|新疆|西藏|内蒙古|广西|广东|海南|家族|家里|父亲|母亲|爸爸|妈妈|老公|老婆|丈夫|妻子|儿子|女儿|兄弟|姐妹|哥哥|弟弟|姐姐|妹妹|老大|老二|老三|老四|老幺|最小|最大|独生子|独生女|男|女|男士|女士|先生|小姐|同志|师傅|老师)/;
  if (denyPrefix.test(s)) return false;
  // 拒绝以"人/的"等后缀结尾（避免"江苏武进人""家族里的老大"）
  if (/[人的了着过]$/.test(s)) return false;
  // 拒绝包含结构助词"的"（避免"家族里的老大"）
  if (/[的]/.test(s)) return false;
  // 至少包含两个中文字符（过滤掉单字或纯非中文）
  if (!/[\u4e00-\u9fa5][\u4e00-\u9fa5]/.test(s)) return false;
  return true;
}

// 地名专用清洗：先过通用 cleanName，再剥掉动词后被切进来的时态助词
// （"我后来搬到了芜湖" → 切出 "了芜湖" → 剥成 "芜湖"）
function cleanPlace(s) {
  return cleanName(s).replace(/^[了着过]/, '').trim();
}

// ---------- 列表项闸门：拒掉"形容词 / 抽象名词 / 半截短语"混进结构化条目 ----------
// 🔴 真实事故（2026-09-14，生产）：本人讲「画画技术对我日后选择建筑学专业起到了很重要的作用」，
//    句子里的「起到了」被当成旅行动词（"到了"），抽出地点「很重」→ 传记页显示「走过的地方：芜湖、很重」。
// 教训：模型层（JSON 模式）与规则层都可能犯这类"词面像地名、语义不是地名"的错，
//       必须在**归一化闸门**里做确定性拦截 —— prompt 说一百遍不如一道代码闸门。
const JUNK_ABSTRACT = /(?:重要|作用|影响|意义|价值|帮助|关系|问题|事情|时候|日子|时期|阶段|程度|水平|兴趣|意思|办法|东西|地方|感受|心情|情绪|变化|进步|发展|效果|结果|原因|理由|条件|基础|能力|经验|机会|希望|理想|目标|计划|想法|态度|责任|负担|压力|困难|风险|收获|成就|荣誉|身份|利益|好处|优点|缺点|特点|性质|本质|现象|规律|趋势|方向|方面|角度|范围|规模|数量|质量|速度|效率|力量|精神|习惯|传统|文化|知识|信息|故事|经历|记忆|回忆|印象|感觉)/;
// 程度副词/指示词开头 + 单个性质形容词结尾 = 典型形容词短语（很重、太重、更好、最好、真快…）
// 注意：只拦「副词+形容词」这一形态，不误伤「太原/大同/大理/大庆/小汤山」等真实地名（后半字不在性质字表里）。
const JUNK_DEGREE = /^(?:很|更|挺|超|蛮|贼|最|真|好|太|大|小|多|少)(?:重|轻|好|坏|大|小|多|少|快|慢|难|易|高|低|长|短|远|近|深|浅|早|晚|新|旧|强|弱|忙|累|穷|富|贵|冷|热)$/;

// 判断一个字符串是否"像地名"，而非形容词短语/抽象名词/半截句
// 放宽原则：宁可漏（用户可在页面自行补录），不可把废话当地名钉在传记上
function isLikelyPlace(s) {
  if (!s) return false;
  const v = String(s).trim();
  if (v.length < 2 || v.length > 15) return false;
  if (/[的了着过是]/.test(v)) return false;        // 地名不含结构助词/时态助词（"很重"不含，靠下一条拦）
  if (JUNK_DEGREE.test(v)) return false;            // 「很重」「太重」
  if (JUNK_ABSTRACT.test(v)) return false;          // 「重要作用」这类抽象名词
  if (/^(?:我|你|他|她|它|咱|这|那|谁|什么|哪)/.test(v)) return false; // 代词开头
  if (!/[\u4e00-\u9fa5]/.test(v)) return false;     // 至少含一个汉字
  return true;
}

// 结构化列表项的**轻量**除杂：去空白项 + 含助词的"半截短语" + 程度副词短语。
// 用于 hobbies / organizations / life_events / career 的数组字段。
// 刻意不套 JUNK_ABSTRACT —— 那是给 places 的强闸门；"听故事"这类合法爱好会误伤。
function isJunkListItem(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return true;
  if (/[的了着过]/.test(s)) return true;
  if (JUNK_DEGREE.test(s)) return true;
  return false;
}

// 把散装的年月日拼成统一格式：yyyy / yyyy-mm / yyyy-mm-dd
function formatDate(y, mo, d) {
  const m = mo ? String(mo).padStart(2, '0') : '';
  const day = d ? String(d).padStart(2, '0') : '';
  return m ? (day ? `${y}-${m}-${day}` : `${y}-${m}`) : String(y);
}

// K5：提取文本中所有"年份/年月/年月日"，支持口语"的"（1951年的7月2号）
function extractDates(text) {
  const dates = [];
  const re = /(\d{4})\s*年\s*的?\s*(?:\s*(\d{1,2})\s*月\s*的?\s*(?:\s*(\d{1,2})\s*[日号]?)?)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    dates.push({ index: m.index, y: m[1], mo: m[2], d: m[3] });
  }
  return dates;
}

// ---------- 关系人锚词 ----------

// 亲属锚词 → rel 类型 + 默认性别
const RELATION_ANCHORS = [
  { re: /(?:我爸|我父亲|爸爸|父亲)/g, rel: 'father', gender: '男' },
  { re: /(?:我妈|我母亲|妈妈|母亲)/g, rel: 'mother', gender: '女' },
  { re: /(?:我老公|我老婆|我丈夫|我妻子|老公|老婆|丈夫|妻子)/g, rel: 'spouse', gender: null },
  { re: /(?:我儿子|儿子)/g, rel: 'son', gender: '男' },
  { re: /(?:我女儿|女儿)/g, rel: 'daughter', gender: '女' },
  { re: /(?:我哥哥|哥哥)/g, rel: 'brother', gender: '男' },
  { re: /(?:我弟弟|弟弟)/g, rel: 'brother', gender: '男' },
  { re: /(?:我姐姐|姐姐)/g, rel: 'sister', gender: '女' },
  { re: /(?:我妹妹|妹妹)/g, rel: 'sister', gender: '女' },
  { re: /(?:我爷爷|爷爷|祖父)/g, rel: 'grandfather', gender: '男' },
  { re: /(?:我奶奶|奶奶|祖母)/g, rel: 'grandmother', gender: '女' },
  { re: /(?:我外公|外公)/g, rel: 'maternal-grandfather', gender: '男' },
  { re: /(?:我外婆|外婆|外祖母)/g, rel: 'maternal-grandmother', gender: '女' },
];

// 弱关系（朋友/同事/师长/邻居）：名字在角色词之前，如"老王是我的老战友"
const WEAK_RELATION_PATTERNS = [
  { re: /([^，。！？、；：""''「」\s]{1,10}?)\s*(?:是|为)\s*(?:我(?:的)?)?[^，。]{0,6}?朋友|老朋友|发小/g, rel: 'friend' },
  { re: /([^，。！？、；：""''「」\s]{1,10}?)\s*(?:是|为)\s*(?:我(?:的)?)?[^，。]{0,6}?同事|同(?:事|学)|工友/g, rel: 'colleague' },
  { re: /([^，。！？、；：""''「」\s]{1,10}?)\s*(?:是|为)\s*(?:我(?:的)?)?[^，。]{0,6}?师|老师|师傅/g, rel: 'teacher' },
  { re: /([^，。！？、；：""''「」\s]{1,10}?)\s*(?:是|为)\s*(?:我(?:的)?)?[^，。]{0,6}?邻居|隔壁/g, rel: 'neighbor' },
];
const WEAK_NAME_PREFIX = /^(?:我的|我的老|老|战友|老战友|我|咱|咱们|的|好|好哥们|哥们|发小|同学|工友)/;

// 关系类型 → 中文标签
const REL_LABELS = {
  father: '父亲', mother: '母亲', spouse: '配偶', son: '儿子', daughter: '女儿',
  brother: '兄弟', sister: '姐妹',
  grandfather: '祖父', grandmother: '祖母', 'maternal-grandfather': '外祖父', 'maternal-grandmother': '外祖母',
  grandson: '孙子', granddaughter: '孙女',
  friend: '朋友', colleague: '同事', teacher: '师长', neighbor: '邻居', other: '他人',
};
function relLabel(rel) {
  return REL_LABELS[rel] || rel;
}

// K4：定位文本中的亲属提及，并抽取其姓名
// 关键约束：
//   - 必须紧跟"明确引入词"（叫/名为/名字叫/名字是/姓名叫/姓名是/是），否则不算有名字
//   - 名字必须过 isLikelyName 闸门
//   - 同 rel 只取第一次有效姓名（去重，避免"父亲是江苏武进人"二次污染）
function relationMentions(text) {
  const seen = new Map(); // rel -> { index, rel, gender, name }
  for (const a of RELATION_ANCHORS) {
    let m;
    while ((m = a.re.exec(text)) !== null) {
      if (seen.has(a.rel)) continue; // K4 去重：先到先得
      const idx = m.index + m[0].length;
      const tail = text.slice(idx, idx + 18);
      const intro =
        tail.match(/^(?:的\s*)?(?:叫|名为|名字叫|名字是|姓名叫|姓名是)\s*([^，。！？、；：""''「」\s\d]{1,8})(?=[，。！？、；：\s\d]|$)/) ||
        tail.match(/^(?:的\s*)?(?:是)\s*([^，。！？、；：""''「」\s\d]{1,8})(?=[，。！？、；：\s\d]|$)/);
      if (!intro) continue;
      const raw = cleanName(intro[1]);
      if (!isLikelyName(raw)) continue; // K2 闸门
      let g = a.gender;
      if (g === null) {
        if (/老公|丈夫/.test(m[0])) g = '男';
        else if (/老婆|妻子/.test(m[0])) g = '女';
      }
      seen.set(a.rel, { index: m.index, rel: a.rel, gender: g || '', name: raw });
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.index - b.index);
}

// 从一段尾部文本里尝试抽取关系人籍贯（"是XX人/在XX"），K3 用
function extractBirthplaceNear(text, fromIndex, windowSize = 200) {
  const seg = text.slice(fromIndex, fromIndex + windowSize);
  const bp = seg.match(/(?:是|来自|籍贯是|老家是|老家在|籍贯在)\s*([^，。！？、；：\s\d]{1,12}?[省市县区镇乡村人])(?=[，。！？、；：\s]|$)/);
  if (!bp) return '';
  const place = bp[1].replace(/人$/, '').replace(/的$/, '').trim();
  // 籍贯本身不能是代词/称谓（防"是我"之类）
  if (!place || /^(我|你|他|她|这|那|谁|什么)$/.test(place)) return '';
  return place;
}

// ---------- 主抽取 ----------

// 主入口：从单句用户文本抽取结构化家谱信息（演示模式 + 规则兜底共用）
function ruleExtract(text, targetName) {
  const person = {
    name: '', nickname: '', gender: '', birth_date: '', birthplace: '', residence: '',
    occupation: '', education: '', bio: '',
    career: [], organizations: [], hobbies: [], places: [], life_events: [],
  };
  const relations = [];

  // K2：本人姓名——必须带"我"主语的明确引入词，绝不能误抓"我的父亲名字叫X"里的X
  let m = text.match(/(?:我叫|我是|本人叫|我名叫|我的名字叫|我的名字是)\s*([^，。！？、；：""''「」\s\d]{1,8})/);
  if (m) {
    const nm = cleanName(m[1]);
    // 拦截称呼词：绝不能把"男士/女士/先生/小姐"这类当成姓名（K2 加固）
    if (nm && !/^(?:男|女|男士|女士|男的|女的|先生|小姐|同志|师傅|老师)$/.test(nm)) {
      person.name = nm;
    }
  }
  if (!person.name && targetName) person.name = targetName;

  // 本人昵称/小名/乳名（说一次即视为已采集，后续不再问"身边人怎么称呼你"）
  const nickPatterns = [
    /(?:我小名|小名|乳名|昵称|外号)\s*(?:叫|是|为)\s*([^，。！？、；：""''「」\s\d]{1,8})/,
    /(?:小时候|小时候大家|家里人|大家|朋友|同事|同学都?)\s*(?:叫我|喊我|唤我)\s*([^，。！？、；：""''「」\s\d]{1,8})/,
  ];
  for (const re of nickPatterns) {
    m = text.match(re);
    if (m) {
      const maybe = cleanName(m[1]);
      if (isLikelyName(maybe)) { person.nickname = maybe; break; }
    }
  }
  m = text.match(/(?:我是|我是个|我为|我叫)\s*(?:一?个\s*)?(男|女|男士|女士|男的|女的|先生|小姐)(?:的)?\s*(?:人|孩|同志)?/);
  if (!m) m = text.match(/(?:^|[\s，,。、])(男|女)\s*性/); // 兜底："李烨，男性"这种独立表述
  if (m) person.gender = ['男', '男士', '男的', '先生'].includes(m[1]) ? '男' : '女';

  // 关系人姓名 + 位置
  const relMentions = relationMentions(text);
  const allDates = extractDates(text);
  const used = new Set();

  for (const rm of relMentions) {
    const rel = {
      rel: rm.rel, name: rm.name, gender: rm.gender,
      birth_date: '', birthplace: '', residence: '', occupation: '', org: '', note: '',
    };
    // 关系人生日：其后 80 字内最近的一个未用日期
    const nearest = allDates
      .filter((d) => !used.has(d.index) && d.index > rm.index && d.index < rm.index + 80)
      .sort((a, b) => a.index - b.index)[0];
    if (nearest) {
      rel.birth_date = formatDate(nearest.y, nearest.mo, nearest.d);
      used.add(nearest.index);
    }
    // K3：关系人籍贯（"我父亲是江苏武进人"）→ birthplace，不污染 name
    const bp = extractBirthplaceNear(text, rm.index);
    if (bp) rel.birthplace = bp;
    relations.push(rel);
  }

  // K1：本人出生日期——只认"出生于/生于/出生于/出生日期是"，绝不用事件年份兜底
  const selfDateMatch = text.match(/(?:我(?:出生于|出生|生于)|我的出生日期是)\s*[:：]?\s*(\d{4})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?)?/);
  if (selfDateMatch) {
    person.birth_date = formatDate(selfDateMatch[1], selfDateMatch[2], selfDateMatch[3]);
  } else {
    // 倒装兜底："1955年出生""1949年生于"——必须带"出生/生于"动词，绝不匹配"2008年结婚"等事件
    const inv = text.match(/(\d{4})\s*年\s*(?:出(?:生于?|生在)|生于)/);
    if (inv) person.birth_date = inv[1];
  }

  // 本人籍贯（必须"在/于是"，避免误匹配"出生年月"）
  m = text.match(/(?:出生(?:在|于)|老家(?:在|是)|籍贯(?:在|是))\s*([^，。！？、；：""''「」\s\d]{1,15})/);
  if (m) person.birthplace = cleanName(m[1]);
  m = text.match(/(?:住在|现居|居住(?:在|于)?|家在|定居|搬到|搬去|移居)\s*([^，。！？、；：""''「」\s]{1,15})/);
  if (m) person.residence = cleanName(m[1]);
  m = text.match(/(?:职业(?:是|为)?|工作是|从事)\s*([^，。！？、；：""''「」\s]{1,15})/);
  if (m) person.occupation = cleanName(m[1]);
  m = text.match(/(?:学历(?:是|为)?|毕业于|读的是|上的(?:大学|学校))\s*([^，。！？、；：""''「」\s]{1,15})/);
  if (m) person.education = cleanName(m[1]);

  // 履历：按年份切段抽取 单位/职务
  const careerSegs = [];
  const yearRe = /(\d{4})\s*年/g;
  const yearPos = [];
  let ym;
  while ((ym = yearRe.exec(text)) !== null) yearPos.push({ index: ym.index, y: ym[1] });
  for (let i = 0; i < yearPos.length; i++) {
    const start = yearPos[i].index;
    const end = i + 1 < yearPos.length ? yearPos[i + 1].index : text.length;
    const seg = text.slice(start, end);
    const orgM = seg.match(/(?:进了|到了|去了|调到|调入|考入|分到|分配到|进入|入职|就职于)\s*([^，。！？、；：""''「」\s]{2,15}?(?:厂|公司|企业|大学|学院|学校|局|所|院|部|队|矿|公社|医院|银行|机关|研究院|集团))/);
    const roleM = seg.match(/(?:当(?:了|上)?|做|担任|是)\s*([^，。！？、；：""''「」\s]{1,10}?(?:员|长|工|师|教授|工程师|主任|经理|书记|校长|局长|科长|技术员|工人|知青|兵|学生))/);
    if (orgM || roleM) {
      careerSegs.push({ year: yearPos[i].y, org: orgM ? cleanName(orgM[1]) : '', role: roleM ? cleanName(roleM[1]) : '' });
    }
  }
  person.career = careerSegs.slice(0, 20);

  // 团体/单位（非履历语境）
  const orgM = text.matchAll(/(?:加入(?:了)?|参加了?|是|属于)\s*([^，。！？、；：""''「」\s]{2,15}?(?:协会|学会|党派|俱乐部|公会|研究会|合唱团|戏班|乐队))/g);
  for (const x of orgM) { const v = cleanName(x[1]); if (v) person.organizations.push(v); }

  // 爱好（支持并列拆分）
  const hobM = text.matchAll(/(?:爱好|喜欢|爱|平时(?:爱|喜欢)?|闲着(?:爱|喜欢)?)\s*([^，。！？、；：""''「」\s]{1,20}?(?:书法|画画|钓鱼|唱戏|下棋|跳舞|摄影|养花|旅游|读书|写诗|打拳|太极|麻将|二胡|京戏|戏曲|篆刻|集邮|京剧|围棋|篮球|羽毛球))/g);
  for (const x of hobM) {
    const seg = cleanName(x[1]);
    const parts = seg.split(/[和、与及]/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) if (p.length >= 2) person.hobbies.push(p);
  }

  // 走过的地方/城市（去重）
  // 🔴 「到了」前面若接「起/受/得/料/想/说/觉/看…」就是"起到/受到/得到/想到"这类动补结构，
  //    不是旅行动词 —— 生产事故「起到了很重要的作用」→ 抽出地名「很重」即此。
  //    正则堵一层（负向后顾），isLikelyPlace 再堵一层（强闸门），两层任一命中都不会入库。
  // 另外：动词后被切进来的「了/着/过」要在 cleanPlace 里剥掉（"搬到了芜湖" 会切出 "了芜湖"）。
  const placeM = text.matchAll(/(?:去过|(?<![起受得料想说觉看算轮遇等盼数属舍怪赖靠求])到了|走过|调到|搬(?:到|去)|下放(?:到|去)|支边(?:到|去)|出差(?:到|去)|生活(?:过)?(?:在|于)?|去了)\s*([^，。！？、；：""''「」\s\d]{2,12}?(?:省|市|县|区|村|镇|地区|草原|高原|边疆|江|河|湖|海|中国台湾|香港|澳门|北京|上海|广州|新疆|西藏|内蒙古|黑龙江|海南|云南|东北|西北|江南)?)/g);
  const placeSeen = new Set();
  for (const x of placeM) {
    const v = cleanPlace(x[1]);
    if (v && v.length >= 2 && isLikelyPlace(v) && !placeSeen.has(v)) { placeSeen.add(v); person.places.push(v); }
  }

  // 人生事件（带年份优先，去重）
  const eventM = text.matchAll(/(\d{4}\s*年)?\s*(下乡|知青|高考恢复|恢复高考|下岗|失业|移民|出国|参军|入党|结婚|离婚|生病|去世|离世|搬迁|落实政策|平反)/g);
  const eventMap = new Map();
  for (const x of eventM) {
    const year = x[1] ? x[1].replace(/\s/g, '') : '';
    const ev = x[2];
    const v = year ? `${year}${ev}` : ev;
    const prev = eventMap.get(ev);
    if (!prev || (year && !prev.year)) eventMap.set(ev, { year, v });
  }
  for (const { v } of eventMap.values()) person.life_events.push(v);

  // 弱关系（朋友/同事/师长/邻居）
  for (const ptn of WEAK_RELATION_PATTERNS) {
    let mm;
    while ((mm = ptn.re.exec(text)) !== null) {
      let nm = cleanName(mm[1]);
      let guard = 0;
      while (WEAK_NAME_PREFIX.test(nm) && guard++ < 5) nm = nm.replace(WEAK_NAME_PREFIX, '').trim();
      if (nm && nm.length >= 2) relations.push({ rel: ptn.rel, name: nm, gender: '', birth_date: '', birthplace: '', residence: '', occupation: '', org: '', note: '' });
    }
  }

  return { person, relations, link_names: [] };
}

// ---------- 复核清单生成 ----------

// 字段 → 中文标签 / 回写 path 的映射（单一数据源，避免散落字符串）
const PERSON_REVIEW_FIELDS = [
  ['name', '本人·姓名', 'person.name'],
  ['gender', '本人·性别', 'person.gender'],
  ['birth_date', '本人·出生时间', 'person.birth_date'],
  ['birthplace', '本人·籍贯/出生地', 'person.birthplace'],
  ['residence', '本人·现居地', 'person.residence'],
  ['occupation', '本人·职业', 'person.occupation'],
  ['education', '本人·学历', 'person.education'],
  ['death_date', '本人·离世时间', 'person.death_date'],
];

// 从抽取结果生成"需当面核实"清单
// confirmedPaths：已确认过的 path 集合（Set 或数组），命中则跳过 —— 对应"已确认不重复弹"
function buildRuleReview(ext, confirmedPaths) {
  const confirmed = confirmedPaths instanceof Set ? confirmedPaths : new Set(confirmedPaths || []);
  const review = [];
  const reviewSeen = new Set(); // 按 label:value 去重（防真实模型/规则返回重复项）
  const p = ext.person || {};
  const addReview = (label, value, path) => {
    const key = `${label}:${value}`;
    if (!confirmed.has(path) && !reviewSeen.has(key)) {
      reviewSeen.add(key);
      review.push({ label, value, path });
    }
  };

  for (const [k, label, path] of PERSON_REVIEW_FIELDS) {
    if (p[k]) addReview(label, p[k], path);
  }
  (p.career || []).forEach((c, i) => {
    if (c.year) addReview(`履历·${c.year}年份`, c.year, `person.career[${i}].year`);
    if (c.org) addReview(`履历·${c.year || ''}单位`.trim(), c.org, `person.career[${i}].org`);
    if (c.role) addReview(`履历·${c.year || ''}职务`.trim(), c.role, `person.career[${i}].role`);
  });
  (p.organizations || []).forEach((o, i) => addReview('加入的团体·' + o, o, `person.organizations[${i}]`));
  (p.hobbies || []).forEach((hb, i) => addReview('爱好·' + hb, hb, `person.hobbies[${i}]`));
  (p.places || []).forEach((pl, i) => addReview('走过的地方·' + pl, pl, `person.places[${i}]`));
  (p.life_events || []).forEach((ev, i) => addReview(`人生事件·${ev}`, ev, `person.life_events[${i}]`));

  (ext.relations || []).forEach((r, i) => {
    const lab = relLabel(r.rel);
    // 亲属节点只连轻量关系线：只把姓名放进复核框；生日/籍贯/单位/职业等
    // 深度字段属于亲属自己的传记，不在讲述者篇追问。
    if (r.name) addReview(`${lab}·姓名`, r.name, `relations[${i}].name`);
    if (r.note) addReview(`${lab}·关系说明`, r.note, `relations[${i}].note`);
  });

  (ext.link_names || []).forEach((nm, i) => addReview('涉及的人·' + nm, nm, `link_names[${i}]`));
  return review;
}

// K6：规则兜底——真实模型返回的 review 可能漏掉关键亲属姓名（尤其配偶）
// 用规则扫描最后一条用户文本，把漏掉的家庭成员姓名补进 review
function augmentMissingFamilyNames(modelReview, userText, confirmedPaths) {
  if (!userText) return modelReview || [];
  const confirmed = confirmedPaths instanceof Set ? confirmedPaths : new Set(confirmedPaths || []);
  const ruleExt = ruleExtract(userText, null);
  const ruleReview = buildRuleReview({ person: {}, relations: ruleExt.relations || [], link_names: [] }, confirmed);
  const FAMILY_RELS = ['father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother'];
  const existingLabels = new Set((modelReview || []).map((r) => r.label));
  const needed = ruleReview.filter((r) => {
    const rel = FAMILY_RELS.find((t) => r.label.startsWith(relLabel(t) + '·'));
    return rel && r.label.endsWith('·姓名');
  });
  const added = needed.filter((r) => !existingLabels.has(r.label));
  return [...(modelReview || []), ...added];
}

// ---------- 校验闸门：抽取结果归一化 ----------
// 所有抽取来源（真实模型 / 第一层规则）的结果，最终都过这一道，
// 统一截断长度、类型、rel 合法化，避免脏数据入库。
function emptyExtract() {
  return { person: {}, relations: [], link_names: [] };
}

// 性别归一化：纯 JSON 模式下模型可能回英文（male/female），需统一为「男/女」。
// 背景：原 function-calling 靠 schema enum 强约束，改 JSON 模式后失去该约束（2026-09-13）。
function normGender(g) {
  const s = (g === undefined || g === null) ? '' : String(g).trim().toLowerCase();
  if (!s) return '';
  if (s === '男' || s === 'male' || s === 'm' || s === 'man' || s === '男士' || s === '男的' || s === '男性' || s === '先生') return '男';
  if (s === '女' || s === 'female' || s === 'f' || s === 'woman' || s === '女士' || s === '女的' || s === '女性' || s === '小姐') return '女';
  return '';
}

function normalizeExtract(e) {
  const out = emptyExtract();
  if (e && e.person) {
    const p = e.person;
    out.person = {
      name: (p.name || '').toString().trim().slice(0, 32),
      gender: normGender(p.gender),
      birth_date: (p.birth_date || '').toString().trim().slice(0, 20),
      death_date: (p.death_date || '').toString().trim().slice(0, 20),
      birthplace: (p.birthplace || '').toString().trim().slice(0, 60),
      residence: (p.residence || '').toString().trim().slice(0, 60),
      occupation: (p.occupation || '').toString().trim().slice(0, 60),
      education: (p.education || '').toString().trim().slice(0, 60),
      bio: (p.bio || '').toString().trim().slice(0, 1000),
      profile: p.profile && typeof p.profile === 'object' ? p.profile : {},
      career: Array.isArray(p.career) ? p.career.slice(0, 50).map((c) => ({
        year: (c.year || '').toString().trim().slice(0, 40),
        org: (c.org || '').toString().trim().slice(0, 80),
        role: (c.role || '').toString().trim().slice(0, 60),
        detail: (c.detail || '').toString().trim().slice(0, 200),
      })).filter((c) => c.year || c.org || c.role || c.detail) : [],
      organizations: Array.isArray(p.organizations) ? p.organizations.map((x) => String(x).trim().slice(0, 60)).filter((x) => x && !isJunkListItem(x)).slice(0, 50) : [],
      hobbies: Array.isArray(p.hobbies) ? p.hobbies.map((x) => String(x).trim().slice(0, 40)).filter((x) => x && !isJunkListItem(x)).slice(0, 50) : [],
      // 🔴 places 走**强**闸门：模型层（JSON 模式无 schema enum 约束）与规则层都可能把
      //    形容词短语（"很重"）当地名。这里做确定性拦截 —— 见 isLikelyPlace 注释里的生产事故。
      places: Array.isArray(p.places) ? p.places.map((x) => String(x).trim().slice(0, 40)).filter((x) => x && isLikelyPlace(x)).slice(0, 50) : [],
      life_events: Array.isArray(p.life_events) ? p.life_events.map((x) => String(x).trim().slice(0, 60)).filter((x) => x && !isJunkListItem(x)).slice(0, 50) : [],
    };
  }
  const REL_TYPES = ['father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'grandfather', 'grandmother', 'maternal-grandfather', 'maternal-grandmother', 'grandson', 'granddaughter', 'friend', 'colleague', 'teacher', 'neighbor', 'other'];
  if (e && Array.isArray(e.relations)) {
    for (const r of e.relations) {
      if (!r || !r.name) continue;
      const rel = REL_TYPES.includes(r.rel) ? r.rel : 'other';
      out.relations.push({
        rel,
        name: r.name.toString().trim().slice(0, 32),
        gender: normGender(r.gender),
        birth_date: (r.birth_date || '').toString().trim().slice(0, 20),
        birthplace: (r.birthplace || '').toString().trim().slice(0, 60),
        residence: (r.residence || '').toString().trim().slice(0, 60),
        occupation: (r.occupation || '').toString().trim().slice(0, 60),
        org: (r.org || '').toString().trim().slice(0, 80),
        note: (r.note || '').toString().trim().slice(0, 100),
      });
    }
  }
  if (e && Array.isArray(e.link_names)) {
    for (const n of e.link_names) {
      if (n && n.toString().trim()) out.link_names.push(n.toString().trim().slice(0, 32));
    }
  }
  if (e && Array.isArray(e.review)) {
    out.review = e.review
      .filter((x) => x && x.label && x.value)
      .map((x) => ({ label: String(x.label).slice(0, 40), value: String(x.value).slice(0, 120), path: String(x.path || '').slice(0, 80) }))
      .slice(0, 60);
  }
  return out;
}

module.exports = {
  cleanName,
  cleanPlace,
  isLikelyName,
  isLikelyPlace,
  isJunkListItem,
  formatDate,
  extractDates,
  relationMentions,
  extractBirthplaceNear,
  ruleExtract,
  buildRuleReview,
  augmentMissingFamilyNames,
  normalizeExtract,
  emptyExtract,
  relLabel,
  RELATION_ANCHORS,
  REL_LABELS,
  PERSON_REVIEW_FIELDS,
};
