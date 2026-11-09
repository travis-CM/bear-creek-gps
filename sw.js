// App files + course data: network first, but fall back to the saved copy after 4 s (weak signal on the course).
// Map tiles are cached by the app itself (bcgps-tiles, Cache API); the service worker leaves them alone so they are not stored twice.
const V = 'bcgps-v18';
const PRECACHE = ['./', 'index.html', 'app.js', 'sw.js', 'course.json', 'dem.bin', 'dem_tcc.bin', 'manifest.json', 'icon.svg', 'icon-180.png', 'logo-golfhub.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js'];
// one add per file: a single missing file must not empty the whole offline cache (addAll is all-or-nothing)
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(V).then(c => Promise.all(PRECACHE.map(f => c.add(f).catch(() => {}))))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^bcgps-v/.test(k) && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const key = u.origin + u.pathname; // one cache entry per file, whatever the ?v= / ?u= query
  const net = fetch(e.request, {cache: 'no-store'}).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(key, cp)); } return r; });
  // slow or offline: the saved copy; nothing saved yet: keep waiting for the network instead of failing
  const saved = () => caches.match(key).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html').then(x => x || net) : net));
  e.respondWith(Promise.race([net, new Promise((_, rej) => setTimeout(rej, 4000))]).catch(saved));
});
