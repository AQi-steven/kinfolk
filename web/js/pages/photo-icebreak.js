// web/js/pages/photo-icebreak.js — 照片破冰（2026-10-04）
//
// 为什么做这个：老人面对"按住说话"的空白录音框，常常不知道从哪开口。
// 一张老照片能立刻把人拉回具体的某年某某���，这是竞品 StoryHeir 验证过的有效手法。
//
// 本模块只做"最小闭环"，刻意不做的事：
//   ✗ 不接通用视觉大模型（成本/延迟/隐私三重负担，且 hy3 不支持 tools）
//   ✗ 不做照片上色、家风词云等包装功能
//   ✓ 只做：选照片 → 可选一句补充 → AI 问一个具体问题 → 照片挂到本次访谈与章节
//
// 适老化约束：
//   1. 全程一步式，不做多步向导；每一步都有"跳过/取消"
//   2. 不强制上传，不阻断原有"按住说话"主流程
//   3. 任何失败都退回"直接说话"，绝不把老人卡在弹层里
window.PhotoIcebreak = (function () {
  'use strict';

  // 选照片：优先相机，其次相册。X5 下 capture 属性兼容性参差，故用 accept + 可选 capture
  function pickFile() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.style.position = 'fixed';
      inp.style.left = '-9999px';
      document.body.appendChild(inp);
      let done = false;
      const finish = (f) => {
        if (done) return;
        done = true;
        try { inp.remove(); } catch (_) {}
        resolve(f || null);
      };
      inp.onchange = () => finish(inp.files && inp.files[0] ? inp.files[0] : null);
      // 用户取消时 change 不触发；用 focus 兜底清理孤儿 input（不当作选择结果）
      window.addEventListener('focus', () => setTimeout(() => { if (!inp.files || !inp.files[0]) finish(null); }, 800), { once: true });
      inp.click();
    });
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  // 主入口：返回一个"翻出一张老照片"按钮
  // opts: { personId, interviewId, chapterId, topic, onIcebreak(replyText, photoUrl) }
  function createButton(opts) {
    // personId/interviewId 在访谈 start 之后才拿得到，用可变 ctx 承接
    const ctx = {
      personId: (opts && opts.personId) || null,
      interviewId: (opts && opts.interviewId) || null,
      chapterId: (opts && opts.chapterId) || null,
      hint: '',
      topic: (opts && opts.topic) || '',
    };
    const onIcebreak = opts && opts.onIcebreak;

    const btn = h('button', {
      id: 'photo-icebreak-btn',
      type: 'button',
      style: {
        width: '100%', height: '44px', borderRadius: '22px',
        background: 'transparent', color: 'var(--color-warm-gray, #8a8378)',
        border: '1px dashed var(--color-beige, #e2ddd4)',
        fontSize: '15px', cursor: 'pointer', touchAction: 'manipulation',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        marginBottom: '8px',
      },
      onclick: (e) => { e.preventDefault(); run(); },
    }, '🖼 翻出一张老照片');

    let busy = false;
    async function run() {
      if (busy) return;
      busy = true;
      const oldText = btn.textContent;
      btn.textContent = '选照片…';
      let file = null;
      try {
        file = await pickFile();
      } catch (_) { /* 用户取消 */ }
      if (!file) { btn.textContent = oldText; busy = false; return; }   // 取消 = 完全无副作用

      btn.textContent = '上传中…';
      let url = null;
      try {
        url = await upload(file, ctx);
      } catch (e) {
        // 上传失败不阻断：提示后回到原状，老人仍可直接说话
        btn.textContent = '照片没传上去，继续说话也行';
        setTimeout(() => { btn.textContent = oldText; }, 2600);
        busy = false;
        return;
      }

      btn.textContent = '想照片…';
      let reply = '';
      try {
        reply = await askIcebreak({ personId: ctx.personId, hint: ctx.hint, topic: ctx.topic });
      } catch (_) {
        reply = '看着这张照片，浮上来第一个念头是什么？';
      }
      btn.textContent = oldText;
      busy = false;
      if (typeof onIcebreak === 'function') onIcebreak(reply, url);
    }

    // 访谈启动后回填上下文（personId / interviewId 此前拿不到）
    btn.setContext = function (patch) {
      if (!patch) return;
      if (patch.personId) ctx.personId = patch.personId;
      if (patch.interviewId) ctx.interviewId = patch.interviewId;
    };

    return btn;
  }

  // 复用 api.js 的鉴权封装（api.js 会自动注入 Authorization + 处理 401）
  async function upload(file, ctx) {
    const { personId, interviewId, chapterId, hint } = ctx || {};
    const qs = new URLSearchParams();
    qs.set('person_id', String(personId || ''));
    if (interviewId) qs.set('interview_id', String(interviewId));
    if (chapterId) qs.set('chapter_id', String(chapterId));
    if (hint) qs.set('hint', String(hint).slice(0, 200));
    const r = await fetch('/api/media/upload?' + qs.toString(), {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': file.type || 'image/jpeg' },
        window.Store && window.Store.token ? { Authorization: 'Bearer ' + window.Store.token } : {}
      ),
      body: file,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j.url;
  }

  async function askIcebreak(ctx) {
    const { personId, hint, topic } = ctx || {};
    const r = await fetch('/api/media/icebreak', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        window.Store && window.Store.token ? { Authorization: 'Bearer ' + window.Store.token } : {}
      ),
      body: JSON.stringify({ person_id: personId, hint: hint || '', topic: topic || '' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j.reply || '';
  }

  // 在访谈页里渲染：照片卡片（显示刚传的图 + 破冰问句），并把问句作为一条 assistant 气泡接进对话流
  function photoCard(url) {
    return h('div', {
      style: {
        alignSelf: 'flex-start', maxWidth: '78%', marginBottom: '8px',
        borderRadius: '14px', overflow: 'hidden',
        border: '1px solid var(--color-beige, #e2ddd4)', background: '#fff',
      },
    }, h('img', { src: url, alt: '老照片', style: { width: '100%', display: 'block' } }));
  }

  return { createButton, photoCard, pickFile };
})();
