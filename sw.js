// App files + course data: network first, but fall back to the saved copy after 4 s (weak signal on the course).
// Map tiles are cached by the app itself (Cache API 'bcgps-tiles'), so the worker leaves them alone.
// Bump V whenever the precache list changes; every online load also refreshes the saved copies.
const V = 'bcgps-v17';
const LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
              'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
              'https://cdn.jsdelivr.net/npm/leaflet-rotate@0.2.8/dist/leaflet-rotate.js'];
const CORE = ['./', 'index.html', 'app.js', 'course.json', 'dem.bin', 'dem_tcc.bin', 'manifest.json', 'icon-180.png', 'logo-golfhub.png'];
const key = u => { const x = new URL(u, location.href); return x.origin === location.origin ? x.origin + x.pathname : x.href; }; // ignore ?v= / ?native=1
self.addEventListener('install', e => {
  self.skipWaiting();
  // one file failing must not leave the whole offline copy empty
  e.waitUntil(caches.open(V).then(c => Promise.allSettled(CORE.concat(LIBS).map(u =>
    fetch(u, {cache: 'reload'}).then(r => { if (r.ok) return c.put(key(r.url || u), r); })))));
});
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^bcgps-v/.test(k) && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.hostname === 'cdnjs.cloudflare.com' || u.hostname === 'cdn.jsdelivr.net') { // pinned library versions: cache first
    e.respondWith(caches.open(V).then(async c => { const hit = await c.match(key(req.url)); if (hit) return hit;
      const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(key(req.url), r.clone()); return r; }));
    return;
  }
  if (u.origin !== location.origin) return;
  const k = req.mode === 'navigate' ? key('index.html') : key(req.url);
  e.respondWith(caches.open(V).then(async c => {
    const saved = await c.match(k);
    const net = fetch(req, {cache: 'no-store'}).then(r => { if (r.ok) c.put(k, r.clone()); return r; });
    if (!saved) return net; // nothing saved yet: wait for the network however slow it is
    return Promise.race([net, new Promise((_, rej) => setTimeout(rej, 4000))]).catch(() => saved);
  }));
});
