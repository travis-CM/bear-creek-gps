// Network-first for the app and data (so updates show up), cache fallback for flaky course signal.
// Map tiles: cache-first (already-viewed holes still render with no signal).
const V = 'bcgps-v7';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(V).then(c => c.addAll(['./', 'index.html', 'app.js', 'course.json', 'dem.bin', 'manifest.json', 'icon.svg', 'logo.svg']).catch(() => {}))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'server.arcgisonline.com' || u.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(V).then(async c => { const hit = await c.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }));
    return;
  }
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request, {cache: 'no-store'}).then(r => { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  }
});
