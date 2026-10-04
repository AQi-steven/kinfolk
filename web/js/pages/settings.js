// web/js/pages/settings.js — 账户 / AI 模型状态 / 退出（全局图模型，无「家族」概念）
window.Pages = window.Pages || {};
window.Pages.settings = async function (main) {
  const user = window.Store.user;

  // 账户
  main.appendChild(h('div', { class: 'card' },
    h('h3', {}, '👤 账户'),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      h('div', { class: 'avatar' }, initials(user.nickname || user.identifier)),
      h('div', {},
        h('div', { style: { fontWeight: '700' } }, user.nickname || user.identifier),
        h('div', { class: 'meta' }, user.identifier))),
  ));

  // AI 模型状态
  const aiCard = h('div', { class: 'card' },
    h('h3', {}, '🤖 AI 访谈引擎'),
    h('div', { class: 'muted', style: { fontSize: '13px' } }, '加载中…'),
  );
  main.appendChild(aiCard);
  try {
    const c = await API.get('/settings');
    aiCard.innerHTML = '';
    aiCard.appendChild(h('h3', {}, '🤖 AI 访谈引擎'));
    const statusText = c.demoMode
      ? '演示模式（未配置有效模型，使用脚本化兜底）'
      : '真实模型运行中';
    aiCard.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
      h('span', { class: 'muted' }, '状态'), h('span', {}, statusText)));
    aiCard.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
      h('span', { class: 'muted' }, '提供方'), h('span', {}, c.provider || '—')));
    aiCard.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
      h('span', { class: 'muted' }, '模型'), h('span', {}, c.model || '—')));
    aiCard.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
      h('span', { class: 'muted' }, '凭证来源'), h('span', {}, c.source || '—')));
    const testBtn = h('button', { class: 'btn-soft btn-small', style: { marginTop: '12px' }, onclick: testConn }, '测试模型连接');
    aiCard.appendChild(testBtn);
    async function testConn() {
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      try {
        const r = await API.post('/settings/test');
        toast(r && r.ok ? ('连接成功：' + (r.model || '')) : ('失败：' + (r.message || '未知')));
      } catch (e) { toast('失败：' + e.message); }
      finally { testBtn.disabled = false; testBtn.textContent = '测试模型连接'; }
    }
  } catch (e) {
    aiCard.innerHTML = '';
    aiCard.appendChild(h('h3', {}, '🤖 AI 访谈引擎'));
    aiCard.appendChild(h('div', { class: 'muted' }, '状态获取失败：' + e.message));
  }

  // 退出
  main.appendChild(h('div', { class: 'card' },
    h('button', { class: 'btn-danger btn-block', onclick: logout }, '退出登录'),
  ));

  function logout() {
    window.Store.logout();
    location.hash = '#/login';
  }
};
