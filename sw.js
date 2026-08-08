/* 提肛陪伴 — Service Worker(离线优先,零依赖) */

const CACHE_NAME = 'tigang-v19';

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync/client.mjs',
  './sync/coordinator.mjs',
  './core/engine.js',
  './core/stats.js',
  './core/storage.js',
  './core/achievements.js',
  './core/sync.js',
  './manifest.webmanifest',
  './sw.js',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

/*
 * 注意这里**故意不调** skipWaiting:新版本装好后停在 waiting,由页面上的
 * 「有新版本 · 更新」提示按钮 postMessage 过来才接管(见下面的 message 监听)。
 *
 * 为什么不能无条件 skipWaiting(v18 及之前就是这么写的,是个错):
 * 新 SW 立刻 activate 并删掉旧缓存,但已打开的页面还在跑内存里的旧 app.js。
 * 旧代码此后去取任何没缓存过的资源,拿到的都是新版本的文件 —— 版本被劈成两半。
 * 而且用户完全不知道该刷新,老版本能挂好几天(v18 的进度环和主密码下限就是这样卡住的)。
 * 现在的次序反过来:先告诉用户,用户点了才切,切完立刻 reload,页面与资产始终同版本。
 */
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

/** 页面点了「更新」才走到这里:接管 → 触发 controllerchange → 页面自己 reload。 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(cacheFirst(request));
});

/** cache-first,未命中回退网络并写回缓存;断网时导航请求回退到首页。 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}
