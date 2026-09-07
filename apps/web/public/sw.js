/* 保守版 Service Worker:
   - 只缓存 /assets/*(构建产物带内容哈希,不可变);
   - 页面/导航走网络优先(保证更新即时生效);
   - 一律不碰 /api(日记数据始终走网络,且本来就在本机);
   仅在安全上下文(https / localhost)下才会被注册。 */
const CACHE = 'diary-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 带哈希的静态资源:缓存优先(离线可用)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // 其余(页面、manifest、图标等):网络优先,成功后顺手缓存
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const fallback = await cache.match(req);
        if (fallback) return fallback;
        throw new Error('offline');
      }
    }),
  );
});
