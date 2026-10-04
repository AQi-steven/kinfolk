// web/js/api.js — 统一 fetch 封装（同源，注入 Authorization，401 自动清登录态）
window.Pages = window.Pages || {};

const API = {
  async req(method, path, body, { raw = false } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }
    if (window.Store && window.Store.token) {
      opts.headers['Authorization'] = 'Bearer ' + window.Store.token;
    }
    const res = await fetch('/api' + path, opts);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { _raw: text }; }
    if (!res.ok) {
      if (res.status === 401 && window.Store) {
        window.Store.logout();
        if (location.hash.indexOf('#/login') !== 0 && location.hash.indexOf('#/claim') !== 0) {
          location.hash = '#/login';
        }
      }
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    return data;
  },
  get(p, opts) { return this.req('GET', p, undefined, opts); },
  post(p, b, opts) { return this.req('POST', p, b, opts); },
  patch(p, b, opts) { return this.req('PATCH', p, b, opts); },
  del(p, opts) { return this.req('DELETE', p, undefined, opts); },
  // 语音识别（ASR）是裸二进制上传，不走 req() 的 JSON 封装，这里单独带鉴权头
  asrHeaders() {
    const h = { 'Content-Type': 'application/octet-stream' };
    if (window.Store && window.Store.token) h['Authorization'] = 'Bearer ' + window.Store.token;
    return h;
  },
  // 取原始文本（成书 HTML 这类非 JSON 响应）。
  // 不能复用 req()：它无条件 JSON.parse，遇到 <!DOCTYPE html> 会把全文塞进 _raw，逻辑变脆。
  // 这里返回 Response 本身，由调用方决定 .text() 还是 .blob()。
  async raw(path) {
    const headers = {};
    if (window.Store && window.Store.token) headers['Authorization'] = 'Bearer ' + window.Store.token;
    const res = await fetch('/api' + path, { method: 'GET', headers });
    if (!res.ok) {
      if (res.status === 401 && window.Store) window.Store.logout();
      let msg = 'HTTP ' + res.status;
      try { const t = await res.text(); const j = JSON.parse(t); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return res;
  },
};
window.API = API;
