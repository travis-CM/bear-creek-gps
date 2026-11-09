// App files + course data: network first, but fall back to the saved copy after 4 s (weak signal on the course).
// Map tiles are cached by the app itself (Cache API); this also keeps a cache-first copy for plain image requests.
const V = 'bcgps-v16';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(V).then(c => c.addAll(['./', 'index.html', 'app.js', 'course.json', 'dem.bin', 'manifest.json', 'icon.svg', 'logo.svg']).catch(() => {}))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^bcgps-v/.test(k) && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'server.arcgisonline.com' || u.hostname === 'cdnjs.cloudflare.com' || u.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(V).then(async c => { const hit = await c.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }));
    return;
  }
  if (u.origin === location.origin) {
    const net = fetch(e.request, {cache: 'no-store'}).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); } return r; });
    const saved = () => caches.match(e.request, {ignoreSearch: true}).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    e.respondWith(Promise.race([net, new Promise((_, rej) => setTimeout(rej, 4000))]).catch(saved));
  }
});
