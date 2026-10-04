// web/js/app.js — 哈希路由 + 登录守卫 + 顶栏 ⚙️ 菜单
// 2026-09-13 晚：按用户决定删除底部 TabBar（传记=首页、访谈=首页主按钮、消息/我的收进右上角菜单）
(function () {
  // 不显示顶栏的（登录/认领是独立页）
  const HIDE_TOPBAR = new Set(['login']);

  async function ensureSelf() {
    if (window.Store.self) return;
    try {
      const r = await API.post('/auth/ensure-self', {});
      if (r.person) window.Store.setSelf(r.person);
    } catch (e) { /* 忽略，首页会提示 */ }
  }

  function isAuthRequired(name) {
    // 登录/认领是独立页，不进 SPA 路由
    return name !== 'login' && name !== 'claim';
  }

  async function router() {
    const raw = (location.hash || '').slice(1).replace(/^\/+/, '') || 'home';
    const parts = raw.split('/').filter(Boolean);
    const name = parts[0] || 'home';
    const param = parts[1];

    // 登录改用静态页 auth.html（规避 X5 密码键盘怪癖）
    if (name === 'login') {
      location.href = '/auth.html';
      return;
    }
    // 认领链接触发独立页（已登录则跳过）
    if (name === 'claim') {
      if (window.Store.isAuthed()) {
        location.href = '/claim.html';
      } else {
        location.href = '/claim.html?next=login';
      }
      return;
    }

    // 旧链接兼容：#/person/:id 曾是一套与 #/lifebook/:id 并行、功能重叠的人物页，
    // 2026-09-13 已合并为唯一入口 lifebook（传记第一性）。用 replace 而非赋值，
    // 避免返回键回到 person 又被弹回、形成"卡住"的观感。
    if (name === 'person') {
      if (!param) { location.replace('#/home'); return; }
      location.replace('#/lifebook/' + param);
      return;
    }

    // 旧链接兼容：#/timeline/:id 曾是"按时间线"的独立页，与人生书里的「回忆录」区读**同一张表**
    // （memoir_chapters）、同一套 7 档分组、同一套排序，只是显示多算了年龄/完整度。
    // 2026-09-14 用户拍板"如果是一致的，就不需要分两类" → 已并入「回忆录」，此页删除。
    // 同样用 replace：否则返回键会回到旧路由又被弹回来。
    if (name === 'timeline') {
      if (!param) { location.replace('#/home'); return; }
      location.replace('#/lifebook/' + param);
      return;
    }

    // 登录态守卫
    if (isAuthRequired(name) && !window.Store.isAuthed()) {
      location.hash = '#/login';
      return;
    }

    // 已登录 → 确保本人节点（首屏大树根）
    if (isAuthRequired(name) && window.Store.isAuthed()) {
      await ensureSelf();
    }

    setChrome(name);

    // 站内导航轨迹：用于顶栏「返回」判断"退得回去吗"
    const currentKey = name + (param ? '/' + param : '');
    if (_lastRouteKey && _lastRouteKey !== currentKey) _inAppNav = true;
    _lastRouteKey = currentKey;

    const main = document.getElementById('app');
    main.innerHTML = '';
    const render = window.Pages[name] || window.Pages.home;
    try {
      const r = render(main, param);
      if (r && typeof r.catch === 'function') r.catch((e) => showError(main, e));
    } catch (e) { showError(main, e); }
    window.scrollTo(0, 0);
  }

  // ===== 顶栏「返回」按钮（2026-09-14 用户要求：进/出页面的按钮位置要统一）=====
  // 设计要点：
  //   ① 位置由 index.html 固定在顶栏**最左**，所有内页复用**同一个 DOM**，
  //      不存在"每页各写一个、位置各不相同"的问题（此前：人生书在底部、时间线在右上、人物线没有）；
  //   ② 首页不显示（根页面没有"上一页"）；
  //   ③ 点击语义：本次会话内确实在站内跳转过 → history.back()；
  //      否则是被分享链接/主屏图标直接打开的深链，退不出去 → replace 到首页。
  //      用 replace 而非 location.hash=，避免往历史栈里再塞一条（否则连按返回会一直原地打转）。
  let _lastRouteKey = null;
  let _inAppNav = false;

  function setChrome(name) {
    const topbar = document.getElementById('topbar');
    if (topbar) topbar.style.display = HIDE_TOPBAR.has(name) ? 'none' : '';
    const back = document.getElementById('top-back-btn');
    if (back) back.style.display = (name === 'home' || HIDE_TOPBAR.has(name)) ? 'none' : 'inline-flex';
  }

  function goBack() {
    if (_inAppNav) history.back();
    else location.replace('#/home');
  }

  function setupBackButton() {
    const back = document.getElementById('top-back-btn');
    if (back) back.addEventListener('click', goBack);
  }

  function showError(main, e) {
    main.appendChild(h('div', { class: 'error' }, '页面出错：' + (e && e.message ? e.message : e)));
    console.error(e);
  }

  // 顶栏 ⚙️ 菜单
  function setupTopMenu() {
    const btn = document.getElementById('top-menu-btn');
    const menu = document.getElementById('top-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', () => { if (menu) menu.style.display = 'none'; });
    menu.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const act = el.getAttribute('data-action');
        if (act === 'settings') location.hash = '#/settings';
        else if (act === 'inbox') location.hash = '#/inbox';
        else if (act === 'verify') location.hash = '#/verify';
        else if (act === 'logout') { window.Store.logout(); location.href = '/auth.html'; }
        menu.style.display = 'none';
      });
    });

    // 总角标（菜单按钮 + 菜单内「消息」项）
    window.refreshInboxBadge = async function () {
      const tm = document.getElementById('tm-inbox-badge');
      const top = document.getElementById('top-menu-badge');
      if (!window.Store.isAuthed()) {
        if (tm) tm.style.display = 'none';
        if (top) top.style.display = 'none';
        return;
      }
      let n = 0;
      try {
        const r = await API.get('/persons/relay/inbox');
        n = (r.requests || []).length;
      } catch (_) { /* ignore */ }
      [tm, top].forEach((el) => {
        if (!el) return;
        el.textContent = n;
        el.style.display = n > 0 ? 'inline-flex' : 'none';
      });
    };
    window.refreshVerifyBadge = async function () {
      const badge = document.getElementById('tm-verify-badge');
      if (!badge || !window.Store.isAuthed()) return;
      try {
        const r = await API.get('/merge/proposals');
        const n = (r.proposals || []).length;
        badge.textContent = n;
        badge.style.display = n > 0 ? 'inline-flex' : 'none';
      } catch (_) { /* ignore */ }
    };
  }

  // 服务端版本兜底：若当前 HTML/JS 是旧版本，强制刷新（兼容微信 X5 极端缓存）
  async function checkAppVersion() {
    try {
      const res = await fetch('/api/health?_=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      const serverVer = data && data.version;
      const localVer = window.__APP_VERSION__;
      const lastSeen = sessionStorage.getItem('cybio_version_seen');
      if (serverVer && localVer && serverVer !== localVer && lastSeen !== serverVer) {
        sessionStorage.setItem('cybio_version_seen', serverVer);
        location.reload(true);
      }
    } catch (_) { /* 网络失败时不阻断 */ }
  }

  window.addEventListener('hashchange', router);

  window.addEventListener('DOMContentLoaded', function () {
    window.Store.load();
    setupTopMenu();
    setupBackButton();
    checkAppVersion().catch(() => {});
    if (window.Store.isAuthed() && window.refreshInboxBadge) window.refreshInboxBadge();
    if (window.Store.isAuthed() && window.refreshVerifyBadge) window.refreshVerifyBadge();
    router();
  });
  if (document.readyState !== 'loading') { window.Store.load(); setupTopMenu(); setupBackButton(); router(); }
})();
