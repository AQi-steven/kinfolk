// server/src/llm.js
// 赛博传记 — 回忆录级访谈引擎（倾听者/朋友角色 + 双轨抽取 + 章节总结）+ 演示降级
const { getLLMConfig } = require('./config');
const { extractFromText, parseJsonLoose } = require('./extractor');

// 注：结构化抽取工具 schema 已迁移到 extractor.js（第二层解耦：抽取与聊天分离）。

// 章节总结的 JSON 契约说明
// ⚠️ 同 extractor.js：hy3 不支持 tools 参数（带 tools 必 502），故改用纯 JSON 模式。
// 2026-09-13「传记做扎实」改造：summary 从「3-5 句要点」升级为【回忆录正文】。
// 此前产出的是会议纪要式罗列，读起来不像书；现在要求整理成第一人称叙事散文。
// 忠实原话原则：只润色衔接用户说过的内容，绝不编造、绝不添自己的议论。
//
// 2026-10-04 补「反 AI 腔」条款（借鉴 Memoiris AI 提示词做法）：
//   问题 —— "AI 像机器人"不只一种形态。除了机械重复（护栏已治），
//   另一种是**文艺腔**：话说得像散文不像人话。老一辈读了会觉得"这不像我说的"。
//   处方 —— 光讲原则无效，必须**点名禁用的套话词 + 给可执行的替代手法**。
//   注意：这些是"禁止出现的表达"，不是"要求出现的表达"，不会诱导模型编造细节；
//   替代手法也明确限定"只在用户已提到的细节里用"，杜绝无中生有。
const ANTI_SLOP_RULE = `
【🚫 文风红线 · 以下表达一律禁止出现在正文里】
- 套话成语：波澜壮阔、韶华易逝、岁月如歌、光阴荏苒、斗转星移、白驹过隙、沧海桑田
- 空泛抒情：岁月如梭、时光荏苒、那些年、不知不觉间、转眼间、多年以后
- 文艺腔套板：顺着时光的河流、时间的长河、空气里飘着、阳光洒在……上、记忆如潮水涌来
- 空洞形容词：幸福的、美好的、难忘的、珍贵的、深深的、满满的
  （这些词本身不是错，但不能当叙述内容；要说"那天冷得手抖"而不是"那天很寒冷"）

【✅ 替代手法 · 用具体代替抽象】
把感受落到**看得见、摸得着、听得见**的小东西上，优先取自用户自己讲过的细节：
  写"想念"→ 写"她总把收音机音量拧到最小，怕吵到隔壁"
  写"辛苦"→ 写"手掌心的茧厚得握不住筷子"
  写"高兴"→ 写"他一路踩着自行车铃铛一路响"
  写"安静"→ 写"屋里只有挂钟在走"
注意：只允许从**用户已经讲过的内容**里提取这些细节；用户没提的物件、场景一律留白，绝不补写。
宁可平淡也不要空洞 —— 真实的平淡读起来比漂亮的空话更有力量。`;

const CHAPTER_FIELDS_TEXT = `{
  "title": "温暖、有画面感的章名，如「父亲与那辆二八大杠」，绝不用「人生的一段回忆」这类空泛标题",
  "summary": "回忆录正文：以讲述者第一人称「我」叙述，250-400 字，流畅成文。忠实原话细节与语气，只做润色衔接；用户没提的事实一律留白，不编造人名/年份/地点；不加你自己的抒情议论。${ANTI_SLOP_RULE}",
  "excerpt": "从用户原话中摘录最动人的一两句（忠实原文）",
  "year": 1998
}`;

// 从访谈文本里尽量抓出一个「事件发生的年份」，用于时间线排序
function extractYearFromTexts(messages) {
  const texts = (messages || []).filter((m) => m.role === 'user').map((m) => m.content || '');
  const joined = texts.join('\n');
  // 显式年份：19xx / 20xx
  const ym = joined.match(/(?:19|20)\d{2}/);
  if (ym) return parseInt(ym[0], 10);
  // 「X岁」或「X年」近似：不足以定位年份，返回 null（前端退化为按创建顺序）
  return null;
}

function buildSystemPrompt(knownPersons, targetName, filled, confirmed, relayMode, isOpening, coveredFields, corrections) {
  // 代录关系线模式：角色切换为「帮本人把和这位亲属的关系、称呼、一句备注记下来」，不进传记深挖
  if (relayMode) {
    const who = targetName || '这位亲属';
    const REL_HINT = `你正在帮用户「代录一位亲属/朋友的关系线」。这位亲属是「${who}」。
你的任务非常有限，只做三件事，绝不越界：
1. 确认「${who}」和用户是什么【关系】（如 父亲/母亲/配偶/儿子/女儿/朋友等）；
2. 确认用户平时怎么【称呼】这位亲属；
3. 如果用户愿意，记一句关于这位亲属的【备注】（如「常年在外打工」「喜欢下棋」）。
❗ 绝对不要去问生日、籍贯、职业、生平故事——那些等本人将来自己来讲。
❗ 绝对不要进入「陪本人聊一生」的传记访谈模式。
❗ 回复里不要用「TA」这种代称，直接用亲属称谓（妈妈、外公、老伴…）或姓名。
每轮回复简短、务实，确认完上面三件事就礼貌收尾，例如「好的，我把（父亲·老王）这条关系线记下了，您还想补充别的亲属吗？」。
不要出现"采编/建档/AI/提取"这类词。`;
    return REL_HINT;
  }

  // 已知亲属只显示姓名+性别+是否待补全，不显示生日等深度字段——传记以讲述者本人为中心，亲属只是关系连线。
  // 防御：跳过与谈话对象同名/同昵称的成员（本人真名/昵称不应被当成某个亲属列出，否则模型会幻觉"你爸叫XXX"）。
  const safeKnown = (knownPersons || []).filter((p) => !(targetName && ((p.name && p.name === targetName) || (p.nickname && p.nickname === targetName))));
  const catalog = safeKnown.length
    ? safeKnown
        .map((p) => `- ${p.name}${p.nickname && p.nickname !== p.name ? '（昵称' + p.nickname + '）' : ''}（${p.gender || '未知'}${(p.status === 'stub' || p.status === 'pending_claim') ? '，待本人自述' : ''}）`)
        .join('\n')
    : '（暂无已知成员）';

  // 已采集字段：明确告诉模型不要重复问这些
  const FILLED_LABELS = {
    name: '姓名', nickname: '昵称/小名', gender: '性别', birth_date: '出生', death_date: '逝世',
    birthplace: '籍贯', residence: '居住地', occupation: '职业', education: '学历',
    spouse_name: '配偶', ethnicity: '民族', phone: '联系电话', bio: '一句话简介',
    父母: '父母', 子女: '子女', 配偶: '配偶',
  };
  const filledList = filled && Object.keys(filled).length
    ? Object.entries(filled).map(([k, v]) => `- ${FILLED_LABELS[k] || k}：${v}`).join('\n')
    : '（尚无）';
  const FILLED_HINT = `下面这些信息【已经采集到了】，绝对不要再重复去问、不要重复确认，直接基于它们自然接话、聊下一个还没提到的方面：
${filledList}
【特别强调】如果上面"父母"一栏已经列出了父亲和母亲的姓名，你【绝对不能再问】"你爸叫什么""你妈叫什么""父母怎么称呼你"这类采集性问题——他们叫什么你已经知道了，要基于已知名字自然接话（比如"你爸XXX那时候……"），或者去聊别的还没提到的方面（兄弟姐妹、童年、工作等）。`;

  // 已确认字段：本轮及之前用户已当面核实过的条目（path 维度），不要再生成 review 复核项
  const confirmedList = confirmed && confirmed.length
    ? confirmed.map((p) => `- ${p}`).join('\n')
    : '（尚无）';
  const CONFIRMED_HINT = `下面这些【用户已经当面确认过】的字段，后续访谈中不要再重复确认或追问，除非用户主动提到要改它：
${confirmedList}`;

  // 持久化已聊字段（跨会话去重）：无论换手机/换天再进，这些字段都已沉淀到档案，永不重复问
  const coveredList = coveredFields && coveredFields.length
    ? coveredFields.map((p) => `- ${p}`).join('\n')
    : '（尚无）';
  const COVERED_HINT = `下面这些字段【此前任何一次访谈已经聊过并沉淀到档案】（来源：covered_fields，持久化跟随这个人），后续无论什么时候再进来，都【绝对不要重新提问或重新确认】，直接基于它们接话、聊下一个还没提到的方面。即使用户换了设备、隔了很久再来，这些也视为"已聊过"：
${coveredList}`;

  // 用户已纠正的别名映射：提到旧词一律用新词（防模型忘性再次用错名）
  const corrList = (corrections && corrections.length)
    ? corrections.map((c) => `- 提到「${c.from}」一律改作「${c.to}」`).join('\n')
    : '（无）';
  const CORRECTION_HINT = `下面是你此前在访谈中【已经帮用户纠正过的称呼/名字错误】，以后无论用户还是你自己，提到旧词都必须统一用新词，绝不要再写回旧的错误写法：
${corrList}`;

  return `你是「赛博传记」里这位长辈的老朋友、耐心的倾听者。你的唯一任务，是陪他/她慢慢聊，让他愿意继续讲自己的一生。

${isOpening ? `【开场引导（仅本轮生效）】这一轮是访谈的开始，请先用一两句温暖的话破冰，然后只问【一个】关于讲述者本人的、最容易开口的小问题，引导对方开口。优先从"你叫什么名字/小时候大家怎么称呼你""你是在哪一年出生的""你老家是哪儿"中选一个还没聊过的开始；如果对方已经回答过名字/小名，就顺着问出生年份或老家。记住：只问一个，别一次问一堆。如果对方主动提到亲属，你就顺着记下来、关心一句，再把话题温柔地拐回讲述者本人。
记住：这只是开场的"点名"，目的是让关系网长出来；真正的传记仍是讲【他自己】的一生。` : ''}

当前陪伴讲述的对象：${targetName ? '「' + targetName + '」' : '这位朋友本人'}。

【常驻基座 · 访谈引导七原则（倪萍原则）——以下七条是一切对话的最高准则，优先于任何"采集清单"执行；详见 docs/interview-principles.md】
① 越具体越好回答：用物件/食物/场景当记忆钥匙（"你小时候最愿吃哪道菜？"），不问空泛的"你小时候怎么样"。
② 从上一句话长出来：认真听他刚说的，顺着词/事/感受往下问；同一话题至少追问 2-3 轮，绝不刚问完就跳到不相关话题。
③ 一次只问一个：每轮只在末尾用一个完整句子问一个好接话的小问题。
④ 允许拒绝与重复：他说"不想说"就轻轻带过；他重复讲的事一定重要，不打断。
⑤ 不擅自添加情绪：不替他总结"你一定很遗憾"，改问"你自己怎么看"。
⑥ 用心说话：像老朋友温暖共情、会接话，绝不暴露"采编/建档/AI/提取"。
⑦ 不确定要确认：年份/人名/地名拿不准就温柔确认，不编造、不硬写。

【🚫 说话方式的硬禁令（2026-10-04 补，借鉴 Memoiris AI）】
老人不需要你"文采斐然"，只需要你像真人。绝对禁止：
- 文艺腔套板：严禁"顺着时光的河流往回走""时间的长河""空气里飘着怎样的气味""记忆如潮水涌来"这类空洞抒情
- 书面语倒装：不要"彼时的""彼年""往昔""忆及"；老人说的是"那时候""那阵子""以前"
- 抒情议论：你不是散文作者，**不要替老人感慨**。他说难熬，你就问怎么熬过来的；他说想家，你问他想家的时候手上在干什么
- 套话成语：波澜壮阔、岁月如歌、光阴荏苒之类，一个都不要
✅ 正确的腔调参照：
❌「往昔的时光里，那段日子承载着许多朴素的欢愉。」
✅「那时候日子穷，可逢年过节能吃上一顿肉，我就挺高兴。」
✅ 你的角色是**坐在旁边听的人**，不是**站在旁边抒情的人**。

【七原则对话示范——务必照此节奏】
✅ 延展：「我小时候最怕鬼故事」→「是谁常讲给你听？讲完你晚上敢一个人睡吗？」→「那时候你几岁？」
✅ 拒绝：「我爸的事我不想聊」→「没事，咱先放一放。你小时候有没有特别要好的朋友？」
✅ 具体：「我妈红烧肉是一绝」→「你最馋的是哪一口？是那层亮晶晶的皮吗？」
❌ 跳跃：「我小时候最怕鬼故事」→「那你年轻时有什么爱好？」（绝对禁止，清单式乱跳）
❌ 加戏：「我 18 岁就离家打工」→「那时候你一定很想家吧」（绝对禁止，替他下结论）

你的访谈方法论（顶层逻辑——只有一条主线：顺着他，把话题聊透）：
你不是"信息采集员"，而是"陪聊 + 深挖他本人"的老朋友。下面所有规则都服务于这一条：
1. 永远从他上一句话里长出下一个问题——挑其中的一个词、场景、感受、人或时间继续问。严禁从你心里的"采访清单"凭空挑一个不相关的问题抛给他。
2. 同一话题至少追问 2-3 轮，直到他自然收尾或主动换方向。例：他说"小时候最怕鬼故事"→你问"谁常讲给你听？讲完敢一个人睡吗？"→他答后你再问"那时候你几岁？"——这才是节奏。刚问完"怕什么"就跳"你爱好什么"，是绝对禁止的清单式跳跃。
3. 一次只问一个具体、好接话的小问题，放在每轮回复最后；其余留到下一轮。
4. 90% 以上问题指向"他自己"：童年、感受、选择、得失、日子。亲属只是引子，提到时轻量确认即拐回本人。
5. 已采集/已聊过的字段（见下方提示）绝不再问；他说"想不起来/说过了/别提了"时，立刻共情并换方向，绝不纠缠。

【对照范例，务必照此节奏】
✅ 好：「鬼故事啊，听着背后凉飕飕的！是谁总爱讲给你听？讲完那天晚上你敢关灯睡吗？」（从"鬼故事"长出，追细节与感受）
❌ 差：「你小时候最怕什么？」「你年轻时有什么爱好？」（问完即跳，清单式采编，绝对禁止）

【其余行为边界】
- 像老朋友温暖共情，绝不暴露"采编/建档/AI/提取"等词；每轮末尾用一句自然小问句引导他继续，不能只说"你接着说"。
- 关系网（父母、配偶、子女）只做轻量标记：提到时温和确认姓名与关系，立刻回到讲述者本人的故事；不要把访谈变成"点名打卡"，更不要为凑齐骨架频繁切换话题。
- 【直系亲属要问姓名】直系亲属＝父母、配偶、子女。聊到他们、而你还不知道名字时，在当轮回复末尾**自然地问一句名字**（例：「妈妈叫什么名字？」「老伴怎么称呼？」）——这是唯一允许的采集式提问，目的是以后能把家里人连起来。一次只问一个人，问到就回到本人或别的事上。
  · 对方不答、岔开、或说"不用记/没必要/不想说" → 记下这个态度，**这个人以后永远不再问名字**。
  · 兄弟姐妹、祖父母、外祖父母、叔伯姑舅等其他亲属**不要主动追问姓名**；对方自己说了就记下。
- 家谱由多篇自述自然涌现：你只需把讲述者提到的亲属连一条轻量关系线（姓名+关系+性别），不要试图通过他挖全父母的生平——那些属于父母自己的传记。
- 主动记录爱好与特长（钓鱼、唱戏、书法、下棋、画画、养花、读书等），并在后续顺着爱好展开他本人的故事。
- 亲属分层处理：父母/兄弟姐妹的生平严格点到为止（接一句关心即拐回本人；但**姓名例外——见上面"直系亲属要问姓名"那条，父母的名字是要问的**）；配偶/子女允许"反照本人"多问一两句感受（主语仍是"你"）。红线：绝不把问题主语变成亲属本人（"你爸打仗细节"越界，应改为问"你"的童年记忆）。
- 多问本人的细节和感受："后来呢""那时候你心里怎么想""这件事对你影响大吗""你当时怎么决定的"。
- 问题从具体物件/场景里长出来：食物、气味、声音、老物件都是记忆钥匙。但同一道菜/物件连续深挖不超过 2-3 轮；对方无补充就从他话里挑新词自然过渡，别反复问"这菜什么味"。
- 一次只问一个问题：若一条回复出现两个问号，删掉一个，只留最贴合他上一句话的那一个。停顿不是冷场，是给记忆浮上来。
- 允许拒绝、允许重复、允许沉默：他说"不想说"就轻轻带过；他重复讲的事一定很重要，不打断，重复本身就是信息。
- 用户说"不记得/记不清/想不起来/已经回答过/跳过/别提了/不说了/就这样"时，必须立刻停止当前话题：温柔共情 → 绝不换个说法继续问 → 自然切换到另一个人生阶段。这是最高优先级边界信号。
- 提问前必须核对下方"已聊过字段"，列表里的内容绝不再以任何形式提问或变相追问。
- 不要替他下情绪结论（"你一定很遗憾"），改问"你自己怎么看？"；让他自己定义感受。
- 不确定的年份/人名/地名/关系要温柔确认，绝不编造；未见于"已采集"列表的亲属姓名一律禁止替他说出（用"爸/妈/爱人"这样的称谓指代，不加"你"）。
- 对方跑题就顺着聊，再轻轻接回本人；已确认聊过的话题不回头重复问；对方只说一两句也要接共情再问一个关于他本人的小问题，不能只说"嗯，我听着呢"。

你已知的家族成员（对方提起其中某人时，请顺着聊）：
${catalog}

备注：每个人既有真名也有昵称（注册或平时就叫的称呼都算）。如果对方用某个已知成员的【昵称】来称呼 TA（比如已知"李烨"昵称"刚刚"，对方说"刚刚"），请当作同一个人来接话、继续连关系线，不要当成另一个新人重复登记。

${FILLED_HINT}

${CONFIRMED_HINT}

${COVERED_HINT}

${CORRECTION_HINT}

绝不要编造信息。回复里不允许出现"我帮你记录下来了""已采集"这类后台工具式语言。

【关于亲属姓名的最高铁律】除非上面"已采集"列表里已经明确写出了父亲/母亲/配偶/子女的姓名，否则你【绝对不能】替用户说出任何亲属的名字——哪怕你"觉得"该叫什么也不行。如果姓名未知，就用"爸爸""妈妈""爱人"这样的称谓来指代（不加"你"），并顺势问一句名字——但只对【父母、配偶、子女】问，且问过一次对方没答就不再问。任何你没在列表里见过的亲属姓名，一律视为你自己的幻觉，禁止输出。`;
}

async function chatCompletion(messages, { tools, signal } = {}) {
  const cfg = getLLMConfig();

  // 腾讯云原生混元（长期 SecretId/SecretKey）
  if (cfg.provider === 'tencent-native') {
    const { chatCompletion: tencentChat } = require('./hunyuan');
    return tencentChat(messages, {
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      model: cfg.model,
      signal,
      timeout: 30000,
    });
  }

  // OpenAI 兼容接口（短期 API Key）
  if (!cfg.apiKey) throw new Error('no-api-key');

  async function tryOnce(model) {
    const body = { model, messages, temperature: 0.75 };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const controller = new AbortController();
    let externalAbort;
    if (signal) {
      // 外部传入信号（上层 race 超时）：外部取消时一并中断底层 fetch
      if (signal.aborted) controller.abort();
      else {
        externalAbort = () => controller.abort();
        signal.addEventListener('abort', externalAbort);
      }
    } else {
      // 无外部信号则自带 30s 兜底
      controller._timer = setTimeout(() => controller.abort(), 30000);
    }
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const txt = await res.text();
      if (!res.ok) {
        const err = new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 400)}`);
        err.status = res.status;
        err.body = txt;
        throw err;
      }
      return JSON.parse(txt);
    } finally {
      if (controller._timer) clearTimeout(controller._timer);
      if (externalAbort) signal.removeEventListener('abort', externalAbort);
    }
  }

  const primary = cfg.model || 'gpt-4o-mini';
  try {
    return await tryOnce(primary);
  } catch (e) {
    // 如果主模型名不可用（如 TokenHub 不支持 hunyuan-pro），回退到兼容备用模型，避免直接 demo
    const modelNotFound = e.status === 404 || e.status === 400 && /model|not found|invalid|does not exist|unsupported|no such model/i.test(e.body || '');
    if (modelNotFound && primary !== 'hy3') {
      console.warn(`[llm] model ${primary} not found, fallback to hy3`);
      return await tryOnce('hy3');
    }
    throw e;
  }
}

// ---------- 演示模式：脚本化倾听者 + 规则抽取 ----------
// 抽取规则已抽离到 extract-rules.js（第一层保底模块，含单测回归）
const {
  cleanName, isLikelyName, formatDate, extractDates, relationMentions,
  ruleExtract, buildRuleReview, relLabel, normalizeExtract, emptyExtract,
} = require('./extract-rules');

// 已采集字段：基于"目标节点 DB 里已填的值"，而不是整段对话正则
// 这样后续轮不会再重复问已采集的姓名/生日/籍贯等
function coveredTopics(allUserTexts, target) {
  const t = target || {};
  const has = (k) => t[k] !== undefined && t[k] !== null && t[k] !== '';
  return {
    name: has('name'),
    gender: has('gender'),
    birth: has('birth_date'),
    birthplace: has('birthplace'),
    residence: has('residence'),
    occupation: has('occupation'),
    parents: false, // 亲属通过 relations 实时判定，此处交给下方规则
    spouse: false,
    children: false,
  };
}

// 用户表达"边界/拒绝/已答过"的信号词；命中后必须停止当前话题，换方向
const REFUSAL_SIGNALS = /(?:记|想|回忆|回答|说|聊|讲|问|提|道|)[^，。！？、；]{0,4}(?:不(?:记得|清楚|知道|想|愿意|想聊|想说|想讲|想提|想回答)|记不(?:起来|住)|想不起来|记不清|不记得|忘了|没印象|不太清楚|不太记得|已经回答过|已经说过|已经聊过|刚刚回答过|刚才回答过|前面回答过|刚说过|前面说过|早就说过|你已经问过|你问过|说过(?:了|啦)|讲过(?:了|啦)|问过了|说过了|聊过了|别提了|跳过|算了|就这样|不说了|换一?个|换个话题|聊点别的|说点别的)|没(?:什么|啥)印象|就(?:那样|这样)/;
// 敷衍单字（嗯/哦/啊）：仅当整句只有敷衍词+标点/空白时才算拒绝，避免"嗯，我家在乡下…"被误杀
const FILLER_ONLY = /^[嗯哦啊呃唉噢呀嘛哈][，。,!！?？\s]{0,3}$/;

function isRefusing(text) {
  if (!text) return false;
  if (REFUSAL_SIGNALS.test(text)) return true;
  return FILLER_ONLY.test(text.trim());
}

// 演示模式：像老朋友一样接话、共情、自然过渡（非清单式采编）。基于"已采集字段"推进，不重复问。
function buildListenerReply(extract, allUserTexts, target, targetName, relayMode, coveredFields) {
  const isRelay = !!relayMode;
  const cov = coveredTopics(allUserTexts, target);
  const coveredSet = new Set(coveredFields || []);
  const newest = allUserTexts[allUserTexts.length - 1] || '';
  const prev = allUserTexts[allUserTexts.length - 2] || '';
  const rel = extract.relations[0];
  const p = extract.person;

  // 代录关系线模式：简短确认关系/称呼/备注，不深挖
  if (isRelay) {
    if (rel && rel.rel) return `好的，我把「${targetName || '这位亲属'}」和您的关系记为「${relLabel(rel.rel)}」${rel.note ? '，并备注：' + rel.note : ''}。还想补充别的亲属吗？`;
    if (p.name) return `记下了，这位叫「${p.name}」。您和这位是啥关系呀？（比如父亲、老伴、儿子）`;
    return `您想记哪位亲属？和您是啥关系、怎么称呼，说一句我就帮您记下来。`;
  }

  // 【边界识别】用户上一句已经表示"不记得/不想说/已经答过"，立刻共情并切换到新方向，绝不再追问同一细节
  if (isRefusing(newest)) {
    const fallbacks = [
      '那咱们换个方向——你小时候最常说的一句口头禅，或者家里人对你的一个称呼，还记得吗？',
      '没事，记不清的部分就先放一放。你小时候有没有一件特别想干、却被大人拦着不让干的事？',
      '不记得不打紧。那你印象里，家里最早的一台大件（比如自行车、缝纫机、电视机）是什么？',
      '那先不聊这个。你小时候最怕的东西是什么？黑暗、某个老师，还是别的什么？',
      '好，咱们轻轻跳过。你还记得自己第一次出远门是去哪儿吗？',
    ];
    return fallbacks[allUserTexts.length % fallbacks.length];
  }

  // 用户连续两次短/敷衍回复（≤6字），主动换话题，不穷追
  if (newest.length <= 6 && prev.length <= 6 && allUserTexts.length >= 3) {
    return '咱们换个轻松点的——你小时候有没有一个特别要好的朋友或者一个常去的地方？';
  }

  // 优先就"刚抽到的关系"做共情接话（仅当该亲属此前没聊过，且 covered_fields 未覆盖该关系线）
  const knownNames = (target && target._knownRelNames) || '';
  const relCovered = rel && coveredSet.has('relation.' + rel.rel + '.name');
  if (rel && !knownNames.includes(rel.name) && !relCovered) {
    if (rel.rel === 'father') return `听你提起父亲，感觉他在你心里分量很重。那母亲呢，她是个怎样的人？`;
    if (rel.rel === 'mother') return `母亲啊……她那时候拉扯你们不容易吧。家里除了你，还有兄弟姐妹吗？`;
    if (rel.rel === 'spouse') return `能和${relLabel(rel.rel)}走到一起，肯定有段故事。你们是怎么认识的？`;
    if (rel.rel === 'son' || rel.rel === 'daughter') return `说起${relLabel(rel.rel)}，他/她现在多大了？常陪在你身边吗？`;
  }
  if (p.birth_date && !cov.birthplace) return `${p.birth_date}年啊，那是个不寻常的年代。你老家是在哪儿长大的？`;
  if (p.birthplace && !cov.residence) return `老家在${p.birthplace}，后来是怎么离开那儿、搬到现在的城市的？`;
  if (p.residence) return `住在${p.residence}挺好的。你这辈子搬过几次家？印象最深的一次是因为什么？`;
  if (p.occupation) return `做${p.occupation}这一行，第一天上班印象最深的是什么？`;
  if (p.name && !cov.gender && !/^(?:男|女|男士|女士|男的|女的|先生|小姐|同志|师傅|老师)$/.test(p.name)) return `${p.name}，这名字好听。冒昧问一句，你是先生还是女士呀？`;
  if (!p.name) return `你好呀，很高兴听你聊聊。咱们随便说——你想从哪儿讲起都行，小时候、年轻时、还是近些年的事？`;

  // 兜底：温柔引导缺项（已采集的不再问，最近刚聊过的话题也跳过；小名已采集也不再问称呼）
  const skip = newest + prev;
  const hasNickname = !!((target && target.nickname) || coveredSet.has('person.nickname'));
  const flow = [
    { key: 'name', q: '咱们还不知道怎么称呼你呢——你叫什么名字呀？' },
    { key: 'nickname', q: `你身边人平时怎么称呼你？有小名或者昵称吗？`, skip: hasNickname },
    { key: 'gender', q: '冒昧问一句，你是先生还是女士呀？' },
    { key: 'birth', q: '你是在哪一年出生的？那时候家里是什么光景？' },
    { key: 'birthplace', q: '你的老家/籍贯是哪儿呢？' },
    { key: 'parents', q: '你家里兄弟姐妹几个？你在家里排行老几？', guard: /爸|父|妈|母|童年|小时候|兄弟|姐妹|排行|家里几个/ },
    { key: 'spouse', q: '后来你成家了吗？你们第一次见面是在哪儿、天气还记得吗？', guard: /老公|老婆|丈夫|妻子|成家|结婚/ },
    { key: 'children', q: '你们有孩子吗？他们小时候有没有什么让你特别操心或特别骄傲的小事？', guard: /儿子|女儿|孩子/ },
    { key: 'occupation', q: '你这一辈子是做什么工作的呀？第一天上班印象最深的是什么？' },
    { key: 'residence', q: '你现在是住在哪儿呢？这个家里你最常坐的一把椅子或一个角落是哪儿？' },
  ];
  for (const f of flow) {
    if (f.skip) continue;
    if (cov[f.key]) continue;
    // covered_fields 持久化覆盖：亲属线已沉淀则永不重复问
    if (f.key === 'parents' && coveredSet.has('relation.father.name') && coveredSet.has('relation.mother.name')) continue;
    if (f.key === 'spouse' && coveredSet.has('relation.spouse.name')) continue;
    if (f.key === 'children' && (coveredSet.has('relation.son.name') || coveredSet.has('relation.daughter.name'))) continue;
    if (f.guard && f.guard.test(skip)) continue; // 最近刚聊过，跳过，换下一个
    return f.q;
  }
  return `听你讲了这么多，我都记在心里了。要是哪段故事还想再细说，随时接着讲——比如小时候最常吃的一样东西、或者家里一件老物件，现在还总想起？`;
}

function demoInterview(messages, knownPersons, targetName, target, confirmedPaths, relayMode, coveredFields) {
  const isRelay = !!relayMode;
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = userTexts[userTexts.length - 1] || '';
  // 开场引导：首轮从讲述者本人最轻松的一件小事开始，不强行从父母骨架破冰
  if (!isRelay && userTexts.length <= 1) {
    const filled = buildProfileFilled(target);
    const reply = guardReply('咱们慢慢聊——你愿意先从哪儿讲起都行，小时候、年轻时、还是近些年的事都行。比如你小时候印象最深的一道菜、或者家里一件老物件，现在还总想起吗？',
      { filled, coveredFields, messages, lastUserText: last, target });
    const extractRaw = ruleExtract(last, targetName);
    extractRaw.review = buildRuleReview(extractRaw, confirmedPaths);
    return { reply, extract: normalizeExtract(extractRaw) };
  }
  const extractRaw = ruleExtract(last, targetName);
  extractRaw.review = buildRuleReview(extractRaw, confirmedPaths);
  const reply = buildListenerReply(extractRaw, userTexts, target, targetName, isRelay, coveredFields);
  return { reply: guardReply(reply, { filled: {}, coveredFields, messages, lastUserText: last, target }), extract: normalizeExtract(extractRaw) };
}

// 演示模式章节总结
function demoSummarize(messages, hint) {
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content).filter(Boolean);
  const cov = coveredTopics(userTexts);
  let stage = 'life';
  if (cov.parents) stage = 'parents';
  else if (cov.spouse) stage = 'marriage';
  else if (cov.children) stage = 'children';
  else if (cov.birthplace || cov.birth) stage = 'hometown';
  const title = STAGE_TITLE[stage] || '人生的一段回忆';
  const summary = userTexts.slice(- 3).join(' ').slice(0, 200) || '（这一段讲述暂未留下文字摘要）';
  const excerpt = userTexts[userTexts.length - 1] ? userTexts[userTexts.length - 1].slice(0, 120) : '';
  const year = extractYearFromTexts(messages);
  return { title, summary, excerpt, stage, year: year || null };
}

// ---------- 公共入口 ----------
// 注：emptyExtract / normalizeExtract 已迁移到 extract-rules.js（第一层校验闸门），
// 本文件直接复用其导出，保证抽取归一化逻辑单一数据源。

// ---------- 回复硬护栏：确定性拦截"重复问/问已聊过/编父母名" ----------
// 真实模型不一定遵守 system prompt，这里用代码兜底，保证访谈不绕回死循环。
function normalizeQ(s) {
  return (s || '').replace(/[\s，。！？、；：""''「」()（）]/g, '').toLowerCase();
}

// 用字符二元组 Jaccard 衡量两个问题是否“几乎同一问题”。只处理末尾最后一个问句，避免把“延展追问”误杀。
function questionSimilarity(a, b) {
  const qa = (a.match(/[^？?]*[？?]?$/) || [''])[0].replace(/[\s，。！？、；：""''「」()（）]/g, '');
  const qb = (b.match(/[^？?]*[？?]?$/) || [''])[0].replace(/[\s，。！？、；：""''「」()（）]/g, '');
  if (!qa || !qb) return 0;
  const ga = new Set();
  const gb = new Set();
  for (let i = 0; i < qa.length - 1; i++) ga.add(qa.slice(i, i + 2));
  for (let i = 0; i < qb.length - 1; i++) gb.add(qb.slice(i, i + 2));
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter || 1);
}

function lastAssistantQuestion(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const c = messages[i].content || '';
      const parts = c.split(/[？?]/);
      const last = parts.length >= 2 ? parts[parts.length - 2] : c;
      return (last || c).trim();
    }
  }
  return '';
}

const TOPIC_PATTERNS = {
  name: /你叫什么|叫什么名字|怎么称呼你|你的小名|你的昵称|你叫[^\s，。！？]/,
  gender: /先生还是女士|男还是女|你是男|你是女|你性别/,
  birth: /哪一年出生|出生在|你.*生[日年]|你.*多大|你.*年龄|你.*年纪|什么时候出生|你几岁/,
  birthplace: /老家|籍贯|出生在|哪儿人|哪里人|你是哪里|你老家|哪个省|哪个市|什么地方人/,
  parents: /你爸|你妈|你父亲|你母亲|父母叫|爸妈叫|你父母|父母怎么称呼|你爹|你娘/,
  siblings: /兄弟姐妹|手足|排行|独生子|独生女|你有几个|几个孩子|几个兄弟|几个姐妹/,
  spouse: /配偶|老伴|另一半|你结婚|你对象|你爱人|你丈夫|你妻子/,
  children: /你儿子|你女儿|你孩子|你们有孩子/,
};

function blockedTopics(filled, coveredFields) {
  const blocked = new Set();
  const cov = new Set(coveredFields || []);
  const f = filled || {};
  if (f.name || cov.has('person.name')) blocked.add('name');
  if (f.gender || cov.has('person.gender')) blocked.add('gender');
  if (f.birth_date || cov.has('person.birth_date')) blocked.add('birth');
  if (f.birthplace || cov.has('person.birthplace')) blocked.add('birthplace');
  if (f['父母'] || cov.has('relation.father.name') || cov.has('relation.mother.name')) blocked.add('parents');
  if (cov.has('person.siblings')) blocked.add('siblings');
  if (f['配偶'] || cov.has('relation.spouse.name')) blocked.add('spouse');
  if (f['子女'] || cov.has('relation.son.name') || cov.has('relation.daughter.name')) blocked.add('children');
  return blocked;
}

// 本人中心的新鲜话题池（仅用于用户明确拒绝/已答过等需要换方向时，平时禁止直接搬用）
//
// 2026-10-04 重构：按【一生骨架】分八段组织，不再是散点随机。
// 起因：对比潮汕 lifebook（8 主题 31 题）与 Memoiris AI 后的判断——
//   ① 竞品的强项不是"问题写得好"，而是**结构切分**（童年→故乡→求学→谋生→成家→闯荡→日常→寄语），
//      天然覆盖一生，不容易漏掉关键段落；
//   ② 我们原来 15 条是散点，可能"趣事聊了一堆，但谋生、成家、寄语没覆盖到"。
// 取舍说明：
//   · 内容全部改写为**上海/通用语境的记忆钥匙**（不照搬潮汕的工夫茶/营老爷/粿/拜老爷）
//   · 保留原有的具体钩子写法（"最盼什么节 + 那阵怎么热闹"这种双问结构）
//   · 修掉两条写得不好的旧题：把"最得意的一件事"（太抽象，易敷衍）与
//     "怕过什么"（直问创伤，老人易回避）换成更有抓手、更不冒犯的问法
const LIFE_SPINE = [
  {
    stage: 'childhood', label: '童年',
    topics: [
      '你小时候住的地方是什么样的？家里最常待的是哪儿？',
      '那时候一年里最盼哪个节？过那节家里怎么热闹？',
      '小时候最要紧的一件东西是什么？搁在哪儿呢？',
      '你小时候最要好的那个玩伴是谁？你们常一块儿干啥？',
    ],
  },
  {
    stage: 'hometown', label: '故乡',
    topics: [
      '老家那边是什么样子？街巷、河道、门口有什么？',
      '家里那时候最像样的一样家具是什么？',
      '逢年过节你们家有什么一定要做的事？',
    ],
  },
  {
    stage: 'study', label: '求学',
    topics: [
      '你念了多少年书？第一天上学是谁送去的？',
      '读书那会儿你哪门课最要命？哪门还凑合？',
      '要是没念那么多书，那阵你在做什么？',
    ],
  },
  {
    stage: 'work', label: '谋生',
    topics: [
      '你第一份活计是做什么的？一天怎么过的？',
      '干过的这些营生里，哪一份最熬人？怎么熬过来的？',
      '你第一次领工钱是多少？自己怎么花的？',
      '刚上班那阵子，单位什么样子？带你的那个人是什么样的人？',
    ],
  },
  {
    stage: 'family', label: '成家',
    topics: [
      '你和你老伴是怎么认识的？头一回见面是在哪儿？',
      '成家那天什么光景？摆了几桌、来了哪些人？',
      '有了孩子以后，家里日子是怎么过的？哪阵最紧？',
    ],
  },
  {
    stage: 'world', label: '闯荡与时代',
    topics: [
      '你有没有离开过家乡？去的哪儿？当时怎么去的？',
      '这几十年里，变化最大的是哪几年？你那阵在做什么？',
      '你出去闯过最远的地方是哪儿？第一回回来是啥心情？',
    ],
  },
  {
    stage: 'life', label: '日常与爱好',
    topics: [
      '你这辈子有什么一直坚持的爱好？到现在还弄吗？',
      '记忆里吃得最好的一顿是在什么场合？',
      '你住过的老房子，门前有什么？门口那棵树还在吗？',
    ],
  },
  {
    stage: 'legacy', label: '寄语后人',
    topics: [
      '如果跟孙辈讲一句，你最想让他们记住什么？',
      '你们家有没有一句老话、或者长辈传下来的规矩？',
      '走了大半辈子，你自己觉得做人最要紧的是什么？',
    ],
  },
];

// 扁平化后供现有 pickFreshTopic 逻辑使用（它只认字符串数组，不关心分段）
const FRESH_TOPICS = LIFE_SPINE.flatMap((g) => g.topics);

// 每个阶段的话题特征词：用于判断"这段人生是不是已经聊过了"。
// 为什么需要（2026-10-04）：pickFreshTopic 原本只能排除档案类问题（姓名/生日），
// 但骨架类问题（童年/谋生/寄语）**问过一次就该长期避开** —— 老人最忌讳被反复追问同一段。
// 命中即整段排除该阶段的所有问题，宁可换段也不重复问。
const STAGE_SIGNALS = {
  childhood: /小时候|童年|玩伴|老物件|最盼|过.*节/,
  hometown: /老家|故乡|家里那时候|街巷|河道|像样.*家具|一定要做的事/,
  study: /念.*书|上学|哪门课|书那会儿|读书/,
  work: /工计|营生|工钱|上班|单位|第一份活|领工钱|参加工作|做工|干活|上班那阵/,
  family: /老伴|成家|结婚|孩子|有了孩子|娶|嫁/,
  world: /离开.*家乡|变化最大|闯过|出去|最远|回来/,
  life: /爱好|吃得最好|老房子|门前|坚持/,
  legacy: /孙辈|老话|规矩|传下去|做人/,
};

// 从历史对话里推断"已经聊过哪些阶段"，用于避开重复提问。
// 只看用户说过的话（AI 问过不算——没答说明没聊成），宁可漏判也不误杀。
function detectCoveredStages(messages) {
  const userText = (messages || [])
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content || ''))
    .join('\n');
  // ⚠️ 门槛不能设太高：老人一句"我念了九年书"只有 6 字，
  //   原先 length<8 直接返回空集 → 该段去重完全失效、反复追问同一段。
  //   改为只挡空串，交给 STAGE_SIGNALS 去判断，避免短句漏判。
  if (!userText.trim()) return new Set();
  const hit = new Set();
  for (const [stage, re] of Object.entries(STAGE_SIGNALS)) {
    if (re.test(userText)) hit.add(stage);
  }
  return hit;
}

// 当模型生成的回复违规（问已采集字段、与上一问重复）时，优先基于用户上一轮回答做延展追问，而不是从清单里随机挑题。
function followUpFromText(userText) {
  if (!userText || userText.length < 4) return null;
  // 活动 / 爱好
  const activity = userText.match(/(画\s*画|画\s*图|唱\s*戏|唱\s*歌|钓\s*鱼|下\s*棋|打\s*球|写\s*字|写\s*文章|读\s*书|跑\s*步|游\s*泳|旅\s*游|旅\s*行|摄\s*影|踢\s*足\s*球|打\s*篮\s*球|打\s*乒\s*乓\s*球|弹\s*琴|拉\s*二\s*胡|做\s*手\s*工|种\s*花|养\s*鸟|玩\s*游\s*戏|玩\s*卡\s*片)/);
  if (activity) return `你刚说到${activity[1].replace(/\s/g, '')}，这件事你坚持多久了？家里人当时怎么看？`;
  // 地点
  const place = userText.match(/(黄\s*山|老\s*家|故\s*乡|学\s*校|工\s*厂|单\s*位|部\s*队|北\s*京|上\s*海|广\s*州|深\s*圳|杭\s*州|南\s*京|成\s*都|西\s*安|重\s*庆|天\s*津|江\s*苏|浙\s*江|安\s*徽|山\s*东|河\s*南)/);
  if (place) return `你刚说到${place[1].replace(/\s/g, '')}，那次是和谁一起去的？印象最深的一幕是什么？`;
  // 食物 / 物件
  const thing = userText.match(/(工\s*资|饺\s*子|馄\s*饨|面\s*条|米\s*饭|红\s*烧\s*肉|鱼|鸡\s*蛋|年\s*糕|月\s*饼|粽\s*子|糖\s*果|自\s*行\s*车|缝\s*纫\s*机|电\s*视\s*机|收\s*音\s*机|照\s*相\s*机|手\s*表|书\s*包)/);
  if (thing) return `你刚说到${thing[1].replace(/\s/g, '')}，能再多讲一点吗？当时是什么情景？`;
  // 人物
  const person = userText.match(/(父\s*亲|母\s*亲|爸\s*爸|妈\s*妈|爸|妈|爷\s*爷|奶\s*奶|外\s*公|外\s*婆|朋\s*友|同\s*学|哥\s*哥|弟\s*弟|姐\s*姐|妹\s*妹|老\s*师|同\s*事|爱\s*人|老\s*婆|老\s*公|儿\s*子|女\s*儿)/);
  if (person) { const w = person[1].replace(/\s/g, ''); return `刚提到${w}，能多讲讲和${w}有关的那一段吗？`; }
  // 情感
  const emotion = userText.match(/(怕|害\s*怕|害\s*羞|紧\s*张|高\s*兴|开\s*心|难\s*过|委\s*屈|失\s*望|骄\s*傲|自\s*豪|后\s*悔|遗\s*憾|激\s*动|兴\s*奋)/);
  if (emotion) return `你刚说${emotion[1].replace(/\s/g, '')}过，那时候你多大？是什么事让你这么${emotion[1].replace(/\s/g, '')}？`;
  // 兜底：用户回答有实质内容但无特定钩子时，从末尾提炼短语做通用延展，保证跳跃检测始终有锚点可换
  const tail = (userText || '').replace(/[\s，。！？、；：""''「」()（）]/g, '').slice(-2);
  if (tail && tail.length >= 2) return `你刚才说到「${tail}」，那时候是个什么光景？后来呢？`;
  return null;
}

function pickFreshTopic(blocked, excludeText, userText, messages) {
  // 优先从用户上一句里长出问题（延展），万不得已才用固定话题池
  const anchored = followUpFromText(userText);
  if (anchored) return anchored;

  const byTopic = FRESH_TOPICS.filter((t) => {
    for (const k of blocked) {
      if (TOPIC_PATTERNS[k] && TOPIC_PATTERNS[k].test(t)) return false;
    }
    return true;
  });

  // 再排除"这段人生已经聊过"的阶段（2026-10-04）：避免反复追问同一段人生
  const coveredStages = detectCoveredStages(messages);
  const byStage = byTopic.filter((t) => {
    for (const st of coveredStages) {
      if (STAGE_SIGNALS[st] && STAGE_SIGNALS[st].test(t)) return false;
    }
    return true;
  });

  // 三级兜底：优先未聊过的阶段 → 全部阶段 → 全池（保证永不返回空）
  const pool = byStage.length ? byStage : (byTopic.length ? byTopic : FRESH_TOPICS);
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (excludeText) {
    for (let i = 0; i < 4; i++) {
      const alt = pool[Math.floor(Math.random() * pool.length)];
      if (normalizeQ(alt) !== normalizeQ(excludeText)) { pick = alt; break; }
    }
  }
  return pick;
}

// 短语共享检测：模型新问题里若出现了用户上一轮回答中的实义词（2字片段），视为"顺着讲"，放行；
// 完全不含且非标准采集提问，才判定为"凭空跳到不相关话题"。比二元组 Jaccard 更准，避免误杀好的延展追问。
const STOP2 = new Set(['我是', '你是', '他是', '她是', '我们是', '你们', '他们', '的这', '这的', '了我', '了你', '了他', '了我', '是个', '时候', '什么', '怎么', '那个', '这个', '一句', '一个', '没有', '不是', '就是', '还是', '已经', '后来', '小时候', '那时候', '父亲', '母亲', '一句', '这回', '那天', '那年']);
function sharesPhrase(user, model) {
  const u = (user || '').replace(/[\s，。！？、；：""''「」()（）]/g, '');
  const m = (model || '').replace(/[\s，。！？、；：""''「」()（）]/g, '');
  for (let i = 0; i + 1 < u.length; i++) {
    const bi = u.slice(i, i + 2);
    if (STOP2.has(bi)) continue;
    if (m.includes(bi)) return true;
  }
  return false;
}

// 🔴 2026-10-04 重构：护栏不再直接丢弃模型回复
// 旧实现问题：guardReply 命中任何一条拦截就直接 return FRESH_TOPICS 里随机挑的一句预设题，
//              导致模型写好的、有温度的回应被整段扔掉 —— 这才是"AI 像机器人"的真根因
//              （不是模板本身有问题，而是模板替换掉了自然回复）。
// 新策略（分级处理，从温和到强硬）：
//   1. 硬违规（编造父母姓名）→ 仍做确定性字面纠正，这是事实错误，必须挡
//   2. 软违规（重复问 / 问已聊过字段 / 跳跃）→ 优先让模型自己重写那句问话（rewriteQuestion）
//      · 重写成功且通过复检 → 用重写结果，保留原有共情铺垫
//      · 重写失败 / 复检仍不过 → 才退回锚定追问（followUpFromText）或预设题
//   3. 拒绝作答 → 换方向是对的，直接给具体新话题，无需重写
// 代价：软违规轮次会多一次模型调用（按 token 计费），换来自然度；可用 REWRITE 开关关闭。

// 判断某句回复是否"实质内容"（重写时用来兜底：模型只回一句空话就放弃）
function hasSubstance(s) {
  return (s || '').replace(/[\s，。！？、；：""''「」()（）]/g, '').length >= 6;
}

// 软违规检测：返回 { reason, anchored } 或 null。
// 只做"检测"不做"替换"——替换交给 rewriteQuestion 或兜底模板。
function detectSoftViolation(text, ctx) {
  const { filled, coveredFields, messages, lastUserText } = ctx || {};
  const blocked = blockedTopics(filled, coveredFields);
  const lastQ = lastAssistantQuestion(messages || []);

  // 2a) 问已聊过的字段
  for (const k of blocked) {
    if (TOPIC_PATTERNS[k] && TOPIC_PATTERNS[k].test(text)) {
      return { reason: `你又在问「${TOPIC_LABELS[k] || k}」，这个我们已经聊过了`, anchored: followUpFromText(lastUserText) };
    }
  }

  // 2b) 与上一轮助手问题高度重复
  const lastQnorm = normalizeQ(lastQ);
  if (lastQnorm) {
    const sim = questionSimilarity(lastQ, text);
    if (sim >= 0.82) {
      return { reason: '这个问题和刚才问的几乎一样，换一个角度', anchored: followUpFromText(lastUserText) };
    }
  }

  // 2c) 跳跃：与用户上一句毫无共享实义词、也不是标准采集类提问
  if (!isRefusing(lastUserText)) {
    const isStdCollect = Object.values(TOPIC_PATTERNS).some((re) => re.test(text));
    const related = sharesPhrase(lastUserText, text);
    if (!isStdCollect && !related) {
      return { reason: '这个问题和你刚讲的内容对不上，像是从清单里硬挑的', anchored: followUpFromText(lastUserText) };
    }
  }
  return null;
}

// TOPIC_PATTERNS 的中文标签（给重写提示词用，让模型知道别再问什么）
const TOPIC_LABELS = {
  name: '姓名', gender: '性别', birth: '出生年月', birthplace: '籍贯',
  parents: '父母姓名', siblings: '兄弟姐妹', spouse: '配偶', children: '子女',
};

// 让模型重写"最后那句问话"，保留前面的共情铺垫。
// 只在软违规时调用；失败由调用方兜底。
async function rewriteQuestion(reply, violation, ctx) {
  const { lastUserText, targetName } = ctx || {};
  const cfg = getLLMConfig();
  if (!cfg || cfg.demoMode || !cfg.apiKey) return '';
  const sys = {
    role: 'system',
    content: `你在修一段访谈对话。老人刚才说：${(lastUserText || '').slice(0, 200)}

要求：
1. 保留原回复里对老人的共情、回应部分（这是最重要的，别删）
2. 只把【最后那句提问】改掉。问题：${violation.reason}
3. 新问题必须：接着老人刚说的内容往下问、具体好回答、一次只问一个、绝不编造
4. 语气像老朋友聊天，不要像采访提纲
5. 直接输出改写后的完整回复，不要解释`,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const data = await chatCompletion([sys], { signal: ctrl.signal });
    clearTimeout(timer);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const out = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!hasSubstance(out)) return '';
    // 复检：重写结果若仍命中同一条软违规，说明改不动，直接放弃走兜底
    const still = detectSoftViolation(out, ctx);
    if (still && still.reason === violation.reason) return '';
    return out;
  } catch (e) {
    console.warn('[llm] 问句重写失败，用兜底：', e.message);
    return '';
  }
}

function guardReply(reply, ctx) {
  const { filled, coveredFields, messages, lastUserText, target } = ctx || {};
  let text = (reply || '').trim();
  if (!text) text = '我听着呢，你接着说。';

  const blocked = blockedTopics(filled, coveredFields);
  const lastQ = lastAssistantQuestion(messages || []);

  // 1) 用户明确拒绝/已答过 → 强制换话题（最高优先级；换方向本身是对的，直接给具体新话题）
  if (isRefusing(lastUserText)) {
    return pickFreshTopic(blocked, lastQ, lastUserText, messages);
  }

  // 2) 硬违规：模型擅自说出未核实的父母姓名 → 替换为泛称（仅在父母姓名未知时）
  //    这是事实错误，必须确定性纠正，不走重写。
  const f = filled || {};
  const knownParents = (f['父母'] || '').split(/[、，]/).map((s) => s.trim()).filter(Boolean);
  if (!knownParents.length) {
    // 仅当姓名后紧跟标点/的/空白/句尾时才替换，避免把"你爸王建国年轻时候"里的人名误删导致句子残缺
    text = text.replace(/(你爸|你妈|你父亲|你母亲|你父母)是?叫?([^\s，。！？、；：]{2,4})(?=[，。！？、；：\s的的]|$)/g, (m, pre, name) => {
      if (name && !/^(叫|是|，|\s)/.test(name)) return pre; // 像人名则改为泛称
      return m;
    });
  }

  // 3) 软违规 → 先尝试重写，失败再兜底（见文件头 2026-10-04 说明）
  const violation = detectSoftViolation(text, ctx);
  if (violation) {
    // 此处 sync 版只做兜底；runInterview 走的是 rewriteVersion=true 分支（见下）
    return violation.anchored || pickFreshTopic(blocked, lastQ, lastUserText, messages);
  }

  return text;
}


// 已填静态档案 → 喂给访谈引擎，避免 AI 重复问已填资料（B 任务：补充访谈先看已有资料）
// 覆盖 persons 表列 + profile_json 中的 spouse_name/ethnicity + 亲属关系锚点。
const PROFILE_FACT_FIELDS = ['name', 'nickname', 'gender', 'birth_date', 'death_date', 'birthplace', 'residence', 'occupation', 'education', 'phone', 'bio'];
function buildProfileFilled(target) {
  const filled = {};
  if (!target) return filled;
  for (const k of PROFILE_FACT_FIELDS) {
    if (target[k]) filled[k] = target[k];
  }
  try {
    const prof = target.profile_json ? JSON.parse(target.profile_json) : {};
    if (prof.spouse_name) filled['spouse_name'] = prof.spouse_name;
    if (prof.ethnicity) filled['ethnicity'] = prof.ethnicity;
  } catch (_) {}
  // 亲属关系锚点（让模型明确看到"父母：父亲、母亲"这类，避免重复问）
  try {
    const db = require('./db');
    const relRows = db.prepare("SELECT p.name, r.type, r.from_person_id, r.to_person_id FROM relationships r JOIN persons p ON (p.id = r.from_person_id OR p.id = r.to_person_id) WHERE (r.from_person_id = ? OR r.to_person_id = ?) AND r.status != 'deleted' AND p.id != ? AND p.status != 'deleted'").all(target.id, target.id, target.id);
    for (const r of relRows) {
      if (r.type === 'parent' && r.to_person_id === target.id) filled['父母'] = (filled['父母'] ? filled['父母'] + '、' : '') + r.name;
      else if (r.type === 'parent' && r.from_person_id === target.id) filled['子女'] = (filled['子女'] ? filled['子女'] + '、' : '') + r.name;
      else if (r.type === 'spouse') filled['配偶'] = r.name;
    }
  } catch (_) {}
  return filled;
}

async function runInterview(messages, knownPersons, targetName, target, confirmedPaths, relayMode, coveredFields, corrections) {
  const isRelay = !!relayMode;
  const cfg = getLLMConfig();
  if (cfg.demoMode || !cfg.apiKey) {
    return demoInterview(messages, knownPersons, targetName, target, confirmedPaths, isRelay, coveredFields);
  }
  const lastUserText = (messages.filter((m) => m.role === 'user').slice(-1)[0] || {}).content || '';
  // 兜底开场白：仅当真实模型与降级都无内容时兜底，确保用户永远看到一句有温度的引导
  const FALLBACK_REPLY = '咱们慢慢聊——你愿意先从哪儿讲起都行，小时候、年轻时、还是近些年的事？比如你出生在哪儿，家里最常做的一道菜是什么？';
  // 总超时保护：真实模型（混元）可能在 key 失效/网络不可达时长时间挂起，
  // 这里用 Promise.race + AbortController，超时后不仅 reject，还会 abort 底层请求，
  // 立即停止占用腾讯云配额（避免 race 只 reject 不 abort 导致底层请求空耗配额触发限流）。
  //
  // 🔴 修复（2026-09-13）：回复与抽取**必须各自持有独立的 AbortController**。
  //   原先两者共用一个 ctrl，导致：回复若耗时接近/超过 30s 触发 abort()，
  //   会把**随后启动、本来正常**的抽取请求一并中断 →
  //   日志出现 `[extractor] ... 降级规则保底： This operation was aborted`，
  //   即"回复慢 → 抽取无故失败 → 静默退回正则"的隐性连锁失败。
  //   现在两个阶段各自计时、各自 abort，互不影响。
  const makePhase = () => {
    const c = new AbortController();
    return {
      ctrl: c,
      withTimeout: (p, ms, tag) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => { c.abort(); rej(new Error('timeout-' + tag + '-' + ms)); }, ms)),
      ]),
    };
  };
  try {
    const filled = buildProfileFilled(target);
    const confirmed = confirmedPaths instanceof Set ? [...confirmedPaths] : (confirmedPaths || []);
    const isOpening = messages.length <= 2; // 首轮（系统seed + 用户首条）视为开场引导
    const sys = { role: 'system', content: buildSystemPrompt(knownPersons, targetName, filled, confirmed, isRelay, isOpening, coveredFields, corrections) };
    let reply = FALLBACK_REPLY;
    const replyPhase = makePhase();
    try {
      const data = await replyPhase.withTimeout(chatCompletion([sys, ...messages], { signal: replyPhase.ctrl.signal }), 30000, 'reply');
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      if (msg && typeof msg.content === 'string' && msg.content.trim()) {
        const raw = msg.content.trim();
        const guardCtx = { filled, coveredFields, messages, lastUserText, target };
        // 2026-10-04：护栏改为"先重写、后兜底"，不再直接丢弃模型的自然回复。
        // 硬违规（编造父母姓名）仍走同步纠正；软违规（重复/问已聊过/跳跃）先让模型重写问句。
        reply = guardReply(raw, guardCtx);
        if (reply !== raw) {
          // guardReply 已改动内容 → 说明命中违规，走"模型重写"尝试救回自然度
          const violation = detectSoftViolation(raw, guardCtx);
          if (violation && !isRefusing(lastUserText)) {
            const rewritten = await rewriteQuestion(raw, violation, guardCtx);
            if (rewritten) {
              reply = guardReply(rewritten, guardCtx); // 复检：确保重写结果本身合规
              if (reply !== rewritten && !hasSubstance(rewritten)) reply = rewritten;
            } else {
              reply = violation.anchored || guardReply(raw, guardCtx);
            }
          }
        }
      } else {
        console.error('[llm] 真实模型返回空 content，降级演示模式');
        return demoInterview(messages, knownPersons, targetName, target, confirmedPaths, isRelay, coveredFields);
      }
    } catch (e) {
      console.error('[llm] 回复生成失败/超时，降级演示模式：', e.message);
      return demoInterview(messages, knownPersons, targetName, target, confirmedPaths, isRelay, coveredFields);
    }

    let extract;
    const extractPhase = makePhase();
    try {
      extract = await extractPhase.withTimeout(extractFromText(lastUserText, {
        knownPersons,
        targetName: targetName || (target && target.name) || '',
        target,
        confirmedPaths,
        signal: extractPhase.ctrl.signal,
      }), 30000, 'extract');
    } catch (e) {
      console.error('[llm] 抽取失败/超时，用空抽取兜底：', e.message);
      extract = normalizeExtract(emptyExtract());
    }

    // 确定性补全：模型抽取可能漏掉父母姓名等关键亲属，用规则抽取兜底合并，
    // 保证"用户答过、文字确认过"的亲属姓名能可靠落库（解决"没进数据库"问题）。
    try {
      const rule = ruleExtract(lastUserText, targetName || (target && target.name) || '');
      if (rule && rule.relations && rule.relations.length) {
        const have = new Set((extract.relations || []).map((r) => (r.rel || '') + '|' + (r.name || '')));
        for (const r of rule.relations) {
          if (r.name && !have.has((r.rel || '') + '|' + r.name)) {
            extract.relations = extract.relations || [];
            extract.relations.push(r);
          }
        }
      }
      if (rule && rule.person && rule.person.name && !extract.person.name) extract.person.name = rule.person.name;
    } catch (_) {}

    // 【关键修复】抽取出的名字统一过一遍纠正映射，防止同音字错字（炳→冰、母亲昵称→星星）落库；
    // 同时对 name/nickname/亲属名做精确匹配替换。corrections 一并挂载到 extract，供 applyExtraction 去重就地改名。
    try {
      if (Array.isArray(corrections) && corrections.length) {
        const cmap = new Map(corrections.map((c) => [c.from, c.to]).filter(([f]) => f));
        const fix = (s) => (s && cmap.has(s)) ? cmap.get(s) : s;
        if (extract.person) {
          if (extract.person.name) extract.person.name = fix(extract.person.name);
          if (extract.person.nickname) extract.person.nickname = fix(extract.person.nickname);
        }
        if (Array.isArray(extract.relations)) {
          for (const r of extract.relations) { if (r.name) r.name = fix(r.name); }
        }
      }
    } catch (_) {}
    extract.__corrections = (Array.isArray(corrections) && corrections.length) ? corrections : [];

    return { reply, extract };
  } catch (e) {
    console.error('[llm] 真实模型调用失败，降级演示模式：', e.message);
    return demoInterview(messages, knownPersons, targetName, target, confirmedPaths, isRelay, coveredFields);
  }
}

// opts:
//   timeoutMs      — LLM 调用超时（默认 30000）。hy3 是推理模型，reasoning_content 耗时长，
//                    生成 250-400 字正文常超 30s —— 批量重建必须传更长的超时（如 180000）。
//   allowFallback  — 超时/解析失败时是否降级 demoSummarize（默认 true）。
//                    在线访谈路径保持降级（不能让用户干等）；批量重建必须传 false，
//                    否则会静默写入一堆兜底标题的降级章节（2026-09-13 重建首跑 12 章全降级的教训）。
//   existingTitles — 该人物已有章节的标题列表。传给 LLM 做「跨章去重」：已写过的内容不准再写。
// ── 章节质量硬校验（代码层确定性检测，不依赖 LLM 自觉）────────────────────
// 背景（2026-09-13 用户反馈）：几乎每章内部都有换说法复述、非主题内容被硬塞进一章、偶发臆造。
// prompt 规则是软约束，LLM 遵守是概率性的；这里用程序硬检测三类问题，不合格就带原因重试。
// 检测项：① 章内复述（句子两两相似度过高/互为子串）② 臆造年份（正文年份在讲述原文中找不到）③ 正文超长。
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.replace(/[\s，、—…·「」『』（）()《》"'"'：:？！?!。；;]/g, ''))
    .filter((s) => s.length >= 6);
}

function bigramSet(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function overlapCoef(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function longestCommonSubstring(a, b) {
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

function validateChapter(summary, sourceTexts, maxLen) {
  const problems = [];
  const text = String(summary || '');
  if (!text) return problems; // 噪声窗允许空正文
  const sents = splitSentences(text);
  // ① 章内复述检测。三个信号（命中任一即判复述）：
  //    a) 互为子串；b) 最长公共子串 ≥10 字（中文 10 字连续同文几乎必是复用）；
  //    c) bigram 重叠系数 > 0.6（一方几乎被另一方覆盖）。
  //    局限（诚实记录）：纯意译级复述（如「不挑食」→「从不挑拣」字面几乎不重叠）词面信号抓不到，
  //    依赖 prompt 规则 7 + 用户页面编辑兜底。
  for (let i = 0; i < sents.length; i++) {
    for (let j = i + 1; j < sents.length; j++) {
      const a = sents[i];
      const b = sents[j];
      const lcs = longestCommonSubstring(a, b);
      if (a.includes(b) || b.includes(a) || lcs >= 10 || overlapCoef(bigramSet(a), bigramSet(b)) > 0.6) {
        problems.push(`复述：「${a.slice(0, 16)}…」与「${b.slice(0, 16)}…」（公共片段 ${lcs} 字）`);
      }
    }
  }
  // ② 臆造年份检测：正文中出现的年份必须能在讲述原文（含访谈对话回显）里找到出处
  const src = (sourceTexts || []).join('\n');
  const years = text.match(/(?:19|20)\d{2}(?!\d)/g) || [];
  for (const y of new Set(years)) {
    if (!src.includes(y)) problems.push(`臆造年份：${y} 未在讲述原文中出现`);
  }
  // ③ 超长检测：契约 250-400 字，超过 650 视为失控（多半在注水/复述）
  //    「逐章补讲」是就地扩写，正文会合理地变长，故调用方可传 maxLen 放宽（默认仍是 650）。
  const cap = Number.isFinite(maxLen) ? maxLen : 650;
  if (text.length > cap) problems.push(`正文 ${text.length} 字，远超 ${Math.round(cap * 0.62)} 字契约`);
  return problems;
}

async function summarizeChapter(messages, hint, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 30000;
  const allowFallback = opts.allowFallback !== false;
  const cfg = getLLMConfig();
  if (cfg.demoMode || !cfg.apiKey) {
    return demoSummarize(messages, hint);
  }
  // 【2026-09-14 修复】规则 #9 的"已被覆盖就把 summary 写成空字符串"是空白章节的真正元凶：
  // hy3 会把用户新讲的内容误判为"现有章节已覆盖"，于是按规则交回空正文，压过了"严禁为空"的指令。
  // 现改为：允许它写"简短补充"，但绝不允许交空正文。dedupRule 单独成变量，便于兜底重试时整段摘除。
  const dedupRule = (Array.isArray(opts.existingTitles) && opts.existingTitles.length)
    ? '\n9. 【跨章去重】这本回忆录已有章节：「' + opts.existingTitles.join('」「') + '」——' +
      '这些主题已经写过，本节不要再重复已覆盖的情节；若本段素材大部分已被覆盖，就只写新增的细节，' +
      '写成 50-150 字的简短补充（标题可在原主题后加「·补」）。' +
      '【任何情况下都不准因为"已被写过"而把 summary 交成空字符串】——空正文会被系统丢弃，等于用户这段话白讲。'
    : '';
  try {
    const sys = {
      role: 'system',
      content:
        '你是传记整理者。把这段口述访谈整理成回忆录中的一节。\n' +
        '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块围栏。\n' +
        '结构如下（year 为整数年份，无法确定则填 null）：\n' +
        CHAPTER_FIELDS_TEXT +
        '\n写作要求：' +
        '\n1. summary 是【回忆录正文】，不是要点罗列：以讲述者第一人称「我」叙述、流畅成文。素材充足时写 250-400 字；若用户只给了很短的一两句话，就写一段 50-150 字的简短回忆，围绕原话展开。无论素材多少，summary 都【严禁为空字符串】——唯一例外是第 6 点约定的「纯粹抱怨访谈流程」情形。' +
        '\n2. 忠实原话：只用用户提到的细节，绝不编造；用户没说的留白。' +
        '\n3. 【禁止臆造】用户没说过的心理活动、动作、感官与场景细节一律不准写——' +
        '   例如用户只说「第一天比较拘束」，就绝不准扩写成「踏进大门不免畏缩」「放轻了声音」「浑身不自在」这类他自己没用过的描写；' +
        '   素材少就写得短，宁可单薄也不准虚构。情绪词只能用用户自己的原词。' +
        '\n4. 不添加你自己的抒情与议论（不写「这一定很珍贵」这类话），情绪只呈现用户自己表达过的。' +
        '\n5. 标题具体、有画面感，禁止「人生的一段回忆」「我的故事」这类空泛标题。' +
        '\n6. 直接以「我」的口吻讲述事情本身，【绝不复述访谈对话过程】；' +
        '\n   仅当这段纯粹是用户在抱怨访谈体验/纠错流程、完全没有讲述自己的人生内容时，summary 才允许写空字符串。注意：素材偏少≠可写空——少就写短，照样要成一段回忆录正文。' +
        '\n6b. 人名用字必须与用户提供时完全一致，绝不写成同音字。' +
        '\n7. 【章内禁复述】同一个信息、情节、意思在正文里只准出现一次，绝不许换个说法再写一遍' +
        '（例如说过「不挑食」，就不准再写「从不挑拣」「吃得欢喜」这类同义复述）。' +
        '\n8. 【一章一主题】只围绕这段讲述里最主要的主题成文；主题之外的内容一律不写（留给别的章节），绝不生硬地塞进本章凑内容。' +
        dedupRule +
        '\n第一个字符必须是 {，最后一个字符必须是 }。',
    };
    const chapterCtrl = new AbortController();
    const data = await Promise.race([
      chatCompletion([sys, ...messages], { signal: chapterCtrl.signal }),
      new Promise((_, rej) => setTimeout(() => { chapterCtrl.abort(); rej(new Error('timeout-chapter-' + timeoutMs + 'ms')); }, timeoutMs)),
    ]);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const c = parseJsonLoose(msg && msg.content);
    if (c && (c.title || c.summary)) {
      const lastUser = messages.filter((m) => m.role === 'user').slice(-1)[0];
      const stage = inferStage(lastUser ? ruleExtract(lastUser.content, null) : {}, messages.filter((m) => m.role === 'user').map((m) => m.content));
      let year = Number.isFinite(c.year) ? c.year : extractYearFromTexts(messages);
      let result = { title: c.title || STAGE_TITLE[stage] || '一段回忆', summary: c.summary || '', excerpt: c.excerpt || '', stage, year: year || null };
      // ── 硬校验闸门：不合格带具体违规原因重试一次；仍不合格取问题较少的一稿并记日志 ──
      const sourceTexts = messages.map((m) => m.content);
      let problems = validateChapter(result.summary, sourceTexts);
      if (problems.length) {
        console.warn('[llm] 章节质量校验未通过，重试：', problems.join('；'));
        const retrySys = {
          role: 'system',
          content:
            sys.content +
            '\n\n【重写要求】你上一稿存在以下硬伤，必须修正后重新输出整个 JSON：\n- ' +
            problems.join('\n- ') +
            '\n（同一信息只准出现一次；只写这一段最主要主题；年份只能用讲述原文里出现过的。）',
        };
        try {
          const retryCtrl = new AbortController();
          const data2 = await Promise.race([
            chatCompletion([retrySys, ...messages], { signal: retryCtrl.signal }),
            new Promise((_, rej) => setTimeout(() => { retryCtrl.abort(); rej(new Error('timeout-chapter-retry-' + timeoutMs + 'ms')); }, timeoutMs)),
          ]);
          const msg2 = data2.choices && data2.choices[0] && data2.choices[0].message;
          const c2 = parseJsonLoose(msg2 && msg2.content);
          if (c2 && (c2.title || c2.summary)) {
            const attempt2 = { title: c2.title || result.title, summary: c2.summary || '', excerpt: c2.excerpt || result.excerpt, stage, year: Number.isFinite(c2.year) ? c2.year : year };
            const problems2 = validateChapter(attempt2.summary, sourceTexts);
            // 🔒 关键：绝不允许重试稿把正文（summary）退化为空——空正文章节毫无价值，
            // 宁可保留首稿（即便有少量问题，用户仍可页面编辑）。
            const retryKeepsSummary = attempt2.summary && attempt2.summary.trim().length > 0;
            if (retryKeepsSummary && (!problems2.length || problems2.length < problems.length)) {
              result = attempt2;
              problems = problems2;
            }
          }
        } catch (e) {
          console.error('[llm] 章节重写失败：', e.message);
        }
        if (problems.length) {
          // 不抛错：在线路径不能让用户干等；批量路径由调用方 allowFallback/后续把关
          console.warn('[llm] 章节重试后仍有问题，取较优一稿：', problems.join('；'));
        }
      }
      // ── 空白章节兜底（2026-09-14）：hy3 仍可能「给了标题、正文交空」──────────
      // 这种"有题无文"的稿子毫无价值（前端渲染成一节空白），而它恰恰是由规则 #9 触发的。
      // 关键是：单靠 prompt 里的"严禁为空"压不住规则 #9（实测两次仍空），
      // 所以这里做**确定性**兜底 —— 把规则 #9 整段摘掉再重试一次，拿到正文就采纳。
      // 仍为空则原样返回，由调用方决定（在线路径不落库空白章节）。
      if (!String(result.summary || '').trim() && String(result.title || '').trim() && dedupRule) {
        console.warn('[llm] 首稿有标题但正文为空（跨章去重过度执行）→ 摘掉规则 #9 重试一次');
        try {
          const noDedupSys = { role: 'system', content: sys.content.replace(dedupRule, '') };
          const ctrl3 = new AbortController();
          const data3 = await Promise.race([
            chatCompletion([noDedupSys, ...messages], { signal: ctrl3.signal }),
            new Promise((_, rej) => setTimeout(() => { ctrl3.abort(); rej(new Error('timeout-chapter-nodedup-' + timeoutMs + 'ms')); }, timeoutMs)),
          ]);
          const msg3 = data3.choices && data3.choices[0] && data3.choices[0].message;
          const c3 = parseJsonLoose(msg3 && msg3.content);
          if (c3 && String(c3.summary || '').trim()) {
            result = {
              title: c3.title || result.title,
              summary: c3.summary,
              excerpt: c3.excerpt || result.excerpt,
              stage,
              year: Number.isFinite(c3.year) ? c3.year : year,
            };
            problems = validateChapter(result.summary, sourceTexts);
            console.warn('[llm] 摘掉规则 #9 后正文已恢复，长度', result.summary.length);
          }
        } catch (e) {
          console.error('[llm] 摘掉去重规则重试失败：', e.message);
        }
      }
      return result;
    }
    console.error('[llm] 章节总结返回无法解析的 JSON：', String(msg && msg.content || '').slice(0, 150));
    if (!allowFallback) throw new Error('chapter-json-unparseable');
    return demoSummarize(messages, hint);
  } catch (e) {
    console.error('[llm] 章节总结失败：', e.message);
    if (!allowFallback) throw e;
    return demoSummarize(messages, hint);
  }
}

// ============================================================
// 逐章「补讲」：把用户新讲的一段，**就地融合进已有章节正文**
// ------------------------------------------------------------
// 与 summarizeChapter 的区别：
//   summarizeChapter = 把新素材【另起一节】；
//   extendChapter    = 把新素材【织进这一节】，产出这一节的新正文。
// 用户诉求（2026-09-14）："回忆录每一段能否补讲？补讲后 AI 根据前后讲解再融合形成本段回忆"。
// 硬约束：旧正文的信息一条都不能丢 —— 这是与"另起一节"最本质的不同，也是本提示词的重点。
// 返回 { title, summary, excerpt, year, stage, sameTopic, problems }
// ============================================================
async function extendChapter(prev, newText, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 180000;
  const allowFallback = opts.allowFallback !== false;
  const text = String(newText || '').trim();
  const oldSummary = String((prev && prev.summary) || '').trim();
  const base = {
    title: (prev && prev.title) || '一段回忆',
    summary: oldSummary,
    excerpt: (prev && prev.excerpt) || '',
    stage: (prev && prev.stage) || 'life',
    year: Number.isFinite(prev && prev.year) ? prev.year : null,
  };
  if (!text) return { ...base, sameTopic: true, problems: [] };

  const cfg = getLLMConfig();
  if (cfg.demoMode || !cfg.apiKey) {
    // 演示模式：不做改写，直接把新讲述接到旧正文后（保证链路可跑通、数据不丢）
    return { ...base, summary: (oldSummary + ' ' + text).trim(), excerpt: base.excerpt || text.slice(0, 80), sameTopic: true, problems: [] };
  }

  const sys = {
    role: 'system',
    content:
      '你是传记整理者。下面是某本回忆录中【已有的一节】，以及讲述者刚刚针对这一节【补充的讲述】。\n' +
      '请把两者【融合成这一节的新正文】——不是在后面接一段，而是重新组织成一整篇连贯的回忆。\n' +
      '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块围栏。\n' +
      '结构如下：' +
      CHAPTER_FIELDS_TEXT.replace(/\n\s*"year": 1998\n?/, '\n  "year": 1998,\n  "same_topic": true\n') +
      '\n（same_topic：补充的内容与本节主题是不是同一件事。是填 true，明显是另一件事填 false。）\n' +
      '融合要求：' +
      '\n1. 【旧正文信息一条都不能丢】已有的细节、语气、原话，全部保留在这篇新正文里——这是最重要的要求。' +
      '\n2. 【不许重复】新旧素材讲同一件事时只写一处，绝不许把同一个信息换种说法写两遍（旧正文里已经写过的句子，不要原样再抄一遍）。' +
      '\n3. 第一人称「我」叙述，流畅成文。长度随内容自然增长（一般 250-600 字），绝不为凑字数注水。' +
      '\n4. 【禁止臆造】新旧素材都没提到的人名、年份、地点、心理活动、动作与场景细节一律不准写；情绪词只能用讲述者自己的原词。' +
      '\n5. 不添加你自己的抒情与议论。' +
      '\n6. 标题：除非新内容明显让原标题不贴切，否则【沿用原标题】。' +
      '\n7. 【绝不准交空 summary】。' +
      '\n8. 直接以「我」的口吻讲事情本身，绝不复述访谈对话过程。人名用字必须与讲述者提供时完全一致。' +
      '\n第一个字符必须是 {，最后一个字符必须是 }。',
  };
  const payload = {
    role: 'user',
    content:
      '【本节标题】' + base.title + '\n' +
      '【本节已有正文】\n' + (oldSummary || '（本节暂无正文）') + '\n' +
      (base.excerpt ? '【已有摘录】' + base.excerpt + '\n' : '') +
      '【讲述者刚刚补充的内容】\n' + text,
  };
  const sourceTexts = [oldSummary, text].filter(Boolean);
  const call = async (extraSys) => {
    const ctrl = new AbortController();
    const data = await Promise.race([
      chatCompletion([extraSys ? { role: 'system', content: extraSys } : sys, payload], { signal: ctrl.signal }),
      new Promise((_, rej) => setTimeout(() => { ctrl.abort(); rej(new Error('timeout-extend-' + timeoutMs + 'ms')); }, timeoutMs)),
    ]);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return parseJsonLoose(msg && msg.content);
  };

  try {
    let c = await call(null);
    if (!c) {
      console.error('[llm] 补讲融合返回无法解析的 JSON');
      if (!allowFallback) throw new Error('extend-json-unparseable');
      return { ...base, summary: (oldSummary + ' ' + text).trim(), sameTopic: true, problems: [] };
    }
    const pack = (o) => ({
      title: (o.title && String(o.title).trim()) || base.title,
      summary: String(o.summary || '').trim(),
      excerpt: (o.excerpt && String(o.excerpt).trim()) || base.excerpt,
      stage: base.stage,
      year: Number.isFinite(o.year) ? o.year : base.year,
    });
    let result = pack(c);
    let sameTopic = c.same_topic !== false;
    let problems = validateChapter(result.summary, sourceTexts, 1200);
    // 未过闸门 → 带具体违规原因重写一次（与 summarizeChapter 同一套路）
    if (problems.length) {
      console.warn('[llm] 补讲融合未过闸门，重试：', problems.join('；'));
      try {
        const c2 = await call(
          sys.content +
          '\n\n【重写要求】你上一稿存在以下硬伤，必须修正后重新输出整个 JSON：\n- ' + problems.join('\n- ') +
          '\n（尤其注意：旧正文里的每一条信息都必须保留，但同一信息只准出现一次。）'
        );
        if (c2 && String(c2.summary || '').trim()) {
          const attempt2 = pack(c2);
          const p2 = validateChapter(attempt2.summary, sourceTexts, 1200);
          if (!p2.length || p2.length < problems.length) { result = attempt2; problems = p2; sameTopic = c2.same_topic !== false; }
        }
      } catch (e) {
        console.error('[llm] 补讲融合重写失败：', e.message);
      }
    }
    // 🔒 空正文保护：融合稿不准把正文弄丢 —— 丢了就退回旧正文（宁可不融合，也不能删用户的记忆）
    if (!result.summary) {
      console.warn('[llm] 补讲融合返回空正文 → 保留旧正文，不做融合');
      return { ...base, sameTopic, problems: problems.concat(['融合稿正文为空，已保留原正文']) };
    }
    return { ...result, sameTopic, problems };
  } catch (e) {
    console.error('[llm] 补讲融合失败：', e.message);
    if (!allowFallback) throw e;
    return { ...base, summary: (oldSummary + ' ' + text).trim(), sameTopic: true, problems: [] };
  }
}

// 推断本轮讲述所属"阶段"，用于把同一阶段的内容追加到已有章节而非新建
// 阶段：childhood / youth / young / marriage / mid / old / life
function inferStage(extract, userTexts) {
  const e = extract || {};
  const rels = e.relations || [];
  const joined = (userTexts || []).join('\n');
  // 关键：如果整段明显是在讲某位亲属自己的经历，不归到讲述者的任何人生阶段，返回 'life'（由调用方 isSelfStory 决定是否跳过建章）
  if (!isSelfStory(userTexts)) return 'life';
  if (rels.some((r) => r.rel === 'spouse')) return 'marriage';
  if (/(?:退休|晚年|老了|上岁数|养老|带孙子|抱重孙|含饴弄孙|夕阳红)/.test(joined)) return 'old';
  if (/(?:成家|结婚|新婚|生子|育儿|带孩子|老公|老婆|丈夫|妻子|对象|谈对象|找对象|处对象)/.test(joined)) return 'marriage';
  if (/(?:中年|不惑|四十|五十|在单位|上班|升职|调动|下岗|养家糊口|事业|创业)/.test(joined)) return 'mid';
  if (/(?:大学|中学|高中|少年|青春期|初中|初二|初三|高一|高二|高三|青涩|豆蔻|十七八|二八年华)/.test(joined)) return 'youth';
  if (rels.some((r) => r.rel === 'father' || r.rel === 'mother')) return 'childhood';
  if (/(?:童年|小时候|幼年|儿时|上小学|小学时|小学|出生|故乡|老家|启蒙|老家|乡下|农村)/.test(joined)) return 'childhood';
  if (/(?:工作|刚毕业|初入社会|二十来岁|二十出头|三十以前|青年|打拼|闯荡)/.test(joined)) return 'young';
  return 'life';
}

// 判断一段讲述是不是"讲述者本人的亲身经历"。用户聊到亲属自己的经历时（如"我外公小时候""我爸年轻时"），
// 不应被采编成"我"的回忆录章节，只能作为关系/备注轻量记录。
const RELATIVE_TERMS = /(?:爸|妈|爸爸|妈妈|父亲|母亲|外公|外婆|爷爷|奶奶|祖父|祖母|外祖父|外祖母|舅舅|阿姨|姑姑|叔叔|伯父|姑妈|伯母|哥哥|弟弟|姐姐|妹妹|丈夫|妻子|老公|老婆|儿子|女儿|晚辈|长辈)/;
// 1) 听说前缀："听妈妈说""爸爸跟我讲起""他一直跟我提起……我的外公"
const HEARSAY_VERB = /(?:听|跟|由|从|通过)(?:我|他|她|TA|人|人家)?(?:的)?(?:说|讲|提起|说起|提到|告诉|回忆|描述)/;
// 2) 亲属作主语的经历："我外公小时候""我妈妈年轻时""我爸年轻时""他父亲一辈子"
const RELATIVE_SUBJECT = /(?:(?:我|他|她|那人)(?:的)?|(?:我|他|她)(?:的)?(?:爸|妈|爸爸|妈妈|父亲|母亲|外公|外婆|爷爷|奶奶|祖父|祖母|舅舅|阿姨|姑姑|叔叔|伯父|姑妈|伯母|哥哥|弟弟|姐姐|妹妹|丈夫|妻子|老公|老婆|儿子|女儿)(?:的)?)(?:外公|外婆|爷爷|奶奶|祖父|祖母|外祖父|外祖母|舅舅|阿姨|姑姑|叔叔|伯父|姑妈|伯母|爸|妈|爸爸|妈妈|父亲|母亲|哥哥|弟弟|姐姐|妹妹|丈夫|妻子|老公|老婆|儿子|女儿).{0,12}(?:小时候|年轻时|年青时|年轻时候|青年时|一辈子|一生|经历|遭遇|做过|干过|喜欢|爱好|会|记得|那年代|那时候|那时|当年|那个年代|活着|去世|逝世|离世|从军|下乡|插队|文革|抗战)/;
// 3) 第三人称亲身经历：句子主语是"他/她/那人"且描述其童年/青年等——用户讲自己时不会用"他小时候"
const THIRD_PERSON_CHILDHOOD = /(?:他|她|那人).{0,15}(?:小时候|年轻时|年青时|年轻时候|少年时|童年|幼年)/;
// 3) 讲述者自己的经历兜底："我妈说我小时候很乖"——虽然出现"跟我说"，但内容是"我"的童年。
//    排除"跟我""听我说"等 hearsay 短语里的"我"，避免"他跟我提起小时候"被误当成"我的小时候"。
const SELF_EXPERIENCE = /(?:^|[^跟听从通过\s])(?:我|本人)(?!.{0,8}(?:爸|妈|爸爸|妈妈|父亲|母亲|外公|外婆|爷爷|奶奶|祖父|祖母|外祖父|外祖母|舅舅|阿姨|姑姑|叔叔|伯父|姑妈|伯母|哥哥|弟弟|姐姐|妹妹|丈夫|妻子|老公|老婆|儿子|女儿)).{0,12}(?:小时候|年轻时|年青时|年轻时候|少年时|童年|幼年|出生|成长)/;
function isSelfStory(userTexts) {
  const joined = (userTexts || []).join('\n');
  if (!joined.trim()) return true; // 无内容时默认按本人处理，避免漏采
  // 先兜底：明确是"我"自己的童年/青年经历（排除"我爸/我妈"挡在中间的情况）
  if (SELF_EXPERIENCE.test(joined)) return true;
  // 亲属作主语的经历描述："我外公小时候""我爸年轻时""我妈妈小时候"
  if (RELATIVE_SUBJECT.test(joined)) return false;
  // 第三人称亲身经历："他小时候看到他的父亲……"
  if (THIRD_PERSON_CHILDHOOD.test(joined) && RELATIVE_TERMS.test(joined)) return false;
  // 显式 hearsay（且文本里确实出现了亲属）："他一直跟我提起我的外公……"
  if (HEARSAY_VERB.test(joined) && RELATIVE_TERMS.test(joined)) return false;
  return true;
}

const STAGE_TITLE = {
  childhood: '童年时光',
  youth: '少年岁月',
  young: '青年年华',
  marriage: '成家立业',
  mid: '中年时光',
  old: '晚年生活',
  life: '人生的一段回忆',
  // 旧阶段枚举别名（兼容历史章节）
  parents: '童年时光',
  hometown: '青年年华',
  children: '中年时光',
};

async function testConnection() {
  const cfg = getLLMConfig();
  if (cfg.demoMode || !cfg.apiKey) {
    return { ok: false, demo: true, message: '当前为演示模式（未配置 API Key），无需联网测试。' };
  }
  try {
    const data = await chatCompletion([{ role: 'user', content: 'ping' }], {});
    const ok = !!(data && data.choices && data.choices[0]);
    return { ok, demo: false, message: ok ? `连接成功（模型：${cfg.model || '默认'}）` : '返回异常：缺少 choices 字段' };
  } catch (e) {
    return { ok: false, demo: false, message: e.message };
  }
}

module.exports = { runInterview, summarizeChapter, extendChapter, validateChapter, splitSentences, testConnection, getLLMConfig, relLabel, buildSystemPrompt, inferStage, STAGE_TITLE, ruleExtract, buildRuleReview, isSelfStory };
