// web/js/auth.js — 登录/注册页逻辑（配合静态 auth.html，input 直接写在 HTML 中）
// 关键：input 是静态 HTML 元素，不依赖 h() 动态创建，X5 微信内核可正常弹键盘。
(function () {
  let mode = 'login';

  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const form = document.getElementById('auth-form');
  const idInput = document.getElementById('f-id');
  const nickInput = document.getElementById('f-nick');
  const pwInput = document.getElementById('f-pw');
  const pwToggle = document.getElementById('pw-toggle');
  const nickField = document.getElementById('field-nick');
  const realField = document.getElementById('field-real');
  const realInput = document.getElementById('f-real');
  const submitBtn = document.getElementById('submit-btn');

  // 显示/隐藏密码：用户主动点击切换 type，不在 focus 时序内，X5 安全
  if (pwToggle) {
    pwToggle.addEventListener('click', function (e) {
      e.preventDefault();
      const showing = pwInput.getAttribute('type') === 'text';
      pwInput.setAttribute('type', showing ? 'password' : 'text');
      pwToggle.textContent = showing ? '👁' : '🙈';
      pwToggle.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
    });
  }

  function switchMode(m) {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabRegister.classList.toggle('active', m === 'register');
    nickField.style.display = m === 'register' ? '' : 'none';
    realField.style.display = m === 'register' ? '' : 'none';
    submitBtn.textContent = m === 'register' ? '注册并进入' : '登录';
    // 登录/注册切换时调整 autocomplete，降低浏览器自动填充干扰
    pwInput.setAttribute('autocomplete', m === 'register' ? 'new-password' : 'current-password');
  }

  tabLogin.addEventListener('click', () => switchMode('login'));
  tabRegister.addEventListener('click', () => switchMode('register'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = idInput.value.trim();
    const password = pwInput.value;
    if (!identifier || !password) { toast('请填写账号和密码'); return; }
    if (mode === 'register' && password.length < 6) { toast('密码至少 6 位'); return; }
    if (mode === 'register' && !realInput.value.trim()) { toast('请填写真实姓名（身份锚，用于对齐家族树）'); return; }
    submitBtn.disabled = true;
    try {
      let r;
      if (mode === 'register') {
        r = await API.post('/auth/register', { identifier, password, nickname: nickInput.value.trim() || identifier, real_name: realInput.value.trim() });
      } else {
        r = await API.post('/auth/login', { identifier, password });
      }
      window.Store.setAuth(r.token, r.user);
      // 立即拉取/重建本人节点，避免本地 selfId 过期或被合并后失效
      try {
        const selfR = await API.post('/auth/ensure-self', {});
        if (selfR && selfR.person) window.Store.setSelf(selfR.person);
      } catch (es) { /* 忽略，#/home 会再次兜底 */ }
      toast(mode === 'register' ? '注册成功' : '登录成功');
      // 跳回主 SPA（以本人为中心的家族大树首屏）
      location.href = '/#/home';
    } catch (err) {
      toast('失败：' + (err && err.message ? err.message : err));
    } finally {
      submitBtn.disabled = false;
    }
  });

  // 已登录则直接进主程序
  try { window.Store.load(); } catch (_) {}
  if (window.Store && window.Store.isAuthed && window.Store.isAuthed()) {
    location.href = '/#/home';
  }
})();
