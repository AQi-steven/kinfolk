// web/js/pages/interview.js — 陪伴式 AI 访谈（真实引擎版）
// 直连后端 /api/interview：start → message → review → resay → finish
// 后端引擎：llm.js（问句生成 + 抽取）+ extractor.js（亲属/字段抽取）+ 复核闸门
// 关键约束（血泪教训，勿删）：
//   1. 微信 X5 禁止无手势自动播放 TTS → unlockAudio() 必须在真实手势回调内首次执行
//   2. TTS 走 /api/tts（服务端腾讯云合成），ASR 走 /api/asr（16k PCM WAV 上传）
//   3. 本页禁止动态创建 type=password 输入（X5 键盘弹不出，登录走 auth.html）
window.Pages = window.Pages || {};

// ============ 音频解锁（微信 X5 / iOS Safari 必需）============
// 移动端禁止「无用户手势」的 play()。必须在真实手势回调里成功播放一次，
// 才能解锁本页后续所有程序化 play()（AI 问话自动朗读依赖它）。
let __audioUnlocked = false;
let __unlockPromise = null;
function unlockAudio() {
  if (__audioUnlocked) return Promise.resolve(true);
  if (__unlockPromise) return __unlockPromise;
  __unlockPromise = (async () => {
    try {
      const a = new Audio('/silence.wav'); // 同源静音探针，真实播放一次
      a.volume = 0;
      await a.play();
      a.pause();
      __audioUnlocked = true;
      // AudioContext 双保险（部分浏览器策略独立）
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          if (ctx.state === 'suspended') await ctx.resume();
          if (ctx.close) ctx.close();
        }
      } catch (_) {}
      return true;
    } catch (_) {
      __unlockPromise = null; // 失败不标，下次手势再试
      return false;
    }
  })();
  return __unlockPromise;
}
window.__cybioUnlockAudio = unlockAudio;

// ============ TTS 朗读队列（串行，避免多条 AI 回复重叠串音）============
let __speakQueue = [];
let __speaking = false;
let __currentAudio = null;
const TTS_VOICE = '101007'; // 温柔女声（Neural），适老陪伴场景

function speak(text) {
  if (!text) return;
  __speakQueue.push(text);
  pumpSpeak();
}
function pumpSpeak() {
  if (__speaking || !__speakQueue.length) return;
  const text = __speakQueue.shift();
  if (!__audioUnlocked) {
    // 未解锁不静默失败，给用户明示（首条常发生，点一次 🔊 即解锁）
    toast('点一下 AI 气泡旁的 🔊 就能听到朗读');
    return;
  }
  __speaking = true;
  const done = () => { __speaking = false; __currentAudio = null; pumpSpeak(); };
  fetch('/api/tts?text=' + encodeURIComponent(text.slice(0, 150)) + '&voice=' + TTS_VOICE, {
    headers: window.Store.token ? { Authorization: 'Bearer ' + window.Store.token } : {},
  })
    .then((r) => r.json())
    .then((j) => {
      if (!j.url) return done();
      const a = new Audio(j.url);
      __currentAudio = a;
      a.onended = done;
      a.onerror = done;
      a.play().catch(() => done());
    })
    .catch(() => done());
}
function stopSpeak() {
  __speakQueue = [];
  __speaking = false;
  if (__currentAudio) { try { __currentAudio.pause(); } catch (_) {} __currentAudio = null; }
}
window.__cybioStopSpeak = stopSpeak;

// ============ 页面主体 ============
window.Pages.interview = async function (main) {
  if (!window.Store.self) {
    main.appendChild(h('div', { class: 'error' }, '请先登录'));
    return;
  }

  const param = (location.hash.split('/')[2] || '').trim(); // #/interview/{personId} 可指定对象
  const state = {
    interviewId: null,
    target: null,
    demoMode: false,
    busy: false,
  };
  window.__cybioInterviewState = state;

  // ---------- 入口意图 ----------
  // home.js 的「🎙 聊聊我的故事」会置 __homeGate='me'，意图明确 → 跳过选择直接开聊；
  // 带 personId 的（从人物页进来）同理，聚焦那个人。其余从菜单点进来的才问一句。
  //
  // 🔴 2026-09-14 修复「带了意图却没人读」的老坑：
  //   人生书/时间线/人物线点「＋补讲」「接着聊」时都会先写 window.__continueHint / __focusFigure，
  //   但本页此前**只被赋值、从来没被读取** —— 结果点"补讲"进来落到模式选择卡片上，
  //   era / chapterId / 聚焦人物全部丢失（用户观感："这个补讲没用"）。
  //   现在在这里一次性消费掉这两个全局，并据此直接进入对话。
  const hint = window.__continueHint;
  window.__continueHint = null;
  const figureHint = window.__focusFigure;
  window.__focusFigure = null;

  // 围绕某人补讲（人物线）：带 figureId；阶段/章节补讲（人生书）：带 era / chapterId
  const contHint = (hint && hint.personId) ? hint : null;
  const focusHint = (figureHint && figureHint.figureId) ? figureHint : null;

  const gate = window.__homeGate;
  window.__homeGate = null;
  const focusId = focusHint ? focusHint.figureId : param;
  const directMode = (gate === 'me' || contHint) ? 'self' : (focusId ? 'focus' : null);
  if (directMode) {
    startFlow(directMode, focusId, contHint);
    return;
  }

  const MODE_KEY = 'cybio_interview_mode';
  const chosenMode = sessionStorage.getItem(MODE_KEY);
  if (!chosenMode) {
    renderModePicker(main, param, (mode) => {
      sessionStorage.setItem(MODE_KEY, mode);
      startFlow(mode, param, contHint);
    });
    return;
  }
  startFlow(chosenMode, param, contHint);

  // ============ 启动访谈流程 ============
  // contHint：从人生书带过来的续讲意图 { personId, era, chapterId, chapterTitle }
  async function startFlow(mode, personId, contHint) {
    main.innerHTML = '';
    main.appendChild(h('h1', { class: 'page-title' }, '🎙 访谈'));
    // 带续讲意图时，把"接着补哪一段"写在标题下方 —— 老人进来要能立刻确认自己在补哪一节
    if (contHint && contHint.chapterTitle) {
      main.appendChild(h('p', { class: 'page-subtitle' }, '接着「' + contHint.chapterTitle + '」这一节讲，想到什么说什么。'));
    } else if (contHint && contHint.era) {
      main.appendChild(h('p', { class: 'page-subtitle' }, '接着讲「' + contHint.era + '」那段日子，想到什么说什么。'));
    } else {
      main.appendChild(h('p', { class: 'page-subtitle' }, 'AI 像朋友一样，听你慢慢讲。'));
    }

    const chatList = h('div', {
      id: 'chat-list', class: 'chat-scroll',
      // 底部留白必须 ≥ 悬浮语音条高度（提示行+按钮+内边距 ≈ 100px），
      // 否则最后的内容（尤其复核卡的「记下来/我要修改」按钮）会被悬浮条盖住（2026-09-13 用户截图反馈）
      style: { minHeight: '50vh', paddingBottom: '140px' },
    });
    main.appendChild(chatList);

    // 底部「按住说话」条（悬浮固定在视口底部）
    // 产品决策（2026-09-13 用户要求）：**不要文字输入框**，只保留按住说话按钮。
    //   访谈是"老朋友陪着聊天"的场景，打字会破坏讲述节奏；老人也不擅长打字。
    // 2026-09-13 修复：TabBar 已删，bottom 从 64px（旧 TabBar 高度残留）改为 0 贴底 + iOS 安全区。
    const inputBar = h('div', {
      id: 'talk-bar',
      style: {
        position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '20',
        background: 'var(--color-pure-white)', borderTop: '1px solid var(--color-beige)',
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: '6px',
        maxWidth: '480px', margin: '0 auto',
      },
    });

    const hint = h('div', {
      style: {
        fontSize: '12px', color: 'var(--color-warm-gray)', minHeight: '16px',
        textAlign: 'center', transition: 'color .15s',
      },
    }, '按住说话，松开就发出');

    const micBtn = h('button', {
      id: 'talk-btn',
      style: {
        width: '100%', height: '52px', borderRadius: '26px',
        background: 'var(--color-ochre)', color: '#fff', border: 'none',
        fontSize: '17px', fontWeight: '600', cursor: 'pointer',
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        transition: 'transform .08s, background .15s',
      },
    }, '🎤 按住说话');
    const micLabel = () => micBtn.lastChild;
    // 🖼 照片破冰（2026-10-04）：老人有时面对空白录音框不知从何开口，
    // 翻一张老照片最容易起头。这是**可选**的第二入口，不阻断"按住说话"主流程。
    let iceBtn = null;
    if (window.PhotoIcebreak && mode !== 'relay') {
      iceBtn = window.PhotoIcebreak.createButton({
        personId: null,               // start 之后回填
        interviewId: null,
        chapterId: (contHint && contHint.chapterId) ? +contHint.chapterId : null,
        topic: (contHint && (contHint.chapterTitle || contHint.era)) || '',
        onIcebreak: async (replyText, photoUrl) => {
          // 照片先出现，再出现 AI 的破冰问句（走既有朗读队列 → 老人能直接听到）
          if (photoUrl) chatList.appendChild(window.PhotoIcebreak.photoCard(photoUrl));
          addBubble(chatList, { role: 'assistant', text: replyText }, true);
          scrollBottom(chatList);
        },
      });
    }
    inputBar.appendChild(hint);
    if (iceBtn) inputBar.appendChild(iceBtn);
    inputBar.appendChild(micBtn);
    document.body.appendChild(inputBar);

    let cleanupTalk = null;
    const cleanup = () => {
      inputBar.remove();
      stopSpeak();
      if (cleanupTalk) cleanupTalk();
    };
    window.addEventListener('hashchange', cleanup, { once: true });

    // 录音控制器（按住说话 MVP：服务端 ASR）
    const talk = createTalkToText({
      onHint: (t, color) => { hint.textContent = t; hint.style.color = color || 'var(--color-warm-gray)'; },
      onLevel: (lv) => {
        // 录音时按钮轻微放大，给触觉反馈感
        micBtn.style.transform = lv ? 'scale(1.02)' : 'scale(1)';
      },
      onText: async (text, audioId) => {
        if (!text || !text.trim()) {
          hint.textContent = '没听清，再说一次试试';
          hint.style.color = 'var(--color-error, #c0392b)';
          return;
        }
        // audioId 暂存到 state，submit 时随消息一起提交给后端做关联
        state.pendingAudioId = audioId || null;
        await submit(text.trim());
      },
      setRecording: (on) => {
        micBtn.style.background = on ? '#c0392b' : 'var(--color-ochre)';
        micLabel().textContent = on ? '松开 发送' : '🎤 按住说话';
      },
      beforeStart: () => unlockAudio(),
    });

    // ---------- 启动访谈 ----------
    const thinking = addThinking(chatList);
    try {
      const body = {
        type: 'person_claim',
        nickname: (window.Store.user && window.Store.user.nickname) || '',
      };
      if (mode === 'focus' && personId) body.focus_person_id = +personId;
      if (mode === 'relay' && personId) { body.target_person_id = +personId; body.relay_mode = true; }
      // 从人生书带过来的续讲意图（此前完全没往后端传，见本页顶部「入口意图」注释）
      if (contHint && contHint.era) body.era = contHint.era;
      // 章节级「🎙 接着聊」：把章号传下去，后端沉淀时把新内容融进那一章，而不是新建章节
      if (contHint && contHint.chapterId) body.chapter_id = +contHint.chapterId;
      const r = await API.post('/interview/start', body);
      state.interviewId = r.interviewId;
      state.target = r.target;
      state.demoMode = r.demoMode;
      // 录音归属这场访谈（原音追溯用）：ASR 请求会带上它
      window.__cybioInterviewId = r.interviewId;
      // 访谈起来后才知道本人节点 id → 回填给照片破冰按钮，照片才能挂到正确的人/访谈上
      if (iceBtn && iceBtn.setContext) {
        const tid = r.target && (r.target.id || r.target.person_id);
        if (tid) iceBtn.setContext({ personId: +tid, interviewId: r.interviewId });
      }
      thinking.remove();
      if (r.demoMode) {
        chatList.appendChild(h('div', {
          class: 'muted', style: { fontSize: '12px', textAlign: 'center', margin: '4px 0 10px' },
        }, '当前为演示模式（未配置真实大模型）'));
      }
      // 2026-09-14：同一场访谈会被复用（后端不再每次新建），故首次进来可能是"续聊"，
      // 需要把已有对话回放出来，否则老人会以为之前的记录丢了。
      if (r.resumed && Array.isArray(r.history) && r.history.length) {
        chatList.appendChild(h('div', {
          class: 'muted', style: { fontSize: '12px', textAlign: 'center', margin: '4px 0 12px' },
        }, '— 接着上次的地方继续 —'));
        // 历史回放不自动朗读，避免一次念一大段（按需点每条气泡的 🔊）
        r.history.forEach((m) => addBubble(chatList, { role: m.role === 'user' ? 'user' : 'assistant', text: m.content }, false));
        chatList.appendChild(h('div', {
          class: 'muted', style: { fontSize: '13px', textAlign: 'center', margin: '10px 0 4px' },
        }, '想接着说，就按住下面的按钮说话'));
        scrollBottom(chatList);
      } else {
        addBubble(chatList, { role: 'assistant', text: r.reply }, true);
      }
    } catch (e) {
      thinking.remove();
      chatList.appendChild(h('div', { class: 'error' }, '启动访谈失败：' + e.message));
      return;
    }

    // ---------- 发送（由语音识别结果驱动）----------
    async function submit(text) {
      if (state.busy || !text || !text.trim()) return;
      state.busy = true;
      talk.setEnabled(false);
      addBubble(chatList, { role: 'user', text });
      const th = addThinking(chatList);
      // 本轮的原音 id（若有），提交后由后端关联到这条原话
      const audioId = state.pendingAudioId;
      state.pendingAudioId = null;
      try {
        const r = await API.post('/interview/message', {
          interviewId: state.interviewId,
          text,
          nickname: (window.Store.user && window.Store.user.nickname) || '',
          audio_id: audioId || undefined,
        });
        th.remove();
        state.target = r.target || state.target;
        // 复核框优先：先让用户核对本轮抽到的事实，确认后才出 AI 下一句（核心信任机制）
        if (r.review && r.review.length) {
          renderReview(chatList, r.review, r.reply, () => {
            if (r.chapter) renderChapter(chatList, r.chapter);
            refreshGraphBadge(r);
          });
        } else {
          addBubble(chatList, { role: 'assistant', text: r.reply }, true);
          if (r.chapter) renderChapter(chatList, r.chapter);
          refreshGraphBadge(r);
        }
      } catch (e) {
        th.remove();
        chatList.appendChild(h('div', { class: 'error' }, '发送失败：' + e.message));
      } finally {
        state.busy = false;
        talk.setEnabled(true);
      }
    }

    window.__cybioSubmit = submit;
    cleanupTalk = () => { try { talk.destroy(); } catch (_) {} };
  }
};

// ============ 模式选择弹层 ============
function renderModePicker(main, param, onPick) {
  main.innerHTML = '';
  const card = h('div', { class: 'card' });

  card.appendChild(h('h2', { class: 'card-title' }, '今天想聊点什么？'));
  card.appendChild(h('p', { class: 'muted', style: { marginBottom: '16px', lineHeight: '1.6' } },
    'AI 会像老朋友一样陪你聊。你说的话它会悄悄记下来，慢慢长成一本传记。'));

  const mk = (label, sub, mode, cls) => h('button', {
    class: cls + ' btn-block',
    style: { marginBottom: '10px', textAlign: 'left', padding: '14px 16px' },
    onclick: async () => {
      await unlockAudio(); // 趁真实手势解锁音频，让首条 AI 问话就能自动朗读
      onPick(mode);
    },
  },
    h('div', { style: { fontWeight: '700', fontSize: '15px' } }, label),
    sub ? h('div', { style: { fontSize: '12px', opacity: '.75', marginTop: '2px', fontWeight: '400' } }, sub) : null);

  card.appendChild(mk('🏗 聊聊我的故事', '讲自己的经历，顺带提一提家里人', 'self', 'btn-primary'));
  if (param) {
    card.appendChild(mk('👤 围绕这位家人聊', '为这位亲属补充更多细节', 'focus', 'btn-secondary'));
  }
  card.appendChild(mk('✍️ 接着上次继续', '直接进入对话，慢慢讲', 'self', 'btn-secondary'));

  card.appendChild(h('div', { style: { height: '6px' } }));
  card.appendChild(h('button', {
    class: 'btn-soft btn-block',
    onclick: () => { location.hash = '#/home'; },
  }, '下次再说'));
  main.appendChild(card);
}

// ============ 气泡渲染（v2 视觉 + 朗读按钮）============
function addBubble(chatList, m, autoSpeak) {
  if (m.role === 'user') {
    const row = h('div', { class: 'flex', style: { justifyContent: 'flex-end', marginBottom: '12px' } });
    row.appendChild(h('div', { class: 'bubble-user' }, m.text));
    chatList.appendChild(row);
    scrollBottom(chatList);
    return row;
  }
  const row = h('div', {
    class: 'flex items-start gap-2',
    style: { marginBottom: '12px', maxWidth: '90%' },
  });
  row.appendChild(h('span', {
    class: 'avatar-circle avatar-circle-pine',
    style: { width: '36px', height: '36px', fontSize: '13px', flexShrink: '0' },
  }, 'AI'));
  const inner = h('div', { style: { minWidth: '0' } });
  inner.appendChild(h('div', { class: 'bubble-ai' }, m.text));
  const tools = h('div', { class: 'flex items-center gap-2', style: { marginTop: '4px' } });
  tools.appendChild(h('button', {
    class: 'btn-soft', style: { fontSize: '12px', padding: '4px 10px' }, title: '朗读',
    onclick: async () => { await unlockAudio(); speak(m.text); },
  }, '🔊'));
  tools.appendChild(h('button', {
    class: 'btn-soft', style: { fontSize: '12px', padding: '4px 10px' }, title: '停止朗读',
    onclick: () => stopSpeak(),
  }, '⏹'));
  inner.appendChild(tools);
  row.appendChild(inner);
  chatList.appendChild(row);
  scrollBottom(chatList);
  if (autoSpeak) speak(m.text);
  return row;
}

function addThinking(chatList) {
  const row = h('div', { class: 'flex items-center gap-2', style: { marginBottom: '12px' } },
    h('span', { class: 'avatar-circle avatar-circle-pine', style: { width: '36px', height: '36px', fontSize: '13px' } }, 'AI'),
    h('span', { class: 'muted', style: { fontSize: '13px' } }, '正在想…')
  );
  chatList.appendChild(row);
  scrollBottom(chatList);
  return row;
}

function scrollBottom(el) {
  requestAnimationFrame(() => {
    try {
      el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    } catch (_) {}
  });
}

// ============ 复核框（信任闭环：确认后才落库）============
function renderReview(chatList, review, nextReply, onConfirmed) {
  const box = h('div', {
    class: 'card',
    style: { background: '#fdf6e8', borderLeft: '4px solid var(--color-ochre)' },
  });
  box.appendChild(h('div', { style: { fontWeight: '700', marginBottom: '4px', fontSize: '15px' } }, '我听到这些，对吗？'));
  box.appendChild(h('p', { class: 'muted', style: { fontSize: '13px', marginBottom: '12px' } },
    '核对一下，不对就改；确认后我才记进你的传记。'));

  const entries = [];
  review.forEach((item) => {
    const inp = h('input', {
      type: 'text', value: item.value || '',
      style: {
        flex: '1', minWidth: '0', height: '40px', padding: '0 12px', fontSize: '15px',
        border: '1px solid var(--color-beige)', borderRadius: '10px',
        background: '#fff', color: 'var(--color-deep-brown)',
      },
    });
    entries.push({ item, inp });
    box.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
      h('span', { style: { fontSize: '13px', minWidth: '92px', flexShrink: '0' } }, item.label),
      inp
    ));
  });

  const btnRow = h('div', { style: { display: 'flex', gap: '10px', marginTop: '10px' } });

  const confirmBtn = h('button', {
    class: 'btn-primary', style: { flex: '1', height: '44px', fontSize: '15px' },
  }, '✅ 都对，记下来');

  const resayBtn = h('button', {
    class: 'btn-secondary', style: { flex: '1', height: '44px', fontSize: '15px' },
  }, '🔄 我重新说');

  confirmBtn.onclick = async () => {
    const facts = buildFacts(entries);
    confirmBtn.disabled = true;
    try {
      const r = await API.patch('/interview/' + window.__cybioInterviewState.interviewId + '/review', { facts });
      box.remove();
      if (r && r.target) window.__cybioInterviewState.target = r.target;
      if (nextReply) addBubble(chatList, { role: 'assistant', text: nextReply }, true);
      if (onConfirmed) onConfirmed();
    } catch (e) {
      confirmBtn.disabled = false;
      toast('保存失败：' + e.message);
    }
  };

  resayBtn.onclick = () => {
    box.remove();
    addBubble(chatList, { role: 'assistant', text: '好，你重新说一遍，我重新记。' }, false);
    const wrap = h('div', { style: { marginBottom: '12px' } });
    const inp = h('input', {
      type: 'text', placeholder: '重新说一遍…',
      style: {
        width: '100%', boxSizing: 'border-box', height: '46px', padding: '0 14px', fontSize: '15px',
        border: '1px solid var(--color-beige)', borderRadius: '12px',
        background: '#fff', color: 'var(--color-deep-brown)',
      },
    });
    const okBtn = h('button', { class: 'btn-primary', style: { marginTop: '8px', height: '42px' } }, '重新记这段');
    wrap.appendChild(inp);
    wrap.appendChild(okBtn);
    chatList.appendChild(wrap);
    scrollBottom(chatList);
    inp.focus();
    const doResay = async () => {
      const t = (inp.value || '').trim();
      if (!t) return;
      okBtn.disabled = true;
      try {
        const r = await API.post('/interview/' + window.__cybioInterviewState.interviewId + '/resay', { text: t });
        wrap.remove();
        addBubble(chatList, { role: 'user', text: t });
        if (r.review && r.review.length) {
          renderReview(chatList, r.review, r.reply, onConfirmed);
        } else if (r.reply) {
          addBubble(chatList, { role: 'assistant', text: r.reply }, true);
          if (onConfirmed) onConfirmed();
        }
      } catch (e) {
        okBtn.disabled = false;
        toast('重说失败：' + e.message);
      }
    };
    okBtn.onclick = doResay;
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doResay(); }
    });
  };

  btnRow.appendChild(confirmBtn);
  btnRow.appendChild(resayBtn);
  box.appendChild(btnRow);
  chatList.appendChild(box);
  scrollBottom(chatList);
}

// 把复核框 {label,value,path} 重组为后端 applyReview 期望的 facts 结构
// 支持 person.name / relations[0].name / person.career[0].org / person.hobbies[1] 等路径
function buildFacts(entries) {
  const person = {};
  const relBag = { relations: [] };
  const profileBag = { profile: {} };
  const linkNames = [];

  const setPath = (root, path, value) => {
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (cur[k] === undefined || cur[k] === null) {
        cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  };

  for (const { item, inp } of entries) {
    const val = (inp.value || '').trim();
    if (!val) continue;
    const p = item.path || '';
    if (p.startsWith('relations[')) setPath(relBag, p, val);
    else if (p.startsWith('link_names[')) linkNames.push(val);
    else if (p.startsWith('profile.')) setPath(profileBag, p, val);
    else if (p.startsWith('person.')) setPath(person, p, val);
    else person[p] = val; // 兜底
  }

  const facts = { person };
  const rels = (relBag.relations || []).filter(Boolean).map((x) => x || {});
  if (rels.length) facts.relations = rels;
  if (linkNames.length) facts.link_names = linkNames;
  const prof = profileBag.profile || {};
  if (Object.keys(prof).length) facts.person.profile = prof;
  return facts;
}

// ============ 章节沉淀卡 ============
function renderChapter(chatList, ch) {
  const box = h('div', {
    class: 'card',
    style: { background: 'var(--color-pine-soft)', borderLeft: '4px solid var(--color-pine)', marginBottom: '12px' },
  },
    h('div', { class: 'flex items-center gap-2 mb-1' },
      h('span', { class: 'chapter-stage' }, ch.stage || '人生'),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, '已沉淀')
    ),
    h('div', { class: 'chapter-title' }, ch.title || ''),
    h('div', { class: 'chapter-summary' }, ch.summary || '')
  );
  chatList.appendChild(box);
  scrollBottom(chatList);
}

// ============ 图谱变化提示（家属网在生长）============
function refreshGraphBadge(r) {
  const n = (r.newNodes || []).length;
  const e = (r.newEdges || []).length;
  if (n > 0) {
    const names = r.newNodes.map((x) => x.name).filter(Boolean).slice(0, 4).join('、');
    toast('家属网 +' + n + ' 位：' + names);
  } else if (e > 0) {
    toast('关系网新增 ' + e + ' 条连线');
  }
}

// ============ 「按住说话」语音输入（MVP：服务端 ASR）============
// 设计要点（2026-09-13 重写，替代原先只支持原生 SpeechRecognition 的 setupMic）：
//   1. 微信 X5 **不支持** window.SpeechRecognition → 原实现在微信里直接把按钮隐藏了，
//      用户「按了没反应」正是这个原因。改为录音上传服务端 ASR，微信里也能用。
//   2. 采用「按住说话」交互（用户明确要求）：pointerdown 开始录，pointerup/leave/cancel 结束并识别。
//   3. 录音格式：优先 audio/webm（Chrome/微信）或 audio/mp4（iOS Safari），
//      经 decodeAudioData → 重采样为 **16k 单声道 PCM WAV**（后端 EngSerViceType=16k_zh 要求）。
//   4. 全程不做文字输入框，语音结果直接提交。
//
// ⚠️ 微信内 getUserMedia 需要 HTTS + 用户手势；首次会弹权限，被拒要给出明确指引。

const TALK_MIN_MS = 400;      // 短于此时长视为误触
const TALK_MAX_MS = 30000;    // 上限 30 秒，避免无限录制

function createTalkToText({ onHint, onLevel, onText, setRecording, beforeStart }) {
  const btn = document.getElementById('talk-btn');
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
    (window.MediaRecorder || window.webkitMediaRecorder));

  let enabled = true;
  let recording = false;
  let starting = false;
  let chunks = [];
  let recorder = null;
  let stream = null;
  let startedAt = 0;
  let autoStop = null;
  let cancelled = false;

  function pickMime() {
    const cands = [
      'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg',
    ];
    const MR = window.MediaRecorder || window.webkitMediaRecorder;
    if (!MR || !MR.isTypeSupported) return '';
    for (const c of cands) { try { if (MR.isTypeSupported(c)) return c; } catch (_) {} }
    return '';
  }

  function releaseStream() {
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} stream = null; }
  }

  function reset() {
    recording = false;
    starting = false;
    if (autoStop) { clearTimeout(autoStop); autoStop = null; }
    recorder = null;
    chunks = [];
    releaseStream();
    setRecording(false);
    if (btn) btn.style.transform = 'scale(1)';
  }

  async function start() {
    if (!enabled || recording || starting) return;
    if (!supported) {
      onHint('这个浏览器不支持录音，请用 微信/Chrome/Safari 打开', '#c0392b');
      return;
    }
    starting = true;
    cancelled = false;
    if (beforeStart) { try { await beforeStart(); } catch (_) {} }

    let ms = null;
    try {
      ms = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
    } catch (e) {
      starting = false;
      const n = (e && e.name) || '';
      if (n === 'NotAllowedError' || n === 'SecurityError') {
        onHint('麦克风被拒绝：请在浏览器/微信设置里允许麦克风权限', '#c0392b');
      } else if (n === 'NotFoundError') {
        onHint('没找到麦克风设备', '#c0392b');
      } else {
        onHint('无法启动录音：' + (e.message || n), '#c0392b');
      }
      return;
    }

    stream = ms;
    const MR = window.MediaRecorder || window.webkitMediaRecorder;
    const mime = pickMime();
    try {
      recorder = mime ? new MR(ms, { mimeType: mime }) : new MR(ms);
    } catch (_) {
      try { recorder = new MR(ms); } catch (e2) {
        reset();
        onHint('录音器初始化失败', '#c0392b');
        return;
      }
    }
    chunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => { finish(); };
    try { recorder.start(); } catch (e) {
      reset();
      onHint('录音启动失败：' + (e.message || e), '#c0392b');
      return;
    }
    recording = true;
    starting = false;
    startedAt = Date.now();
    setRecording(true);
    onLevel(true);
    onHint('正在录音… 松开发送');
    autoStop = setTimeout(() => { if (recording) stop(); }, TALK_MAX_MS);
  }

  function stop() {
    if (!recording || !recorder) { reset(); return; }
    recording = false;
    if (autoStop) { clearTimeout(autoStop); autoStop = null; }
    onLevel(false);
    setRecording(false);
    try { recorder.stop(); } catch (_) { finish(); }
  }

  async function finish() {
    const dur = Date.now() - startedAt;
    const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || 'audio/webm' });
    reset();
    if (cancelled) { return; }
    if (dur < TALK_MIN_MS || blob.size < 1200) {
      onHint('太短了，按住多说一会儿');
      return;
    }
    onHint('识别中…');
    try {
      const wav = await toWav16k(blob);
      // interview_id 传给后端：录音要归属到这场访谈（前端在 createTalkToText 时注入）
      const ivId = (typeof window !== 'undefined' && window.__cybioInterviewId) || '';
      const asrUrl = '/api/asr' + (ivId ? '?interview_id=' + encodeURIComponent(ivId) : '');
      const res = await fetch(asrUrl, {
        method: 'POST', headers: API.asrHeaders(), body: wav,
      });
      const txt = await res.text();
      let data = {};
      try { data = txt ? JSON.parse(txt) : {}; } catch (_) { data = { _raw: txt }; }
      if (!res.ok) {
        onHint('识别失败：' + (data.error || ('HTTP ' + res.status)), '#c0392b');
        return;
      }
      onHint('按住说话，松开就发出');
      // 原音追溯（2026-10-04）：把 ASR 返回的 audio_id 一并回传，
      // 调用方随消息提交给后端，把这段真人原声关联到这条原话上。
      await onText(data.text || '', data.audio_id || null);
    } catch (e) {
      onHint('识别出错：' + (e.message || e), '#c0392b');
    }
  }

  // ---- 事件绑定：pointer 事件统一处理触摸/鼠标；另用 touchcancel 兜底 ----
  const onDown = (e) => { e.preventDefault(); start(); };
  const onUp = (e) => { if (e) e.preventDefault(); if (recording) stop(); else reset(); };
  const onCancel = () => { cancelled = true; stop(); };

  if (btn) {
    btn.addEventListener('pointerdown', onDown);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onCancel);
    btn.addEventListener('pointerleave', (e) => { if (recording) stop(); });
    // 触摸兜底（部分 X5 版本 pointer 事件不全）
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); if (recording) stop(); }, { passive: false });
    btn.addEventListener('touchcancel', onCancel);
    // 屏蔽长按弹出的系统菜单/选中
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  if (!supported) {
    onHint('这个浏览器不支持录音，请用 微信/Chrome/Safari 打开', '#c0392b');
  }

  return {
    setEnabled(v) {
      enabled = !!v;
      if (btn) {
        btn.style.opacity = enabled ? '1' : '.5';
        btn.style.pointerEvents = enabled ? 'auto' : 'none';
      }
      if (!enabled) onHint('AI 正在说话…');
      else onHint('按住说话，松开就发出');
    },
    destroy() {
      cancelled = true;
      try { if (recorder && recording) recorder.stop(); } catch (_) {}
      reset();
      if (btn) {
        btn.removeEventListener('pointerdown', onDown);
        btn.removeEventListener('pointerup', onUp);
      }
    },
  };
}

// 任意音频 Blob → 16kHz 单声道 16bit PCM WAV（腾讯云 ASR 16k_zh 要求）
async function toWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const buf = await blob.arrayBuffer();
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    if (ctx.close) ctx.close();
  }
  const targetRate = 16000;
  const srcRate = decoded.sampleRate;

  // 多声道混为单声道
  const chCount = decoded.numberOfChannels;
  const srcLen = decoded.length;
  let mono;
  if (chCount === 1) {
    mono = decoded.getChannelData(0);
  } else {
    mono = new Float32Array(srcLen);
    for (let c = 0; c < chCount; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < srcLen; i++) mono[i] += d[i] / chCount;
    }
  }

  // 线性重采样到 16k
  const ratio = srcRate / targetRate;
  const outLen = Math.max(1, Math.floor(srcLen / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, srcLen - 1);
    const frac = pos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }

  // 编码为 WAV
  const dataBytes = outLen * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);          // PCM
  dv.setUint16(22, 1, true);          // 单声道
  dv.setUint32(24, targetRate, true);
  dv.setUint32(28, targetRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < outLen; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, out[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}
