// web/js/pages/home.js — 首屏：我的传记（2026-09-13 改造：传记第一性）
//
// 改造背景：原先首屏主标题是「🌳 我的家族大树」，主视觉是一棵树 —— 与产品定位
// 「传记是第一性的，家谱是从多篇自述里自然涌现的副产品」相反，导致"说是传记、做成家谱"。
// 现在首屏回答的是"我聊到哪了、下一段该聊什么"，家族树降为下方「我的关系网」辅助视图（默认收起）。
window.Pages = window.Pages || {};
window.Pages.home = async function (main) {
  const uid = window.Store.user && window.Store.user.id;
  const selfId = window.Store.self;
  if (!uid) { main.appendChild(h('div', { class: 'error' }, '请先登录')); return; }
  if (!selfId) {
    main.appendChild(h('div', { class: 'empty' }, '正在为你建立传记节点…若长时间无响应，请刷新。'));
    return;
  }

  // ===== 页头：这是「我的传记」 =====
  main.appendChild(h('h1', { class: 'page-title' }, '📖 我的传记'));
  main.appendChild(h('p', { class: 'page-subtitle' },
    '接着讲就好。AI 一边听一边整理，攒够 5 轮就沉淀成一章。'));

  // ===== 主操作：唯一的大按钮 =====
  main.appendChild(h('button', {
    class: 'btn-primary btn-block',
    onclick: () => { window.__homeGate = 'me'; location.hash = '#/interview'; },
  }, '🎙 接着说我的故事'));
  main.appendChild(h('div', { style: { height: '16px' } }));

  // ===== 传记进度：聊到哪 / 下一段聊什么 =====
  const progressCard = h('div', { class: 'card' }, h('div', { class: 'muted' }, '正在读你的章节…'));
  main.appendChild(progressCard);

  // 人生阶段阶梯。注意：局部定义，切勿提到文件顶层 ——
  // timeline.js 已有顶层 const LIFE_LADDER / STAGE_REMAP，重名会 SyntaxError 导致整站白屏。
  const LADDER = [
    { key: 'childhood', label: '童年', desc: '出生到上小学前后' },
    { key: 'youth', label: '少年', desc: '中学时代' },
    { key: 'young', label: '青年', desc: '大学、刚工作、成家前' },
    { key: 'marriage', label: '成家', desc: '结婚、生儿育女' },
    { key: 'mid', label: '中年', desc: '立业、支撑家庭的年月' },
    { key: 'old', label: '晚年', desc: '退休、含饴弄孙' },
    { key: 'life', label: '其他', desc: '还没归到上面某一档的片段' },
  ];
  const STAGE_MAP = { parents: 'childhood', hometown: 'young', children: 'mid', marriage: 'marriage', life: 'life', other: 'life' };

  try {
    const r = await API.get('/memoir/persons/' + selfId + '/memoir');
    const chapters = r.chapters || [];
    progressCard.innerHTML = '';

    const head = h('div', { class: 'section-head' },
      h('div', { class: 'section-title' }, '📚 我的章节'),
      h('button', {
        class: 'btn-soft btn-small',
        onclick: () => (location.hash = '#/lifebook/' + selfId),
      }, '查看全部'));
    progressCard.appendChild(head);

    if (!chapters.length) {
      progressCard.appendChild(h('div', { class: 'muted' },
        '还没有章节。聊满 5 轮，第一段回忆就会自动整理出来。'));
    } else {
      progressCard.appendChild(h('div', { style: { fontSize: '14px', marginBottom: '8px' } },
        '已沉淀 ' + chapters.length + ' 章'));
      const latest = chapters[chapters.length - 1];
      const item = h('div', { class: 'chapter lb-chapter', style: { cursor: 'pointer' } },
        h('div', { class: 'ch-head' }, h('div', { class: 'ch-title' }, latest.title || '未命名章节')),
        latest.summary ? h('div', { class: 'ch-summary' }, latest.summary) : null);
      item.addEventListener('click', () => (location.hash = '#/lifebook/' + selfId));
      progressCard.appendChild(item);
    }

    // 「下一段可以聊什么」——第一个还没记录的阶段
    const covered = new Set(chapters.map((c) => STAGE_MAP[c.stage] || c.stage || 'life'));
    const nextStage = LADDER.find((s) => !covered.has(s.key));
    if (nextStage) {
      progressCard.appendChild(h('div', { style: { marginTop: '12px' } },
        h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '6px' } },
          '下一段可以聊聊「' + nextStage.label + '」——' + nextStage.desc),
        h('button', {
          class: 'btn-soft',
          onclick: () => {
            window.__continuePersonId = selfId;
            window.__continueHint = { personId: selfId, era: nextStage.label };
            location.hash = '#/interview';
          },
        }, '🎙 聊' + nextStage.label)));
    }
  } catch (e) {
    progressCard.innerHTML = '';
    progressCard.appendChild(h('div', { class: 'muted' }, '章节加载失败：' + e.message));
  }

  // ===== 我的关系网（原「家族大树」，降为辅助视图，默认收起）=====
  let tree;
  let triedRebuild = false;
  try {
    tree = await API.get('/egotree?center=' + selfId);
  } catch (e) {
    if ((e.message || '').indexOf('人物不存在') !== -1 && !triedRebuild) {
      triedRebuild = true;
      window.Store.setSelf(null);
      try {
        const r2 = await API.post('/auth/ensure-self', {});
        if (r2 && r2.person) {
          window.Store.setSelf(r2.person);
          tree = await API.get('/egotree?center=' + r2.person.id);
        }
      } catch (_) { /* 忽略，下面统一报错 */ }
    }
  }

  const netCard = h('div', { class: 'card' });
  const netHead = h('div', { class: 'section-head' },
    h('div', { class: 'section-title' }, '🌳 我的关系网'));
  const toggleBtn = h('button', { class: 'btn-soft btn-small' }, '展开');
  netHead.appendChild(toggleBtn);
  netCard.appendChild(netHead);

  const treeBox = h('div', {});
  treeBox.style.display = 'none'; // 默认收起：首屏聚焦传记，关系网是副产品
  netCard.appendChild(treeBox);
  main.appendChild(netCard);

  toggleBtn.addEventListener('click', () => {
    const opened = treeBox.style.display !== 'none';
    treeBox.style.display = opened ? 'none' : '';
    toggleBtn.textContent = opened ? '展开' : '收起';
  });

  if (!tree) {
    netCard.appendChild(h('div', { class: 'error' }, '关系网加载失败，请稍后重试。'));
    return;
  }

  const nodeMap = {};
  tree.nodes.forEach((n) => (nodeMap[n.id] = n));
  if (window.refreshInboxBadge) window.refreshInboxBadge();

  const relCount = Math.max(tree.nodes.length - 1, 0);
  netCard.insertBefore(h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '8px' } },
    relCount
      ? ('已在访谈中提到 ' + relCount + ' 位亲属。点名字看他们的传记。')
      : '亲属会随访谈自动连进来，不需要手动录入。') , treeBox);

  // 子节点索引（父 → 子）
  const childrenOf = {};
  tree.edges.forEach((e) => {
    (childrenOf[e.from] = childrenOf[e.from] || []).push(e.to);
  });

  const collapsed = {}; // 默认展开到 depth<=1

  function relLabel(r) {
    return ({ self: '本人', parent: '父母', child: '子女', spouse: '配偶', ancestor: '祖辈', descendant: '孙辈' })[r] || '';
  }

  function initialsOf(name) {
    if (!name) return '?';
    return name.slice(0, 1);
  }

  function renderNode(id, depth) {
    const n = nodeMap[id];
    if (!n) return null;
    const kids = (childrenOf[id] || []).filter((k) => nodeMap[k]);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed[id] === undefined ? (depth >= 1 && hasKids) : collapsed[id];

    const rowCls = 'tree-row' + (n.isSelf ? ' tree-row-self' : '') + (!n.claimed ? ' tree-row-stub' : '');
    const avatarCls = 'avatar-circle' + (n.isSelf ? '' : (n.claimed ? ' avatar-circle-pine' : ' avatar-circle-stub'));

    const row = h('div', { class: rowCls });
    if (hasKids) {
      const toggle = h('span', {
        onclick: () => { collapsed[id] = !isCollapsed; rerender(); },
        style: { width: '20px', textAlign: 'center', fontSize: '14px', color: 'var(--color-ochre)', cursor: 'pointer', userSelect: 'none' },
      }, isCollapsed ? '▸' : '▾');
      row.appendChild(toggle);
    } else {
      row.appendChild(h('span', { style: { width: '20px', textAlign: 'center', color: 'var(--color-beige)' } }, '·'));
    }

    // 头像/首字
    row.appendChild(h('span', { class: avatarCls }, initialsOf(n.name)));

    // 节点主体
    const body = h('div', { style: { flex: '1', minWidth: '0' } });
    const nameRow = h('div', { class: 'flex items-center gap-2' });
    nameRow.appendChild(h('span', {
      class: 'serif font-bold text-lg',
      style: { color: 'var(--color-deep-brown)', cursor: 'pointer' },
      onclick: () => (location.hash = '#/lifebook/' + id),
    }, n.name + (n.isSelf ? '（你）' : '')));
    if (!n.claimed && !n.isSelf) {
      const waitLabel = n.status === 'pending_claim' ? '待加入' : '待认领';
      nameRow.appendChild(h('span', { class: 'chip chip-ochre', style: { fontSize: '11px', padding: '2px 8px' } }, waitLabel));
    }
    body.appendChild(nameRow);
    const meta = h('div', { class: 'flex items-center gap-2', style: { marginTop: '2px' } });
    if (n.birth_date) meta.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, n.birth_date));
    if (n.relation) meta.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, '· ' + relLabel(n.relation)));
    body.appendChild(meta);

    row.appendChild(body);

    const wrap = h('div', {});
    wrap.appendChild(row);
    if (hasKids && !isCollapsed) {
      const sub = h('div', { class: 'tree-indent' });
      kids.forEach((k) => { const c = renderNode(k, depth + 1); if (c) sub.appendChild(c); });
      wrap.appendChild(sub);
    }
    return wrap;
  }

  let container;
  function rerender() {
    if (container) container.remove();
    container = h('div', {});
    const root = renderNode(selfId, 0);
    if (root) container.appendChild(root);
    treeBox.appendChild(container);
    // 注意：此处不要 window.scrollTo(0,0) —— 关系网已折叠在首屏下方，
    // 展开/折叠子节点时把页面滚回顶部会让用户丢失位置。
  }
  rerender();
};
