// web/js/store.js — 客户端全局状态：登录令牌 / 当前用户 / 本人 person 节点（localStorage 持久化）
// 全局关系图模型（2026-08-23 重构）：不再有"当前家族 tree"，以本人 person 节点为根。
(function () {
  const KEY = 'cyberbio_state_v2';

  const Store = {
    token: null,
    user: null,        // { id, identifier, real_name, nickname, id_type }
    selfId: null,      // 本人 person 节点 id（大树根）
    currentTree: null, // 兼容性占位（全局图模型已无「当前家族」概念），供遗留页面调用 setTree 不报错
    _ready: false,

    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const s = JSON.parse(raw);
          this.token = s.token || null;
          this.user = s.user || null;
          this.selfId = s.selfId || null;
          this.currentTree = s.currentTree || null;
        }
      } catch (_) { /* ignore */ }
      this._ready = true;
      return this;
    },

    _persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify({
          token: this.token, user: this.user, selfId: this.selfId, currentTree: this.currentTree,
        }));
      } catch (_) { /* ignore */ }
    },

    // 兼容性方法：全局图模型下不再使用树，仅保留以免遗留页面调用时崩溃
    setTree(tree) { this.currentTree = tree || null; this._persist(); },

    setAuth(token, user) {
      this.token = token;
      this.user = user;
      this._persist();
    },

    setSelf(person) {
      this.selfId = person ? person.id : null;
      this._persist();
    },

    logout() {
      this.token = null;
      this.user = null;
      this.selfId = null;
      this._persist();
    },

    isAuthed() {
      return !!this.token;
    },

    // 便捷取本人 person id
    get self() {
      return this.selfId;
    },
  };

  window.Store = Store;
})();
