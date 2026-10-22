// خدمة بسيطة: الشبكة أولاً دائماً (فلا تبقى نسخة قديمة من الواجهة)، والنسخة المخزّنة تُستعمل عند انقطاع الاتصال فقط.
// طلبات الـ API والملفات المرفوعة لا تُخزَّن أبداً.
const CACHE = 'mathani-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range')) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads') || url.pathname === '/dev-login') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = (await caches.match(req)) || (req.mode === 'navigate' ? await caches.match('/') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
