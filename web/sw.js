// 赛博传记 — 轻量 Service Worker（PWA 壳缓存）
// 目的：让"添加到主屏幕"后是正统独立 App 体验（有启动屏、无浏览器地址栏），
// 并缓存壳资源使其可离线打开。API 动态数据始终走网络，不缓存（保证传记内容实时）。
const CACHE = 'cybio-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/auth.html',
  '/css/styles.css',
  '/js/store.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // 写请求（POST 等）一律走网络
  const url = new URL(req.url);

  // API / 上传：始终网络优先（实时数据）
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return;
  }

  // 壳资源：network-first（保证「强制刷新」能拉到新版本 JS/CSS，PWA 不会卡在旧缓存；
  // 仅在彻底离线时回退到缓存壳，保证 App 还能打开）。
  e.respondWith(
    fetch(req).then((res) => {
      // 仅缓存同源 GET 的静态壳资源
      if (res && res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
