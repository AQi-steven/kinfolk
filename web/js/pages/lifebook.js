// web/js/pages/lifebook.js — 个人传记主页（全站唯一的人物详情页，2026-09-13 合并后）
// 本人节点：完整传记 + 「✏️ 补充访谈」纯文本补录入口
// 他人节点：默认只读（仅结构）；写他人生平需先走授权门禁（relay_requests）；补 stub 免授权
//
// 2026-09-13 合并说明：原先存在 #/person/:id 与 #/lifebook/:id 两套并行人物页，
// 功能重叠但互不联通（person 有「编辑/生成认领链接」无章节区，lifebook 反之）。
// 现统一到本页，person.js 已删除，旧链接由 app.js 路由 replace 跳转到此。
window.Pages = window.Pages || {};
window.Pages.lifebook = async function (main, id) {
  if (!id) { location.hash = '#/home'; return; }
  const uid = window.Store.user && window.Store.user.id;
  const selfId = window.Store.self;
  const isSelfNode = String(id) === String(selfId);

  let data;
  try { data = await API.get('/persons/' + id); }
  catch (e) { main.appendChild(h('div', { class: 'error' }, '加载失败：' + e.message)); return; }
  const p = data.person;
  if (!p) { main.appendChild(h('div', { class: 'error' }, '未找到该人物')); return; }
  const rels = data.relations || [];
  const restricted = !!data.restricted;

  // 展示名统一取 real_name（权威真名，注册时写入）优先，回退 name。
  // 背景：name 是展示字段，历史上曾被演示数据污染，出现「界面显示假名而 real_name 正确」。
  const displayName = p.real_name || p.name || '未命名';
  // 可维护判定：本人认领者 或 该节点的建档人（与后端 canWrite 口径一致）
  const canManage = (p.claimed_by_user_id && p.claimed_by_user_id === uid) || p.founder_user_id === uid;
  // 待认领：他人在访谈中提及 / 手动补录的骨架节点，等本人注册后自动联系
  const waitingClaim = !p.claimed && isWaitingClaim(p.status);

  // ===== 扉页 =====
  // 待认领状态只在此处呈现一次（含来源），行动按钮统一放在下面的操作行
  const waitLabel = p.status === 'pending_claim' ? '待加入' : '待本人自述';
  const waitFrom = p.source_user_name ? ('由 ' + p.source_user_name + ' 在访谈中提及') : '尚未由本人认领';
  main.appendChild(h('div', { class: 'lb-cover' },
    h('div', { class: 'lb-cover-inner' },
      h('div', { class: 'lb-eyebrow' }, '人生书'),
      h('div', { class: 'lb-name' }, displayName + (isSelfNode ? '（你）' : '')),
      h('div', { class: 'lb-meta' }, [p.gender || '未知', p.birth_date ? ' · ' + p.birth_date + ' 生' : '', p.death_date ? ' · ' + p.death_date + ' 逝' : ''].join('').trim() || '待本人自述'),
      p.birthplace ? h('div', { class: 'lb-sub' }, '籍贯 ' + p.birthplace) : null,
      p.occupation ? h('div', { class: 'lb-sub' }, '一生从事 ' + p.occupation) : null,
      waitingClaim ? h('div', { class: 'lb-sub' }, '⏳ ' + waitLabel + ' · ' + waitFrom) : null)));

  // ===== 维护操作行（编辑资料 / 生成认领链接）=====
  const opRow = h('div', { class: 'btn-row', style: { marginBottom: '12px' } });
  if (canManage) {
    opRow.appendChild(h('button', {
      class: 'btn-soft',
      onclick: () => {
        const selfName = (window.Store.user && window.Store.user.real_name) || '';
        window.openPersonEditor(p, selfName, () => {
          // 🔴 2026-09-14：必须清空 main 再重渲染。app.js 的路由每次都会先 main.innerHTML = ''，
          // 而这里是"绕过路由"直接调页面函数 —— 此前漏了清空，导致旧内容留在上方、
          // 新内容追加在下方，用户不滚动就只能看到老数据，误判为「保存无效」。
          main.innerHTML = '';
          const r = window.Pages.lifebook(main, id);
          if (r && typeof r.catch === 'function') r.catch(() => {});
          window.scrollTo(0, 0);
        });
      },
    }, '✏️ 编辑资料'));
  }
  if (waitingClaim && canManage) {
    opRow.appendChild(h('button', {
      class: 'btn-soft',
      onclick: () => inviteClaim(p.id, displayName),
    }, '🔗 生成认领链接'));
  }
  if (opRow.children.length) main.appendChild(opRow);


  // ===== 一句话简介 =====
  if (p.bio && !restricted) {
    main.appendChild(h('div', { class: 'lb-quote' }, '“' + (p.bio.length > 60 ? p.bio.slice(0, 60) + '…' : p.bio) + '”'));
  }

  // ===== 受限提示（他人未授权）=====
  if (restricted) {
    const card = h('div', { class: 'card warn-card' },
      h('h3', {}, '🔒 受权限保护'),
      h('div', { class: 'muted' }, '这是 ' + p.name + ' 的传记，需要本人授权才能查看与补充生平。你目前只能看到 ' + p.name + ' 在关系网中的位置。'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => requestRelay(id, p.name) }, '🔑 申请代录授权')));
    main.appendChild(card);
  } else {
    // ===== 生平补录（本人或已授权）=====
    const bioCard = h('div', { class: 'card' });
    const head = h('div', { class: 'section-head' },
      h('div', { class: 'section-title' }, '📝 生平'),
      h('button', { class: 'btn-soft btn-small', onclick: () => openExperienceModal(id, p, isSelfNode) }, '➕ 补充经历'));
    bioCard.appendChild(head);
    bioCard.appendChild(h('div', { class: 'sect-note' }, '这里是你自己填的基本资料（生日、籍贯、职业……），点右上角可以改。'));
    const fields = [
      ['birth_date', '出生日期'], ['death_date', '逝世日期'], ['birthplace', '籍贯'],
      ['residence', '居住地'], ['occupation', '职业'], ['education', '学历'],
      ['ethnicity', '民族'], ['spouse', '配偶'],
      ['phone', '联系电话'], ['bio', '一句话简介'],
    ];
    const profile = p.profile || {};
    let any = false;
    fields.forEach(([k, label]) => {
      const v = (p[k] != null && p[k] !== '') ? p[k] : (profile[k] != null ? profile[k] : '');
      if (v === '') return;
      any = true;
      bioCard.appendChild(h('div', { class: 'lb-field' },
        h('span', { class: 'lb-field-k' }, label + '：'),
        h('span', { class: 'lb-field-v' }, String(v))));
    });
    if (!any) bioCard.appendChild(h('div', { class: 'muted' }, '还没有沉淀的生平。点「➕ 补充经历」写一段，AI 会自动整理成章节；或点「✏️ 编辑资料」补全姓名/生日等静态档案。'));
    main.appendChild(bioCard);

    // ===== 人物侧写（访谈中沉淀的爱好/团体/城市/事件/履历）=====
    const profDefs = [
      ['hobbies', '爱好', (v) => (Array.isArray(v) ? v.join('、') : String(v))],
      ['organizations', '加入的团体', (v) => (Array.isArray(v) ? v.join('、') : String(v))],
      ['places', '走过的地方', (v) => (Array.isArray(v) ? v.join('、') : String(v))],
      ['life_events', '人生事件', (v) => (Array.isArray(v) ? v.join('、') : String(v))],
      ['career', '履历', (v) => (Array.isArray(v) ? v.map((c) => [c.year, c.org, c.role].filter(Boolean).join(' ')).join('；') : String(v))],
    ];
    // 已在上面「生平」里单独呈现的键不再重复进「人物侧写」
    const customKeys = Object.keys(profile).filter((k) => !['corrections', 'hobbies', 'organizations', 'places', 'life_events', 'career', 'spouse', 'ethnicity'].includes(k));
    if (profDefs.some(([k]) => profile[k] && (Array.isArray(profile[k]) ? profile[k].length : profile[k])) || customKeys.length) {
      const profCard = h('div', { class: 'card' },
        h('h3', {}, '🎭 人物侧写'),
        // 这个区块是"AI 在访谈里静默记下的关键词"，用户此前看不懂它是什么、值从哪来
        // （2026-09-14 用户提问："人物侧写是什么？其中「很重」是什么？"）→ 补一行说明。
        h('div', { class: 'sect-note' }, '访谈时 AI 顺手记下的一些线索（爱好、去过的地方、人生大事等），不用你管，它只是素材。'));
      profDefs.forEach(([k, label, fmt]) => {
        const v = profile[k];
        if (!v || (Array.isArray(v) && !v.length)) return;
        profCard.appendChild(h('div', { class: 'lb-field' },
          h('span', { class: 'lb-field-k' }, label + '：'),
          h('span', { class: 'lb-field-v' }, fmt(v))));
      });
      customKeys.forEach((k) => {
        const v = profile[k];
        if (v === undefined || v === null || v === '') return;
        profCard.appendChild(h('div', { class: 'lb-field' },
          h('span', { class: 'lb-field-k' }, k + '：'),
          h('span', { class: 'lb-field-v' }, String(v))));
      });
      main.appendChild(profCard);
    }
  }

  // ===== 关系脉络（结构信息，受限也可看）=====
  // 直接用后端 relationsOf 已回传的对方节点 name/status/claimed（r.id 即对方 person id）。
  // 此前依赖 window.__nodeName（由 home.js 大树页写入缓存），直接刷新本页会退化成「# 53」。
  if (rels.length) {
    // 同一对人物之间可能同时存在多条边（例如访谈抽出的 parent 边 + 早期导入的 acquaintance 边），
    // 会让同一位亲属在列表里出现两次。按「关系具体度」择优，一人只显示一条。
    // 这里只做展示层去重，不动数据库 —— 冗余边是否清理属数据治理，另行决定。
    const REL_ORDER = ['parent', 'spouse', 'sibling', 'child', 'ancestor', 'descendant', 'acquaintance'];
    const rank = (t) => { const i = REL_ORDER.indexOf(t); return i < 0 ? REL_ORDER.length : i; };
    const byPerson = new Map();
    rels.forEach((r) => {
      const cur = byPerson.get(r.id);
      if (!cur || rank(r.type) < rank(cur.type)) byPerson.set(r.id, r);
    });
    const shownRels = [...byPerson.values()];

    const relCard = h('div', { class: 'card' }, h('h3', {}, '🔗 关系脉络'));
    shownRels.forEach((r) => {
      const otherId = r.id;
      const dir = r.from_person_id === Number(id) ? '→' : '←';
      const relText = relType(r.type);
      const item = h('div', { class: 'lb-rel-item', onclick: () => (location.hash = '#/lifebook/' + otherId) },
        h('span', { class: 'lb-rel-name' }, r.name || '未命名'),
        h('span', { class: 'lb-rel-dir' }, dir + ' ' + relText));
      if (!r.claimed && isWaitingClaim(r.status)) {
        item.appendChild(h('span', { class: 'chip chip-ochre', style: { fontSize: '11px', marginLeft: '6px' } },
          r.status === 'pending_claim' ? '待加入' : '待本人自述'));
      }
      relCard.appendChild(item);
    });
    // 「待加入」的亲属：家属网已先立起来，生成认领链接发给 TA，
    // 等 TA 真正上线注册（真名一致）后由后端自动认领联系起来。
    if (canManage) {
      const waitingRels = shownRels.filter((r) => !r.claimed && isWaitingClaim(r.status));
      if (waitingRels.length) {
        const inviteBox = h('div', { style: { marginTop: '12px' } });
        inviteBox.appendChild(h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '6px' } },
          '这些亲属还没加入。把下面的链接发给他们 —— 点开就能进来（不用注册、不用记密码）：'));
        const row = h('div', { class: 'flex gap-2', style: { flexWrap: 'wrap' } });
        waitingRels.forEach((r) => {
          row.appendChild(h('button', { class: 'btn-soft btn-small', onclick: () => inviteClaim(r.id, r.name) },
            '🔗 邀请「' + (r.name || '未命名') + '」'));
        });
        inviteBox.appendChild(row);
        relCard.appendChild(inviteBox);
      }
    }
    main.appendChild(relCard);
  }

  // ===== 回忆录（2026-09-14 吞并原「时间线」独立页 #/timeline/:id）=====
  // 背景：原先「按章节」（本区块）与「时间线」是**同一份数据的两种皮肤** ——
  //   同一个接口 /memoir/persons/:id/memoir、同一套 7 档分组（LIFE_LADDER）、
  //   同一套排序（年份升序 → sort_order），差别只在时间线多显示「年龄 / 完整度」、
  //   少了正文修改入口。用户拍板："如果是一致的，就不需要分两类"。
  // → 合并到这里；timeline 页已删除（app.js 里做旧链接 location.replace 重定向）。
  if (!restricted) {
    const memoirCard = h('div', { class: 'card' });
    memoirCard.appendChild(h('div', { class: 'section-head' },
      h('div', { class: 'section-title' }, '📖 回忆录'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn-soft btn-small', onclick: () => (location.hash = '#/figures/' + id) }, '👥 人物线'),
        // 成书（2026-10-04）：把讲完的内容真正"带走"——整本 HTML，可打印存 PDF、可转发。
        // 仅本人节点可见：成书会汇总全部章节，逐章 visibility 的分级在汇总后无法保留。
        isSelfNode ? h('button', { class: 'btn-soft btn-small', onclick: () => openBookView(id) }, '📕 成书') : null,
        // 家人补充（2026-10-04 P5）：本人在这里确认家人写的内容。仅本人可见。
        isSelfNode ? h('button', { class: 'btn-soft btn-small', onclick: () => openSuggestions(id) }, '💌 家人补充') : null)));
    memoirCard.appendChild(h('div', { class: 'sect-note' },
      '按人生阶段排列。每一段都能改：点「✏️ 改文字」自己动手写，或点「🎙 接着聊」进去说给 AI 听。'));
    const memoirList = h('div', {});
    memoirCard.appendChild(memoirList);
    main.appendChild(memoirCard);

    // 人生阶段阶梯（原时间线页的同一份定义，合并后只此一处）
    const LIFE_LADDER = [
      { key: 'childhood', label: '童年', desc: '出生到上小学前后' },
      { key: 'youth', label: '少年', desc: '中学时代' },
      { key: 'young', label: '青年', desc: '大学、刚工作、成家前' },
      { key: 'marriage', label: '成家', desc: '结婚、生儿育女' },
      { key: 'mid', label: '中年', desc: '立业、支撑家庭的年月' },
      { key: 'old', label: '晚年', desc: '退休、含饴弄孙' },
      { key: 'life', label: '其他', desc: '还没归到上面某一档的片段' },
    ];
    const STAGE_REMAP = { parents: 'childhood', hometown: 'young', children: 'mid', marriage: 'marriage', life: 'life', other: 'life' };

    function stageOf(c) {
      return STAGE_REMAP[c.stage] || c.stage || 'life';
    }

    // 年龄：需要出生年。出生年缺失时不显示年龄，不猜。
    const birthYear = (p.birth_date && /^\d{4}/.test(String(p.birth_date)))
      ? parseInt(String(p.birth_date).slice(0, 4), 10) : null;

    // 年份：优先用章节上的 year；缺了就从标题/正文/摘录里捞一个（原时间线页的做法，一并保留）
    function yearOf(c) {
      if (typeof c.year === 'number' && !isNaN(c.year)) return c.year;
      const m = ((c.title || '') + ' ' + (c.summary || '') + ' ' + (c.excerpt || '')).match(/(?:19|20)\d{2}/);
      return m ? parseInt(m[0], 10) : null;
    }

    // 完整度：正文 ≥90 字算"已有完整故事"，有字算"可继续讲"，空算"待开启"（原时间线页的判定）
    function completenessOf(c) {
      const len = (c.summary || '').length;
      if (len >= 90) return { label: '已有完整故事', cls: 'ch-tag full' };
      if (len > 0) return { label: '可继续讲', cls: 'ch-tag partial' };
      return { label: '待开启', cls: 'ch-tag empty' };
    }

    // 阶段级补讲：跳访谈页，围绕这个年代自由聊（AI 追问），聊完按窗口沉淀成新章节
    function openInterviewForStage(stageLabel) {
      window.__continuePersonId = id;
      window.__continueHint = { personId: id, era: stageLabel };
      location.hash = '#/interview';
    }

    // 章节级「🎙 接着聊」：进访谈用语音/对话把这一段讲细。
    // 🔴 2026-09-14 修正了一个名不副实的功能：原时间线的「再聊聊这段」只传了阶段名，
    //   continueStory(ch, stageLabel) 里的 ch 压根没被使用 —— 点某一章进去其实是**阶段级**访谈，
    //   跟那一章毫无关系。现在把 chapterId 一起带上，后端存到 interviews.focus_chapter_id，
    //   沉淀时用 extendChapter 把新讲的内容【融进这一章】，而不是另起一节。
    function continueChapterByVoice(c, stageLabel) {
      window.__continuePersonId = id;
      window.__continueHint = {
        personId: id,
        era: stageLabel,
        chapterId: c.id,
        chapterTitle: c.title || '',
      };
      location.hash = '#/interview';
    }

    async function loadMemoir() {
      try {
        const r = await API.get('/memoir/persons/' + id + '/memoir');
        memoirList.innerHTML = '';
        const chapters = r.chapters || [];
        if (!chapters.length) {
          memoirList.appendChild(h('div', { class: 'muted' }, '还没有沉淀的回忆录章节。多聊聊，AI 会每 5 轮自动总结成章。'));
          return;
        }
        // 按阶段分组
        const byStage = {};
        LIFE_LADDER.forEach((s) => { byStage[s.key] = []; });
        chapters.forEach((c) => {
          const k = stageOf(c);
          if (!byStage[k]) byStage[k] = [];
          byStage[k].push(c);
        });

        LIFE_LADDER.forEach((stage) => {
          const items = byStage[stage.key] || [];
          const stageWrap = h('div', { class: 'lb-stage' });
          stageWrap.appendChild(h('div', { class: 'lb-stage-head' },
            h('span', { class: 'lb-stage-label' }, stage.label),
            h('span', { class: 'lb-stage-desc' }, stage.desc),
            // 阶段级补讲（跳访谈页自由聊）。2026-09-14 改文案消歧义：
            // 此前阶段级与章节级都叫「＋ 补讲」，同一页同名不同行为 —— 最容易让人点错。
            isSelfNode ? h('button', {
              class: 'btn-soft btn-small',
              onclick: () => openInterviewForStage(stage.label)
            }, '＋ 补讲这个阶段') : null));

          if (items.length) {
            // 阶段内按年份升序（无年份排末尾，再按创建顺序）
            items.slice().sort((a, b) => {
              const ay = yearOf(a); const by = yearOf(b);
              const ax = ay == null ? 99999 : ay; const bx = by == null ? 99999 : by;
              if (ax !== bx) return ax - bx;
              return (a.sort_order || 0) - (b.sort_order || 0);
            }).forEach((c) => {
              const y = yearOf(c);
              const age = (y != null && birthYear != null && y - birthYear >= 0) ? (y - birthYear) : null;
              const yearBadge = (y != null)
                ? h('span', { class: 'chip chip-ochre', style: { fontSize: '11px', marginLeft: '8px' } },
                    age != null ? ('约 ' + y + ' 年 · ' + age + ' 岁') : ('约 ' + y + ' 年'))
                : null;
              const tag = completenessOf(c);
              // 🖼 本章的老照片（2026-10-04 照片破冰）：访谈时传的照片挂到章节上，这里回看。
              // 独立接口按 chapter_id 过滤，失败静默（照片是加分项，不该让整章渲染失败）。
              const photoBox = h('div', { class: 'ch-photos', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } });
              const item = h('div', { class: 'chapter lb-chapter' },
                h('div', { class: 'ch-head' },
                  h('div', { class: 'ch-title' }, c.title || '未命名章节', yearBadge,
                    h('span', { class: tag.cls, style: { marginLeft: '8px' } }, tag.label)),
                  // 每一章只留两个明确入口（用户 2026-09-14："两种修改形式要明确点"）：
                  //   ✏️ 改文字 = 打字改 —— 弹层上半可直接改、下半可写新内容让 AI 融进本节
                  //   🎙 接着聊 = 语音/对话 —— 进访谈页，AI 追问，聊完融进本章
                  // 🕘 历史版本（2026-10-04）：不是第三种修改方式，而是**改错了的退路**。
                  //   正文每次被覆盖（人改/AI融合/家人采纳）都留快照，改坏了能一字不差地退回去。
                  isSelfNode ? h('div', { class: 'btn-row' },
                    h('button', { class: 'btn-soft btn-small', onclick: () => openChapterEditor(c) }, '✏️ 改文字'),
                    h('button', { class: 'btn-soft btn-small', onclick: () => continueChapterByVoice(c, stage.label) }, '🎙 接着聊'),
                    h('button', { class: 'btn-soft btn-small', onclick: () => openVersionHistory(c) }, '🕘 历史版本')) : null),
                c.summary ? h('div', { class: 'ch-summary' }, c.summary) : null,
                c.excerpt ? h('div', { class: 'ch-excerpt' }, '“' + c.excerpt + '”') : null,
                photoBox,
                isSelfNode ? sourceBox(c) : null);
              // 异步补照片（不阻塞章节渲染）
              try {
                API.get('/media/persons/' + id + '?chapter_id=' + c.id).then((r) => {
                  const list = (r && r.media) || [];
                  if (!list.length) return;
                  list.forEach((m) => {
                    const fig = h('figure', { style: { margin: '0' } },
                      h('img', {
                        src: m.url, alt: m.user_hint || '老照片',
                        style: {
                          width: '96px', height: '96px', objectFit: 'cover',
                          borderRadius: '10px', border: '1px solid var(--color-beige, #e2ddd4)',
                        },
                        onclick: () => window.open(m.url, '_blank'),
                      }),
                      m.user_hint ? h('figcaption', { style: { fontSize: '12px', color: 'var(--color-warm-gray, #8a8378)', marginTop: '4px', maxWidth: '96px' } }, m.user_hint) : null);
                    photoBox.appendChild(fig);
                  });
                }).catch(() => {});
              } catch (_) {}
              stageWrap.appendChild(item);
            });
          } else {
            // 空缺阶段给可点入口（原时间线页的做法）：比干巴巴一句"还没有记录"更能引导开口
            stageWrap.appendChild(h('div', { class: 'muted lb-stage-empty' },
              isSelfNode
                ? h('button', { class: 'btn-soft btn-small', onclick: () => openInterviewForStage(stage.label) },
                    '＋ 补讲「' + stage.label + '」这一段')
                : '这一阶段还没有记录。'));
          }
          memoirList.appendChild(stageWrap);
        });
      } catch (e) {
        memoirList.appendChild(h('div', { class: 'error' }, '回忆录加载失败：' + e.message));
      }
    }

    // ===== 成书（2026-10-04）：把内容真正带走 =====
  // 三个出口：预览看看 / 打印(或存 PDF) / 下载单个 HTML 文件转发给家人。
  // 照片用绝对地址，成书 HTML 才能脱离本站独立打开。
  function openBookView(pid) {
    // 复用项目既有的 modal()（自带遮罩/关闭/滚动锁），不自己造一套
    const body = h('div', {});
    const stage = h('div', { style: { marginTop: '12px' } });
    let data = null;
    let style = 'warm';
    let includeAudio = true;
    let currentUrl = '';

    const styleRow = h('div', { class: 'btn-row' },
      ...[['warm', '暖黄'], ['classic', '素雅'], ['ink', '墨青']].map(([k, label]) => h('button', {
        class: 'btn-soft btn-small' + (k === 'warm' ? ' active' : ''),
        onclick: (e) => {
          style = k;
          [...styleRow.children].forEach((b) => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          render();
        },
      }, label)));
    const audioBox = h('input', { type: 'checkbox' });
    audioBox.checked = true;
    audioBox.onchange = () => { includeAudio = audioBox.checked; render(); };
    const audioRow = h('label', {
      style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: 'var(--color-warm-gray, #8a8378)', marginTop: '8px' },
    }, audioBox, h('span', {}, '书里附原音（更完整，但文件更大）'));

    function render() {
      if (!data) return;
      const qs = 'style=' + encodeURIComponent(style) + '&audio=' + (includeAudio ? '1' : '0');
      const url = '/api/memoir/persons/' + pid + '/book?' + qs;
      currentUrl = url;
      stage.innerHTML = '';
      stage.appendChild(h('iframe', {
        title: '成书预览',
        style: {
          width: '100%', height: '56vh', border: '1px solid var(--color-beige, #e2ddd4)',
          borderRadius: '10px', background: '#fff',
        },
        src: url,
      }));
    }

    const note = h('div', { class: 'sect-note' }, '正在准备…');
    body.appendChild(note);
    body.appendChild(styleRow);
    body.appendChild(audioRow);
    const printBtn = h('button', { class: 'btn-soft' }, '🖨 打印 / 存 PDF');
    printBtn.onclick = async () => {
      if (!currentUrl) return;
      printBtn.textContent = '准备中…';
      try {
        // 走 fetch 带上令牌：成书接口需登录，直接 window.open 会被 401
        const r = await API.raw(currentUrl);
        openPrint(await r.text());
      } catch (e) { toast('打开失败：' + e.message); }
      printBtn.textContent = '🖨 打印 / 存 PDF';
    };
    body.appendChild(stage);
    body.appendChild(h('div', { class: 'btn-row', style: { marginTop: '12px' } },
      printBtn,
      h('button', {
        class: 'btn-primary',
        onclick: async () => {
          if (!currentUrl || !data) return;
          try {
            const r = await API.raw(currentUrl);
            const html = await r.text();
            const nm = (data.person.real_name || data.person.name || '传记');
            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = nm + '的一生.html';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          } catch (e) { toast('下载失败：' + e.message); }
        },
      }, '⬇ 下载这本书')));

    // 弹层一次打开，数据回来后就地渲染（不做"关掉再开"，避免闪烁）
    modal('📕 成书', body, {});
    API.get('/memoir/persons/' + pid + '/book').then((r) => {
      data = r;
      const c = r.counts || {};
      note.textContent = '共 ' + (c.chapters || 0) + ' 章'
        + (c.photos ? '、' + c.photos + ' 张照片' : '')
        + (c.quotes ? '、' + c.quotes + ' 句原话' : '')
        + (c.audio ? '（含 ' + c.audio + ' 段原音）' : '')
        + '。打印时选"另存为 PDF"就是成品。';
      if (!c.chapters) {
        stage.innerHTML = '';
        stage.appendChild(h('div', { class: 'muted' }, '还没有可成书的章节，先多聊几次让内容沉淀下来。'));
        return;
      }
      render();
    }).catch((e) => { note.textContent = '成书失败：' + e.message; });
  }

  // 在新窗口打开打印视图（比 iframe 直接 print 稳定，微信内也能用）
  function openPrint(html) {
    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦了弹窗，请允许后重试'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // 等排版完成再唤起打印
    setTimeout(() => { try { w.focus(); w.print(); } catch (_) {} }, 700);
  }

  // ===== 「我当时说的话」：AI 整理稿之外，保留本人原话与原音 =====
  // 为什么必须留：AI 整理会失真、会漏细节。传记的底色应该是"这个人当时到底怎么说的"，
  // AI 稿只是便于阅读的整理版，不能取代原话。原始录音尤其重要 —— ASR 会听错，真人原音不会。
  // 交互：默认收起（点开才请求），因为老人多半只想看整理稿，需要核对时才展开。
  function sourceBox(c) {
    const wrap = h('div', { style: { marginTop: '8px' } });
    let loaded = false;

    const toggle = h('button', {
      class: 'btn-soft btn-small',
      style: { fontSize: '13px', color: 'var(--color-warm-gray, #8a8378)' },
      onclick: async () => {
        if (loaded) {
          body.innerHTML = '';
          toggle.textContent = '我当时是怎么说的 ▾';
          return;
        }
        toggle.textContent = '正在取原话…';
        try {
          const r = await API.get('/memoir/chapters/' + c.id + '/source');
          loaded = true;
          body.innerHTML = '';
          toggle.textContent = '收起原话 ▴';
          const qs = r.quotes || [];
          if (!qs.length) {
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '13px' } }, '这一章还没有留下原话。'));
            return;
          }
          qs.forEach((q) => {
            const row = h('div', {
              style: {
                borderLeft: '2px solid var(--color-beige, #e2ddd4)',
                paddingLeft: '10px', marginTop: '10px',
              },
            });
            const txt = h('div', {
              style: { fontSize: '14px', lineHeight: '1.7', color: '#4a453d', whiteSpace: 'pre-wrap' },
            }, q.text);
            row.appendChild(txt);
            if (q.audioUrl) {
              const audio = h('audio', {
                controls: true, preload: 'none', src: q.audioUrl,
                style: { width: '100%', maxWidth: '320px', height: '34px', marginTop: '6px' },
              });
              row.appendChild(audio);
            }
            // ✏️ 订正（2026-10-04）：ASR 会听错（地名/人名尤甚），错字留在"原话"里反而失真。
            //    只改文字，**原音永远保留** —— 声音是"这个人真的这么说过"的证据。
            row.appendChild(h('button', {
              class: 'btn-soft btn-small',
              style: { marginTop: '6px', fontSize: '12px' },
              onclick: () => openQuoteEditor(q, txt, c),
            }, '✏️ 这里听错了'));
            body.appendChild(row);
          });
          if (r.audioCount) {
            body.appendChild(h('div', {
              class: 'muted', style: { fontSize: '12px', marginTop: '10px' },
            }, '共 ' + qs.length + ' 句原话' + (r.audioCount ? '，其中 ' + r.audioCount + ' 段留有原音' : '') + '。'));
          }
        } catch (e) {
          toggle.textContent = '取原话失败';
          // 403 = 非本人（原音仅本人可见），给一句人话而不是错误码
          if (String(e.message || '').indexOf('403') >= 0) {
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '13px' } }, '原话与原音只有本人能看。'));
          }
        }
      },
    }, '我当时是怎么说的 ▾');

    const body = h('div', {});
    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  // 原话订正弹层：只改文字，明确告诉用户"原音不会动"
  function openQuoteEditor(q, txtEl, chapter) {
    const form = h('div', {});
    if (q.audioUrl) {
      form.appendChild(h('div', { class: 'sect-note', style: { marginBottom: '10px' } },
        '听了一遍，觉得机器听错了？改这里。原音会原样保留。'));
      form.appendChild(h('audio', {
        controls: true, preload: 'metadata', src: q.audioUrl,
        style: { width: '100%', height: '36px', marginBottom: '12px' },
      }));
    } else {
      form.appendChild(h('div', { class: 'sect-note', style: { marginBottom: '10px' } },
        '这段没有留存原音，改了就没法对照了，谨慎些。'));
    }
    const ta = h('textarea', { class: 'input', rows: 4 }, q.text || '');
    form.appendChild(ta);
    form.appendChild(h('div', { class: 'btn-row', style: { marginTop: '12px' } },
      h('button', {
        class: 'btn-primary',
        onclick: async () => {
          const v = ta.value.trim();
          if (!v) { toast('内容不能为空'); return; }
          try {
            await API.patch('/memoir/messages/' + q.id, { text: v });
            txtEl.textContent = v;
            modal('已订正', h('div', { class: 'sect-note' }, '文字已更正，原音保持原样。'), { noBackdropClose: false })();
          } catch (e) { toast('订正失败：' + e.message); }
        },
      }, '保存订正')));
    modal('✏️ 订正原话', form, { noBackdropClose: true });
  }

  // ===== 家人补充建议（2026-10-04 P5）=====
  // 本人视角的待确认区：家人写的补充在这里，本人点「采纳」直接入正文。
  // 为什么要有：传记主语是本人，谁有权定稿必须是他（用户 2026-10-04 拍板）。
  function openSuggestions(pid) {
    const body = h('div', {});
    const list = h('div', {});
    body.appendChild(list);
    modal('💌 家人补充', body, {});

    API.get('/suggestions/person/' + pid).then((r) => {
      const items = r.suggestions || [];
      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(h('div', { class: 'muted' }, '还没有家人补充过内容。'));
        return;
      }
      if (r.pending > 0) {
        list.appendChild(h('div', { class: 'sect-note', style: { marginBottom: '10px' } },
          '有 ' + r.pending + ' 条等你确认。采纳后会并入对应章节；不采纳就驳回，不会影响正文。'));
      }
      items.forEach((s) => {
        const isPending = s.status === 'pending';
        const card = h('div', { class: 'card', style: { marginBottom: '10px' } },
          h('div', { class: 'sect-note' },
            (s.author_name || '家人') + ' 说' + (s.status === 'adopted' ? ' · 已采纳' : s.status === 'dismissed' ? ' · 已驳回' : ' · 待你确认')),
          h('div', { style: { fontSize: '15px', lineHeight: '1.75', whiteSpace: 'pre-wrap', marginTop: '6px' } }, s.content));
        if (isPending) {
          const row = h('div', { class: 'btn-row', style: { marginTop: '10px' } });
          const adoptBtn = h('button', { class: 'btn-primary btn-small' }, '✓ 采纳');
          const dismissBtn = h('button', { class: 'btn-soft btn-small' }, '不用了');
          adoptBtn.onclick = async () => {
            adoptBtn.textContent = '处理中…';
            adoptBtn.disabled = true;
            try {
              const out = await API.post('/suggestions/' + s.id + '/adopt', {});
              toast('已并入《' + (out.title || '章节') + '》');
              adoptBtn.textContent = '✓ 已采纳';
              dismissBtn.remove();
            } catch (e) {
              toast('采纳失败：' + e.message);
              adoptBtn.textContent = '✓ 采纳';
              adoptBtn.disabled = false;
            }
          };
          dismissBtn.onclick = async () => {
            try {
              await API.post('/suggestions/' + s.id + '/dismiss', {});
              adoptBtn.remove();
              dismissBtn.textContent = '已驳回';
            } catch (e) { toast('操作失败：' + e.message); }
          };
          row.appendChild(adoptBtn);
          row.appendChild(dismissBtn);
          card.appendChild(row);
        }
        list.appendChild(card);
      });
    }).catch((e) => {
      list.innerHTML = '';
      list.appendChild(h('div', { class: 'error' }, '读取失败：' + e.message));
    });
  }

  // ===== 历史版本（2026-10-04）：改错了能一字不差地退回去 =====
  // 为什么必须做：正文此前是直接覆盖的 —— 改一次，AI 写的原文就没了。
  //   尤其危险的是 AI 路径：用户点「🎙 接着聊」讲完，AI 直接重写整章，
  //   用户根本没意识到正文被换过。
  // 交互：先展示每个版本的正文预览，看清楚了再点回滚；回滚前自动再存一版（可反悔）。
  function openVersionHistory(chapter) {
    const body = h('div', {});
    const list = h('div', {});
    body.appendChild(list);
    modal('🕘 历史版本', body, {});

    API.get('/memoir/chapters/' + chapter.id + '/versions').then((r) => {
      const vs = r.versions || [];
      list.innerHTML = '';
      if (!vs.length) {
        list.appendChild(h('div', { class: 'muted' },
          '这一章还没有改动记录。以后的每一次修改（包括 AI 润色）都会自动存一份，随时能退回来。'));
        return;
      }
      list.appendChild(h('div', { class: 'sect-note', style: { marginBottom: '12px' } },
        '下面是这一章被改动前的原文，最多保留最近 ' + (r.max || 20) + ' 版。点「退回到这一版」即可恢复。'));

      vs.forEach((v, i) => {
        const when = String(v.created_at || '');
        const who = { edit: '你改的', ai_extend: 'AI 润色', ai_sediment: 'AI 沉淀', suggestion: '家人补充', restore: '回滚存档' }[v.source] || v.source;
        const card = h('div', { class: 'card', style: { marginBottom: '10px' } },
          h('div', { class: 'sect-note' },
            (i === 0 ? '最近一次改动前　' : '') + when + '　·　' + who
            + (v.note ? '　·　' + v.note : '')),
          h('div', {
            style: {
              fontSize: '14px', lineHeight: '1.75', whiteSpace: 'pre-wrap',
              marginTop: '8px', maxHeight: '160px', overflowY: 'auto',
              padding: '10px', background: 'var(--color-paper, #FAF7F0)', borderRadius: '8px',
            },
          }, v.summary || '（这一版正文为空）'));

        const row = h('div', { class: 'btn-row', style: { marginTop: '8px' } });
        const expand = h('button', { class: 'btn-soft btn-small' }, '看完整正文');
        const restore = h('button', { class: 'btn-primary btn-small' }, '↩ 退回到这一版');
        let full = false;
        expand.onclick = () => {
          full = !full;
          const box = card.children[1];
          box.style.maxHeight = full ? 'none' : '160px';
          expand.textContent = full ? '收起' : '看完整正文';
        };
        restore.onclick = () => {
          // ⚠️ 刻意不用原生 confirm()：本项目全站零处使用它，而微信 X5 对原生弹窗
          //   有已知兼容坑（不弹/样式错乱），且受众是老人。统一用自建 modal。
          const ask = h('div', {},
            h('div', { style: { fontSize: '15px', lineHeight: '1.7', marginBottom: '14px' } },
              '确定退回到这一版？当前正文会先自动存一份，所以退错了还能再退回来。'),
            h('div', { class: 'btn-row' },
              h('button', { class: 'btn-primary', onclick: () => { askClose(); doRestore(); } }, '确定退回'),
              h('button', { class: 'btn-soft', onclick: () => askClose() }, '再想想')));
          const askClose = modal('确认回滚', ask, { noBackdropClose: true });

          const doRestore = async () => {
            restore.textContent = '恢复中…';
            restore.disabled = true;
            try {
              await API.post('/memoir/chapters/' + chapter.id + '/restore', { version_id: v.id });
              modal('已退回到这一版', h('div', { class: 'sect-note' },
                '正文已恢复。刷新后就能看到这一版的内容。'), { noBackdropClose: false })();
              setTimeout(() => location.reload(), 900);
            } catch (e) {
              toast('退回失败：' + e.message);
              restore.textContent = '↩ 退回到这一版';
              restore.disabled = false;
            }
          };
        };
        row.appendChild(expand);
        row.appendChild(restore);
        card.appendChild(row);
        list.appendChild(card);
      });
    }).catch((e) => {
      list.innerHTML = '';
      list.appendChild(h('div', { class: 'error' }, '读取历史失败：' + e.message));
    });
  }

  // ===== 「✏️ 改文字」弹层：一块直接改、一块补讲让 AI 融合 =====
    // 2026-09-14 把原先两个并列入口（「编辑」= 手改、「＋补讲」= 打字让 AI 融进本节）合进一个弹层。
    // 原因：两者都是"打字"，并列成两个按钮只会让人猜"我该点哪个"。
    // 现在一个弹层、两块各自一个按钮、标题写清区别 —— 用户要的"两种形式要明确点"。
    function openChapterEditor(c) {
      const form = h('div', {});

      // ---------- 上半：直接改（秒级，不经 AI，改动不会被重写）----------
      const title = h('input', { class: 'input', value: c.title || '' });
      const yearInput = h('input', { class: 'input', type: 'number', min: '1800', max: '2100', placeholder: '如 1960（排序用，可留空）', value: c.year != null ? String(c.year) : '' });
      const summary = h('textarea', { class: 'input', rows: 8 }, c.summary || '');
      const excerpt = h('input', { class: 'input', value: c.excerpt || '' });
      const vis = h('select', { class: 'input' },
        h('option', { value: 'family' }, '家族可见'),
        h('option', { value: 'public' }, '公开'),
        h('option', { value: 'self' }, '仅本人'));
      vis.value = c.visibility || 'family';

      const saveBtn = h('button', {
        class: 'btn-block',
        onclick: async () => {
          saveBtn.disabled = true;
          try {
            await API.patch('/memoir/chapters/' + c.id, {
              title: title.value.trim(), summary: summary.value.trim(),
              excerpt: excerpt.value.trim(), visibility: vis.value,
              year: yearInput.value.trim() === '' ? null : Number(yearInput.value.trim()),
            });
            close(); toast('已保存'); loadMemoir();
          } catch (e) { toast('保存失败：' + e.message); saveBtn.disabled = false; }
        },
      }, '💾 保存我改的文字');

      form.appendChild(h('div', { class: 'ce-block' },
        h('div', { class: 'ce-block-title' }, '直接改'),
        h('div', { class: 'ce-block-note' }, '下面就是这一节的文字，改完点按钮保存。你的改动原样入册，AI 不会重写。'),
        h('div', { class: 'field' }, h('label', {}, '标题'), title),
        h('div', { class: 'field' }, h('label', {}, '年份'), yearInput),
        h('div', { class: 'field' }, h('label', {}, '内容'), summary),
        h('div', { class: 'field' }, h('label', {}, '摘录'), excerpt),
        h('div', { class: 'field' }, h('label', {}, '可见范围'), vis),
        saveBtn));

      // ---------- 下半：只补新内容，AI 融进本节 ----------
      const addTa = h('textarea', { class: 'rf-input', rows: 5, placeholder: '例如：那时候鸡腿是油炸的，我一手抓一只，啃得满手油……' });
      const addStatus = h('div', { class: 'rf-status muted' }, '');
      const addBtn = h('button', {
        class: 'btn-block',
        onclick: async () => {
          const text = addTa.value.trim();
          if (!text) { addStatus.textContent = '请先写点内容。'; return; }
          addBtn.disabled = true;
          addStatus.textContent = 'AI 正在把新讲的融进这一节…（实测约 1 分钟，请别关页面）';
          try {
            const r = await API.post('/memoir/chapters/' + c.id + '/extend', { text });
            close();
            toast(r && r.sameTopic === false
              ? '已融进本节。不过这段更像另一件事 —— 想单独成章可用「➕ 补充经历」'
              : '已补进去，这一节重写好了');
            loadMemoir();
          } catch (e) {
            addStatus.textContent = '融合失败：' + (e.message || e);
            addBtn.disabled = false;
          }
        },
      }, '🤖 让 AI 融进这一节');

      form.appendChild(h('div', { class: 'ce-block' },
        h('div', { class: 'ce-block-title' }, '不想整段改？只补充新内容'),
        h('div', { class: 'ce-block-note' }, '把刚想到的写在下面，AI 会把它和你之前讲的融成同一段回忆 —— 不另起一节，原来的内容也不会丢。'),
        addTa, addBtn, addStatus));

      const close = modal('改这一节', form, { noBackdropClose: true });
    }

    await loadMemoir();
  }

  // ===== 底部不再放「返回首页」=====
  // 2026-09-14 用户要求"进入一个页面及返回前页面要有统一的按钮位置"：
  // 原先人生书把返回放在**页面最底部**、时间线放在**右上角**、人物线**根本没有**。
  // 现统一到顶栏最左（index.html 的 #top-back-btn，由 app.js 按路由显隐），此处删掉重复入口。
};

function relType(t) {
  return ({ parent: '父母', child: '子女', spouse: '配偶', sibling: '兄弟姐妹', ancestor: '祖辈', descendant: '孙辈' })[t] || t;
}

// 为某「待加入」节点生成认领链接（后端返回 /claim.html?token=xxx）。
// 2026-09-13 起该链接是**免密**的：对方点开 → 自动建号 + 绑节点 + 直接登录，
//   **不用注册、不用记密码**（受众含 75+ 父母，见 server/src/routes/claims.js 顶部注释）。
// 优先调起系统分享（微信/短信），否则复制到剪贴板并提示，方便发链接给那位亲属。
// 2026-09-13 由 person.js 迁入（两套人物页合并）。
async function inviteClaim(personId, name) {
  try {
    const r = await API.post('/persons/' + personId + '/invite', {});
    const url = location.origin + r.link;
    const who = name || '家人';
    // 文案按「传记第一性」写：邀请的是"记录你自己的一生"，不是"来填家族树的节点"。
    const text = '「' + who + '」，家人请你把自己的一生讲一讲、记下来。点开就能用，不用注册、不用记密码：';
    if (navigator.share) {
      try {
        await navigator.share({ title: '赛博传记', text, url });
        return;
      } catch (_) { /* 用户取消分享 → 走复制兜底 */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      alert('链接已复制。发给「' + who + '」即可 —— 对方点开就能进，不用注册：\n' + url);
    } catch (_) {
      alert('链接（请手动复制发给「' + who + '」，点开即可进，不用注册）：\n' + url);
    }
  } catch (e) {
    alert('生成邀请失败：' + e.message);
  }
}
window.inviteClaim = inviteClaim;

// 申请代录授权（他人节点）
async function requestRelay(personId, personName) {
  const reason = prompt('代录「' + personName + '」的传记，请说明理由：', '我是 ' + personName + ' 的亲属，想帮忙记录生平。');
  if (reason === null) return;
  try {
    const r = await API.post('/persons/' + personId + '/request-relay', { reason });
    toast(r.status === 'pending' ? '已发送授权申请，等待 ' + personName + ' 确认' : '申请已存在（' + r.status + '）');
  } catch (e) {
    toast('申请失败：' + e.message);
  }
}

// 轻量补录模态框（纯文本录入 → 写回 persons 基础字段 + profile_json）
// 「➕ 补充经历」：把一段手写/口述的生平片段交给 AI 整理成回忆录章节。
// 与「编辑资料」互补——后者改静态档案（姓名/生日…），这个真正"补一段故事"。
function openExperienceModal(personId, p, isSelfNode) {
  const tip = h('div', { class: 'rf-tip muted' },
    '写一段你想记下来的经历（童年、工作、一次远行……）。AI 会把它整理成一章回忆录，并自动避免重复或编造。');
  const ta = h('textarea', { class: 'rf-input', rows: 6, placeholder: '例如：1998 年我第一次坐火车去北京，硬座车厢里挤满了人……' });
  const form = h('div', { class: 'record-form' }, tip, ta);

  const status = h('div', { class: 'rf-status muted' }, '');
  const saveBtn = h('button', { class: 'btn', onclick: async () => {
    const text = ta.value.trim();
    if (!text) { status.textContent = '请先写点内容。'; return; }
    saveBtn.disabled = true;
    status.textContent = 'AI 整理中…（实测约 1 分钟，请别关页面）';
    try {
      const r = await API.post('/persons/' + personId + '/experience', { text });
      close();
      toast('已生成一章回忆录');
      setTimeout(() => { location.reload(); }, 300);
    } catch (e) {
      status.textContent = '保存失败：' + (e.message || e);
      saveBtn.disabled = false;
    }
  } }, '生成章节');

  form.appendChild(h('div', { class: 'rf-actions' }, saveBtn));
  form.appendChild(status);
  const close = modal((isSelfNode ? '补充我的经历' : '代录一段经历'), form, { noBackdropClose: true });
}
