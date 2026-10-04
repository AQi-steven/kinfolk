// web/js/pages/verify.js — 同名三问题核实（阶段3）
// ⚙️菜单「🔗同名核实」入口；列出与我相关的 pending 提案，点开作答 4 选 1，双方答完触发判定。
window.Pages = window.Pages || {};
window.Pages.verify = async function (main) {
  main.appendChild(h('div', { class: 'page-title' }, '🔗 同名核实'));
  main.appendChild(h('p', { class: 'page-hint' }, '系统发现与你家族中某人「同名且同关系角色」的候选节点，需要你确认是否为同一人。双方各答 3 题（关系性事实），全对则自动合并两棵子树。'));

  let list;
  try {
    list = await API.get('/merge/proposals');
  } catch (e) {
    main.appendChild(h('div', { class: 'error' }, '加载失败：' + e.message));
    return;
  }
  const proposals = list.proposals || [];
  if (!proposals.length) {
    main.appendChild(h('div', { class: 'empty-card' }, '🎉 暂无待核实的同名候选。'));
    return;
  }

  for (const p of proposals) {
    const card = h('div', { class: 'verify-card' }, [
      h('div', { class: 'vc-head' }, `疑似同一人：${p.name_a} ⇔ ${p.name_b}`),
      h('div', { class: 'vc-sub' }, `提案 #${p.id} · ${p.created_at}`),
    ]);
    const btn = h('button', { class: 'btn-primary' }, '去核实');
    btn.onclick = () => openVerify(main, p.id);
    card.appendChild(btn);
    main.appendChild(card);
  }
};

async function openVerify(main, pid) {
  main.innerHTML = '';
  main.appendChild(h('div', { class: 'page-title' }, '🔗 同名核实'));
  const back = h('button', { class: 'btn-text-back' }, '← 回列表');
  back.onclick = () => window.Pages.verify(main);
  main.appendChild(back);

  let detail;
  try {
    detail = await API.get(`/merge/proposals/${pid}`);
  } catch (e) {
    main.appendChild(h('div', { class: 'error' }, '加载失败：' + e.message));
    return;
  }
  const { myQuestions, alreadyAnswered, name_a, name_b, mySide } = detail;
  main.appendChild(h('p', { class: 'page-hint' }, `候选：${name_a} ⇔ ${name_b}。请回答关于「${mySide === 'a' ? name_a : name_b}」的 3 个问题（熟人才知道的关系事实）。`));

  if (alreadyAnswered) {
    main.appendChild(h('div', { class: 'warn-card' }, '你已作答，等待对方完成。双方都答完后系统会自动判定合并。'));
    return;
  }

  const picked = new Array(myQuestions.length).fill(null);
  const form = h('div', { class: 'record-form' });
  myQuestions.forEach((q, qi) => {
    const qWrap = h('div', { class: 'lb-field' }, [h('label', {}, `${qi + 1}. ${q.q}`)]);
    const opts = h('div', { class: 'opt-group' });
    q.options.forEach((opt, oi) => {
      const ob = h('button', { class: 'opt-btn' }, opt);
      ob.onclick = () => {
        picked[qi] = oi;
        opts.querySelectorAll('.opt-btn').forEach((b) => b.classList.remove('selected'));
        ob.classList.add('selected');
      };
      opts.appendChild(ob);
    });
    qWrap.appendChild(opts);
    form.appendChild(qWrap);
  });
  main.appendChild(form);

  const submit = h('button', { class: 'btn-primary' }, '提交作答');
  submit.onclick = async () => {
    if (picked.some((x) => x === null)) { toast('请完成所有题目'); return; }
    submit.disabled = true;
    submit.textContent = '提交中…';
    try {
      const r = await API.post(`/merge/proposals/${pid}/answer`, { answers: picked });
      toast(`答对 ${r.correct}/${r.total} 题`);
      // 触发判定（若双方都已答）
      try {
        const j = await API.post(`/merge/proposals/${pid}/judge`, {});
        if (j.merged) {
          toast(`✅ 已确认为同一人，两棵子树合并完成`);
        } else if (j.merged === false) {
          toast(`❌ 答案不符，判定为不同人，各自独立`);
        }
      } catch (_) { /* 对方未答，等待 */ }
      if (window.refreshVerifyBadge) window.refreshVerifyBadge();
      setTimeout(() => window.Pages.verify(main), 1200);
    } catch (e) {
      main.appendChild(h('div', { class: 'error' }, '提交失败：' + e.message));
    } finally {
      submit.disabled = false;
      submit.textContent = '提交作答';
    }
  };
  main.appendChild(submit);
}
