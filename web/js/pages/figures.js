// web/js/pages/figures.js — 人物线：聚合本人提到过的重要人物，支持按人物补讲故事
window.Pages = window.Pages || {};

const FIGURE_REL_LABELS = {
  father: '父亲', mother: '母亲', spouse: '配偶',
  son: '儿子', daughter: '女儿', child: '子女',
  brother: '兄弟', sister: '姐妹', sibling: '兄弟姐妹',
  grandfather: '祖父', grandmother: '祖母',
  'maternal-grandfather': '外祖父', 'maternal-grandmother': '外祖母',
  friend: '朋友', colleague: '同事', teacher: '师长', neighbor: '邻居', other: '他人',
};

window.Pages.figures = async function (main, id) {
  if (!id && window.Store.self) id = window.Store.self;
  if (!id) {
    main.appendChild(h('div', { class: 'error' }, '未指定人物，请先登录或从个人主页进入。'));
    return;
  }

  let person;
  try { person = (await API.get('/persons/' + id)).person; }
  catch (e) { main.appendChild(h('div', { class: 'error' }, '加载失败：' + e.message)); return; }

  main.appendChild(h('div', { class: 'card' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      h('div', { class: 'avatar', style: { width: '54px', height: '54px', fontSize: '20px' } }, initials(person.name)),
      h('div', {},
        h('div', { style: { fontSize: '20px', fontWeight: '700' } }, person.name + ' 的人物线'),
        h('div', { class: 'meta' }, '亲属同步出现在家族大树；朋友、老师、同事等非亲属熟人只在此聚合，方便补充他们的故事。')))));

  const list = h('div', {});
  main.appendChild(list);

  try {
    const r = await API.get('/persons/' + id + '/figures');
    const figures = r.figures || [];
    const family = figures.filter((f) => f.is_family);
    const others = figures.filter((f) => !f.is_family);

    renderGroup(list, '我的亲属', '在家族大树中可见', family, true, id);
    renderGroup(list, '重要他人', '朋友、老师、同事、邻居等熟人', others, false, id);

    if (!family.length && !others.length) {
      list.appendChild(h('div', { class: 'card muted' }, '还没有记录到重要人物。去「访谈」里聊聊你的家人、朋友、老师或同事吧。'));
    }
  } catch (e) {
    list.appendChild(h('div', { class: 'error' }, '人物线加载失败：' + e.message));
  }
};

function renderGroup(container, title, subtitle, figures, isFamily, ownerId) {
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'section-head' },
    h('div', {},
      h('div', { class: 'section-title' }, title),
      h('div', { class: 'meta' }, subtitle))));

  if (!figures.length) {
    card.appendChild(h('div', { class: 'muted' }, '暂无' + title + '。'));
    container.appendChild(card);
    return;
  }

  const grid = h('div', { class: 'figure-grid' });
  figures.forEach((f) => {
    const p = f.person;
    const relTag = h('span', { class: 'badge' }, f.rel_label || FIGURE_REL_LABELS[f.rel] || f.rel);
    const note = p.status === 'pending_claim'
      ? h('span', { class: 'badge dim' }, '待加入')
      : (p.status === 'stub' ? h('span', { class: 'badge dim' }, '待本人自述') : null);

    const action = isFamily
      ? h('button', { class: 'btn btn-small', onclick: () => (location.hash = '#/lifebook/' + p.id) }, '查看/补录生平')
      : h('button', { class: 'btn btn-small', onclick: () => startFigureInterview(ownerId, p.id, f.rel) }, '补讲与' + (p.name || '对方') + '的故事');

    const item = h('div', { class: 'figure-card' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('div', { class: 'avatar', style: { width: '40px', height: '40px', fontSize: '14px' } }, initials(p.name)),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: 600 } }, p.name),
          h('div', { style: { marginTop: '4px' } }, relTag, ' ', note))),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } }, action));
    grid.appendChild(item);
  });
  card.appendChild(grid);
  container.appendChild(card);
}

function startFigureInterview(ownerId, figureId, rel) {
  window.__continuePersonId = ownerId;
  window.__focusFigure = { personId: ownerId, figureId, rel };
  location.hash = '#/interview';
}
