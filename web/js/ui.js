// web/js/ui.js — 共享 UI 工具：DOM 创建、Toast、模态框、加载
function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  attrs = attrs || {};
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value') e.value = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}
window.h = h;

function toast(msg) {
  const layer = document.getElementById('toast-layer');
  const t = h('div', { class: 'toast' }, msg);
  layer.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 1800);
  setTimeout(() => t.remove(), 2200);
}
window.toast = toast;

function loading(text) {
  return h('div', { class: 'loading' }, text || '加载中…');
}
window.loading = loading;

// 简单模态框：content 为 DOM 节点；返回 close 函数
function modal(title, contentNode, opts) {
  opts = opts || {};
  const layer = document.getElementById('modal-layer');
  const mask = h('div', { class: 'modal-mask' });
  const closeBtn = h('button', { class: 'modal-close', onclick: () => close() }, '×');
  const box = h('div', { class: 'modal' }, h('h3', {}, title), closeBtn, contentNode);
  mask.appendChild(box);
  function close() { mask.remove(); }
  mask.addEventListener('click', (e) => { if (e.target === mask && !opts.noBackdropClose) close(); });
  layer.appendChild(mask);
  return close;
}
window.modal = modal;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.escapeHtml = escapeHtml;

function statusBadge(status) {
  if (status === 'pending_claim') return h('span', { class: 'badge stub' }, '待加入');
  if (status === 'stub') return h('span', { class: 'badge stub' }, '待本人自述');
  if (status === 'active') return h('span', { class: 'badge active' }, '已采编');
  return h('span', { class: 'badge dim' }, status || '');
}
window.statusBadge = statusBadge;

// 「等待加入/待认领」判定：pending_claim=访谈中他人提及的亲属（等本人注册后自动联系）
// stub=手动补录的骨架节点（待本人自述）。二者前端统一按灰态呈现。
function isWaitingClaim(status) {
  return status === 'pending_claim' || status === 'stub';
}
window.isWaitingClaim = isWaitingClaim;

function initials(name) {
  if (!name) return '?';
  return name.length <= 2 ? name : name.slice(-2);
}
window.initials = initials;
