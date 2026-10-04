// web/js/pages/person-edit.js — 人物资料编辑弹层（由 lifebook.js 的「✏️ 编辑资料」调用）
//
// 设计要点：
//  • 「姓名」同时写两个字段（展示名 name + 权威真名 real_name），避免此前两者不一致导致"界面显示假名"。
//  • 已认领的节点（claimed_by_user_id 非空）默认锁定姓名——本人真名以注册名为准；
//    需点「修改」显式解锁，防止误改他人身份。
//  • 弹层用静态 DOM + 事件委托，不用动态 type=password（本项目微信 X5 内核铁律）。
//  • 注意：本文件顶层的变量/函数名是全局的（非 module），新增顶层声明前先查与其他文件是否重名，
//    重名会 SyntaxError 导致整站白屏。
window.Pages = window.Pages || {};

const EDIT_FIELDS = [
  ['gender', '性别', 'text'],
  ['birth_date', '出生', 'text'],
  ['death_date', '逝世', 'text'],
  ['birthplace', '籍贯', 'text'],
  ['residence', '居住地', 'text'],
  ['occupation', '职业', 'text'],
  ['education', '学历', 'text'],
  ['spouse_name', '配偶', 'text'],
  ['ethnicity', '民族', 'text'],
  ['bio', '一句话简介', 'textarea'],
];

// 编辑框初值取值：
//  • 配偶/民族在库里不是独立列，存在 profile_json（profile.spouse / profile.ethnicity），
//    后端 updatePerson 也按这个别名回写 —— 两边必须一致，否则会出现"填了打不开、改了不落库"。
//  • 其余字段直接用 persons 表的同名列（后端 INFO_COLS 已保证"能写就能读"）。
function editInitialValue(p, key) {
  const profile = (p && p.profile) || {};
  if (key === 'spouse_name') return p.spouse_name || profile.spouse || '';
  if (key === 'ethnicity') return p.ethnicity || profile.ethnicity || '';
  const v = p ? p[key] : '';
  return v == null ? '' : v;
}

function closeModal() {
  const el = document.getElementById('person-edit-modal');
  if (el) el.remove();
}

function fieldRow(key, label, value, disabled, type) {
  const wrap = document.createElement('label');
  wrap.className = 'pe-row';
  const lb = document.createElement('span');
  lb.className = 'pe-label';
  lb.textContent = label;
  let inp;
  if (type === 'textarea') {
    inp = document.createElement('textarea');
    inp.className = 'pe-input';
    inp.rows = 3;
    inp.value = value || '';
  } else {
    inp = document.createElement('input');
    inp.className = 'pe-input';
    inp.type = 'text';
    inp.value = value || '';
  }
  inp.dataset.key = key;
  inp.disabled = !!disabled;
  wrap.appendChild(lb);
  wrap.appendChild(inp);
  return wrap;
}

/**
 * 打开人物编辑弹层
 * @param {object} p     person 对象（来自 GET /persons/:id）
 * @param {string} selfName 当前登录用户真实姓名（用于展示"以本人注册名为准"提示）
 * @param {function} onSaved 保存成功回调（用于重新渲染页面）
 */
window.openPersonEditor = function (p, selfName, onSaved) {
  closeModal();
  const claimed = !!p.claimed_by_user_id; // 已被认领 → 姓名默认锁定
  const nameValue = p.real_name || p.name || '';

  const mask = document.createElement('div');
  mask.id = 'person-edit-modal';
  mask.className = 'pe-mask';
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });

  const box = document.createElement('div');
  box.className = 'pe-box';

  const title = document.createElement('h3');
  title.className = 'pe-title';
  title.textContent = '编辑资料';
  box.appendChild(title);

  // —— 姓名区（双字段联动）——
  const nameWrap = document.createElement('label');
  nameWrap.className = 'pe-row';
  const nameLb = document.createElement('span');
  nameLb.className = 'pe-label';
  nameLb.textContent = '姓名';
  nameWrap.appendChild(nameLb);
  const nameInp = document.createElement('input');
  nameInp.className = 'pe-input';
  nameInp.id = 'pe-name';
  nameInp.value = nameValue;
  nameInp.disabled = claimed;
  nameWrap.appendChild(nameInp);
  box.appendChild(nameWrap);

  if (claimed) {
    const tip = document.createElement('div');
    tip.className = 'pe-tip';
    tip.innerHTML = '该节点已由本人认领，姓名以注册真名「' + nameValue + '」为准。'
      + '确需更正请点 <b>修改姓名</b>。';
    box.appendChild(tip);
    const unlockBtn = document.createElement('button');
    unlockBtn.type = 'button';
    unlockBtn.className = 'btn-soft';
    unlockBtn.textContent = '✏️ 修改姓名';
    unlockBtn.addEventListener('click', () => {
      nameInp.disabled = false;
      nameInp.focus();
      unlockBtn.remove();
      tip.remove();
    });
    box.appendChild(unlockBtn);
  }

  // —— 其余字段 ——
  EDIT_FIELDS.forEach(([k, lbl, type]) => box.appendChild(fieldRow(k, lbl, editInitialValue(p, k), false, type)));

  // —— 操作区 ——
  const ops = document.createElement('div');
  ops.className = 'pe-ops';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-soft';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-primary';
  save.textContent = '保存';
  ops.appendChild(cancel);
  ops.appendChild(save);
  box.appendChild(ops);

  // 原始值快照：只提交真正改过的字段；一个都没改时明确告知，
  // 避免"点了保存、弹层关了、页面没变化"这种让人以为保存失败的空操作。
  const originals = { __name: nameInp.value.trim() };
  box.querySelectorAll('.pe-input').forEach((inp) => {
    if (inp.dataset.key) originals[inp.dataset.key] = inp.value.trim();
  });

  save.addEventListener('click', async () => {
    const body = {};
    box.querySelectorAll('.pe-input').forEach((inp) => {
      if (inp.disabled) return;
      const k = inp.dataset.key;
      if (!k) return;
      const v = inp.value.trim();
      if (v !== originals[k]) body[k] = v;
    });
    // 姓名同时写 name + real_name，保持两者一致
    if (!nameInp.disabled) {
      const nm = nameInp.value.trim();
      if (nm && nm !== originals.__name) { body.name = nm; body.real_name = nm; }
    }
    if (!Object.keys(body).length) {
      toast('没有需要保存的改动');
      return;
    }
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      await API.post('/persons/' + p.id, body);
      closeModal();
      toast('✅ 已保存');
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      alert('保存失败：' + e.message);
      save.disabled = false;
      save.textContent = '保存';
    }
  });

  mask.appendChild(box);
  document.body.appendChild(mask);
};
