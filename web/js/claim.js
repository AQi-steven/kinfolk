// web/js/claim.js — 公开认领流程
//   主线（2026-09-13 新增）：免密一键进入 —— 子女把链接发给 75+ 的父母，
//     父母点开 → 自动建号 + 绑节点 + 直接登录 → 零表单、零密码。
//   备用线：本人已有账号 → 走原来的「登录/注册后认领」表单。
// ⚠️ 全局作用域共享：本文件顶层符号不可与其它 web/js/*.js 重名（会整站白屏）。
//    改完请自行验证前端资源已正确打包。
(function () {
  const root = document.getElementById('claim-root');
  const params = new URLSearchParams(location.search);
  const token = params.get('token');

  if (!token) {
    root.appendChild(h('div', { class: 'card' }, h('h3', {}, '无法认领'), h('div', { class: 'muted' }, '链接缺少必要的参数，请检查你打开的链接是否完整。')));
    return;
  }

  function showError(msg, extra) {
    root.innerHTML = '';
    const card = h('div', { class: 'card' }, h('h3', {}, '⚠️ 无法认领'), h('div', { class: 'muted' }, msg));
    if (extra) card.appendChild(h('div', { class: 'muted', style: { marginTop: '10px' } }, extra));
    root.appendChild(card);
  }

  let nodeName = '';

  async function init() {
    root.innerHTML = '';
    root.appendChild(loading('正在读取邀请…'));
    let inv;
    try { inv = await API.get('/invitations/' + token); }
    catch (e) { showError('邀请无效或已失效：' + e.message); return; }

    nodeName = (inv && inv.node && inv.node.name) || '';

    if (inv.status === 'expired') { showError('这条链接已经过期了，请让家人重新生成一条发给你。'); return; }
    if (inv.status === 'claimed') {
      // 可能是老人自己在别的手机/浏览器上已经进过 —— 给一次尝试自动重登的机会；
      // 若链接不是"自动开的号"（服务端会 409），再退到登录表单。
      const ok = await tryAutoEnter(true);
      if (!ok) renderAuth(nodeName);
      return;
    }
    // 已登录用户：直接走认领确认
    if (window.Store.isAuthed()) { renderClaim(nodeName); return; }
    renderDoor(nodeName);
  }

  // ===== 免密一键进入（主线入口）=====
  // silent=true 时不弹错误 toast（用于"已认领"分支的静默试探）
  async function tryAutoEnter(silent) {
    try {
      const r = await API.post('/claims/' + token + '/auto', {});
      window.Store.setAuth(r.token, r.user);
      window.Store.setSelf({ id: r.person_id });
      toast(r.reused ? '欢迎回来' : '认领成功，欢迎！');
      // 略微延迟，让 toast 可见
      setTimeout(function () { location.href = 'index.html#/lifebook/' + r.person_id; }, 400);
      return true;
    } catch (e) {
      if (!silent) {
        const msg = (e && e.message) ? e.message : String(e);
        if (/已经认领/.test(msg)) {
          showError('这个节点已经认领过了', '如果你是本人，说明你已经注册过账号啦 —— 请改用下面的「我有账号，去登录」进来。');
        } else {
          showError('进入失败：' + msg);
        }
      }
      return false;
    }
  }

  // 首屏：一个大按钮，别无其它（适老化）
  function renderDoor(name) {
    root.innerHTML = '';
    const safeName = esc(name);
    const card = h('div', { class: 'card', style: { textAlign: 'center' } });
    card.innerHTML = ''
      + '<div style="font-size:15px;color:#8a7d6d;margin-bottom:6px">家人邀请你</div>'
      + '<div style="font-size:26px;font-weight:800;line-height:1.35;margin-bottom:6px">'
      +   (safeName ? '记录「' + safeName + '」的一生' : '记录你的一生')
      + '</div>'
      + '<div style="font-size:15px;color:#8a7d6d;line-height:1.6;margin-bottom:22px">'
      +   '点下面的按钮就能进去，<b>不用注册、不用记密码</b>。'
      + '</div>'
      + '<button id="ca-enter" class="btn-block" type="button" '
      +   'style="font-size:22px;padding:18px 16px;font-weight:800">'
      +   '👉 一键进入'
      + '</button>'
      + '<div style="font-size:13px;color:#a09484;margin-top:14px;line-height:1.6">'
      +   '进去以后，AI 会像老朋友一样陪你聊天，<br/>把你讲的故事一句句记下来。'
      + '</div>';
    root.appendChild(card);

    const more = h('div', { style: { textAlign: 'center', marginTop: '18px' } });
    more.innerHTML = '<a href="javascript:void(0)" id="ca-has-account" '
      + 'style="font-size:14px;color:#8a7d6d;text-decoration:underline">我有账号，去登录</a>';
    root.appendChild(more);

    card.querySelector('#ca-enter').addEventListener('click', function () {
      const b = this;
      b.disabled = true;
      b.textContent = '正在进入…';
      tryAutoEnter(false).then(function (ok) {
        if (!ok) { b.disabled = false; b.textContent = '👉 一键进入'; }
      });
    });
    more.querySelector('#ca-has-account').addEventListener('click', function () { renderAuth(name); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ===== 备用线：已有账号 → 注册/登录后认领 =====
  // ⚠️ 微信 X5 内核怪癖：动态 createElement 出的 type=password 节点，点击常弹不起键盘。
  //    因此这里用静态 HTML（innerHTML 直接写 <input>），与 auth.html 同源方案。
  function renderAuth(nodeName) {
    root.innerHTML = '';
    let mode = 'login';
    const safeName = esc(nodeName);
    const card = h('div', { class: 'card' });
    card.innerHTML = ''
      + '<div class="auth-brand" style="text-align:left;margin-bottom:14px">'
      +   '<div style="font-size:16px;font-weight:700">认领「' + safeName + '」</div>'
      +   '<div class="muted" style="font-size:13px">如果你已经有账号，在这里登录即可。</div>'
      + '</div>'
      + '<div class="auth-tabs">'
      +   '<button data-m="login" class="active" type="button">登录</button>'
      +   '<button data-m="register" type="button">注册</button>'
      + '</div>'
      + '<form id="claim-auth-form" autocomplete="on" style="margin-top:14px">'
      +   '<div class="field"><label>账号（手机号或邮箱）</label><input id="ca-id" class="input" type="text" inputmode="email" autocomplete="username" placeholder="手机号或邮箱" /></div>'
      +   '<div class="field" id="ca-field-nick" style="display:none"><label>昵称</label><input id="ca-nick" class="input" type="text" autocomplete="nickname" placeholder="昵称（家人怎么称呼你）" /></div>'
      +   '<div class="field" id="ca-field-real" style="display:none"><label>真实姓名（身份锚）</label><input id="ca-real" class="input" type="text" autocomplete="name" value="' + safeName + '" /></div>'
      +   '<div class="field"><label>密码</label>'
      +     '<div class="pw-row">'
      +       '<input id="ca-pw" class="input pw-input" type="password" name="password" autocomplete="current-password" placeholder="密码（至少 6 位）" />'
      +       '<button id="ca-pw-toggle" class="pw-toggle" type="button" aria-label="显示密码">👁</button>'
      +     '</div>'
      +   '</div>'
      +   '<button id="ca-submit" class="btn-block" type="submit">登录并认领</button>'
      +   '<div id="ca-hint" class="muted" style="margin-top:10px;text-align:center"></div>'
      + '</form>';
    root.appendChild(card);

    const form = card.querySelector('#claim-auth-form');
    const idInput = card.querySelector('#ca-id');
    const nickInput = card.querySelector('#ca-nick');
    const realInput = card.querySelector('#ca-real');
    const pwInput = card.querySelector('#ca-pw');
    const pwToggle = card.querySelector('#ca-pw-toggle');
    const nickField = card.querySelector('#ca-field-nick');
    const realField = card.querySelector('#ca-field-real');
    const submit = card.querySelector('#ca-submit');
    const hint = card.querySelector('#ca-hint');
    const tabs = card.querySelectorAll('.auth-tabs button');

    function sw(m) {
      mode = m;
      tabs.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-m') === m); });
      nickField.style.display = m === 'register' ? '' : 'none';
      realField.style.display = m === 'register' ? '' : 'none';
      submit.textContent = m === 'register' ? '注册并认领' : '登录并认领';
      hint.textContent = m === 'register' ? '密码至少 6 位；已为你填好真名，可修改。' : '';
      pwInput.setAttribute('autocomplete', m === 'register' ? 'new-password' : 'current-password');
    }
    tabs.forEach(function (b) { b.addEventListener('click', function () { sw(b.getAttribute('data-m')); }); });
    if (pwToggle) pwToggle.addEventListener('click', function (e) {
      e.preventDefault();
      const showing = pwInput.getAttribute('type') === 'text';
      pwInput.setAttribute('type', showing ? 'password' : 'text');
      pwToggle.textContent = showing ? '👁' : '🙈';
      pwToggle.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const identifier = idInput.value.trim();
      const password = pwInput.value;
      if (!identifier || !password) { toast('请填写账号和密码'); return; }
      if (mode === 'register' && password.length < 6) { toast('密码至少 6 位'); return; }
      submit.disabled = true;
      try {
        let r;
        if (mode === 'register') {
          // ⚠️ 必须带 real_name（身份锚）。此前这里漏传，导致 users.real_name 被后端
          // 落成昵称（可能是"妈妈"），破坏真名锚、后续按真名匹配节点会错。
          // 认领场景下真名是已知的（邀请的就是这个节点），已在输入框里预填。
          r = await API.post('/auth/register', {
            identifier, password,
            nickname: nickInput.value.trim() || identifier,
            real_name: realInput.value.trim() || nodeName,
          });
        } else {
          r = await API.post('/auth/login', { identifier, password });
        }
        window.Store.setAuth(r.token, r.user);
        renderClaim(nodeName);
      } catch (e2) { toast('失败：' + (e2 && e2.message ? e2.message : e2)); }
      finally { submit.disabled = false; }
    });
    sw('login');
  }

  // ===== 认领动作（已登录）=====
  async function renderClaim(nodeName) {
    root.innerHTML = '';
    const card = h('div', { class: 'card' },
      h('h3', {}, '认领「' + nodeName + '」'),
      h('div', { class: 'muted', style: { marginBottom: '12px' } }, '认领后，这个节点就绑定到你的账号，你可以补全自己的生平，并决定哪些回忆对外可见。'),
      h('button', { class: 'btn-block', onclick: doClaim }, '确认认领'));
    root.appendChild(card);
  }

  async function doClaim() {
    try {
      const r = await API.post('/claims/' + token, {});
      toast('认领成功，欢迎加入！');
      location.href = 'index.html#/lifebook/' + r.person_id;
    } catch (e) {
      toast('认领失败：' + e.message);
    }
  }

  init();
})();
