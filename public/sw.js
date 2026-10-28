/* Kalai app (installed on a phone or computer): the newest version always comes from the network first, so a deploy
   shows at once; pages, pictures and built files already seen are kept as a fallback when the phone is offline.
   Calls to AWS / Ziina / WhatsApp (other sites) are never touched. */
const CACHE = 'kalai-app-v1';
const KEEP = ['/app/offline.html', '/app/shop-192.png'];
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(KEEP)).catch(() => {})); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  const keep = r.mode === 'navigate' || /^\/(assets|img|fonts|app|data)\//.test(u.pathname);
  e.respondWith(fetch(r).then((res) => {
    if (keep && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)).catch(() => {}); }
    return res;
  }).catch(async () => (await caches.match(r, { ignoreSearch: r.mode === 'navigate' })) || (r.mode === 'navigate' ? caches.match('/app/offline.html') : Response.error())));
});
