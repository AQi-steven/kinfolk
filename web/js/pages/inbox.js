// web/js/pages/inbox.js — 授权请求收件箱（本人审批他人代录申请）
window.Pages = window.Pages || {};
window.Pages.inbox = async function (main) {
  main.appendChild(h('div', { class: 'page-title' }, '🔑 授权请求'));
  main.appendChild(h('div', { class: 'muted', style: { marginBottom: '12px' } },
    '当有人想代录你的传记时，会在这里出现申请。同意后才可代录，拒绝则对方只能看到你的关系位置。'));

  let rows;
  try {
    const r = await API.get('/persons/relay/inbox');
    rows = r.requests || [];
  } catch (e) {
    main.appendChild(h('div', { class: 'error' }, '加载失败：' + e.message));
    return;
  }

  if (!rows.length) {
    main.appendChild(h('div', { class: 'empty' }, '暂无待处理的授权请求。'));
    return;
  }

  const list = h('div', { class: 'card' });
  rows.forEach((req) => {
    const item = h('div', { class: 'inbox-item' },
      h('div', { class: 'inbox-who' }, (req.requester_name || ('用户#' + req.requester_user_id)) + ' 想代录「' + (req.target_name || '') + '」'),
      req.reason ? h('div', { class: 'inbox-reason muted' }, '理由：' + req.reason) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-small', onclick: () => review(req.id, 'approve', item) }, '✅ 同意'),
        h('button', { class: 'btn-soft btn-small', onclick: () => review(req.id, 'reject', item) }, '❌ 拒绝')));
    list.appendChild(item);
  });
  main.appendChild(list);
};

async function review(rid, action, item) {
  try {
    await API.post('/persons/relay/' + rid + '/review', { action });
    toast(action === 'approve' ? '已同意，对方可以代录了' : '已拒绝');
    if (item) item.style.display = 'none';
    // 刷新角标
    if (window.refreshInboxBadge) window.refreshInboxBadge();
  } catch (e) {
    toast('操作失败：' + e.message);
  }
}
