/* Bear Creek GPS — personal golf GPS + scramble scorer */
'use strict';
const $ = s => document.querySelector(s);
const YD = 1.09361;
const LS_KEY = 'bcgps_round_v1', LS_PHOTO = 'bcgps_photo_v1', LS_PREF = 'bcgps_pref_v1';
const TEES = ['Black', 'Blue', 'Silver', 'Red']; // fallback only: courses carry their own tee list (course.json `tees`)
const TEE_COL = {Black: '#111', Blue: '#2f6bff', Silver: '#c8c8c8', Red: '#e33', Copper: '#b87333', White: '#f2f2f2', Gold: '#d4af37', Junior: '#6fbf73'};
const BC_CLUB = {name: 'Bear Creek Golf Club', short: 'Bear Creek', place: 'DFW Airport, TX', addr: '3500 Bear Creek Ct, DFW Airport, TX', phone: '972-456-3200', courses: ['West', 'East']}; // fallback if course.json has no clubs
const CLUB_LINKS = {bc: {site: 'https://arcisgolf.com/clubs/bear-creek-golf-club/golf-course', tee: 'https://bearcreektxpp.ezlinksgolf.com/index.html#/preSearch'}}; // club web links (only where known)
const PACE_MIN = {3: 12, 4: 14, 5: 17}; // target minutes per hole (~4h12m)

let C = null;            // course data
let S = null;            // round state (persisted)
let tab = 'hole';
let viewHole = 1;        // hole being viewed
let tapMode = 'target';
let target = null;       // tapped target [lat,lon]
let gps = null;          // {p:[lat,lon], acc, ts}
let gpsErr = '';
let manualMe = null;
let wx = null, wxTs = 0, wxErr = '';
let map = null, layers = null, mapHole = null;
let wakeLock = null;
// saved prefs from an older version may lack newer fields (start, players): merge over the defaults, never replace them
let pref = Object.assign({course: 'West', tee: 'Blue', mode: 'scramble', players: ['Travis', '', '', ''], start: 1}, load(LS_PREF) || {});
if (!Array.isArray(pref.players) || pref.players.length < 4) pref.players = ['Travis', '', '', ''];
if (!(pref.start >= 1 && pref.start <= 18)) pref.start = 1;

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
const LS_ROUNDS = 'bcgps_rounds_v1';
function rawRounds() { const r = load(LS_ROUNDS); return r && typeof r === 'object' ? r : {}; } // everything in storage, untouched
function rounds() { // saved rounds that can be shown: broken entries or rounds on a course missing from today's data are skipped on screen, never deleted from storage
  const r = rawRounds(), out = {};
  for (const k in r) { const x = r[k]; if (!x || !Array.isArray(x.order) || !x.holes || (C && C.courses && !C.courses[x.course])) continue; x.id = x.id || k; out[k] = x; }
  return out;
}
let saveErr = false, bootErr = ''; // saveErr: localStorage refuses writes (full); bootErr: the saved round could not be opened. Both show as banners
function save() { // called after every change (incl. each keystroke in name fields)
  if (!S || S.preview) return;
  try {
    S.updated = Date.now();
    const r = rawRounds(); r[S.id] = S; // write back the whole store, so a round hidden by a stale course.json is not lost
    localStorage.setItem(LS_ROUNDS, JSON.stringify(r));
    localStorage.setItem(LS_KEY, S.id);
    saveErr = false;
  } catch (e) { saveErr = true; }
}
function defaultName() { const d = new Date(); return `${pref.mode === 'scramble' ? 'Scramble' : 'Round'} · ${pref.course} · ${d.toLocaleDateString([], {month: 'short', day: 'numeric'})}`; }
function resumeRound(id) { const r = rounds()[id]; if (!r) return; S = r; fixTee(S); loadDEM(); viewHole = S.cur; tab = S.ended ? 'card' : 'hole'; save(); requestWake(); render(); fitHole(true); loadWx(true); }
function deleteRound(id) { const r = rawRounds(); if (!r[id] || !confirm(`Delete "${r[id].name}" permanently?`)) return; delete r[id]; try { localStorage.setItem(LS_ROUNDS, JSON.stringify(r)); } catch (e) {} if (S && S.id === id) S = null; render(); }
function reopenRound() { if (!S || !S.ended) return; S.ended = null; tab = 'hole'; viewHole = S.cur; save(); requestWake(); render(); fitHole(true); } // finished too early (mis-tap, scored 18 before playing it)
function relOf(st, par) { // ± vs par for one hole; the single rule used by the hole screen, scorecard, totals, stats and the saved-round list
  if (!st) return null;
  const c = st.shots.filter(s => !s.g || s.g.counts).length;
  if (st.manual && st.adj != null) return st.adj;      // ± override wins until shots change
  if (c) return c - par;                               // live from logged strokes
  if (st.adj != null) return st.adj;                   // ± used with no shots logged
  return st.done ? 0 : null;
}
function roundSummary(r) { let rr = 0, thru = 0; (r.order || []).forEach(n => { const st = r.holes[n]; if (!st) return; const v = relOf(st, C.courses[r.course].holes[n - 1].par); if (v != null && (st.done || st.manual)) { rr += v; thru++; } }); return {rr, thru}; }
function photoKey() { const k = clubOf(course()); return k === 'bc' ? LS_PHOTO : LS_PHOTO + '_' + k; } // pin-sheet photo per club
function closeRings() { // bunkers and ponds arrive as rings that may lack the closing point: close those. Creek lines (ends far apart) stay open lines; hazardsFrom measures them as lines
  for (const cn in C.courses) for (const h of C.courses[cn].holes) for (const z of h.hz || []) {
    const p = z.p; if (!p || p.length < 3) continue; const a = p[0], b = p[p.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (z.t === 'b' || distM(a, b) < 5) p.push(a);
  }
}
function savePref() { try { localStorage.setItem(LS_PREF, JSON.stringify(pref)); } catch (e) {} }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

/* ---------------- geometry ---------------- */
const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
function xy(p, o) { return [(p[1] - o[1]) * 111320 * Math.cos(toRad(o[0])), (p[0] - o[0]) * 110920]; }
function fromXY(v, o) { return [o[0] + v[1] / 110920, o[1] + v[0] / (111320 * Math.cos(toRad(o[0])))]; }
function distM(a, b) { const v = xy(b, a); return Math.hypot(v[0], v[1]); }
function yds(a, b) { return distM(a, b) * YD; }
function bearing(a, b) { const v = xy(b, a); return (toDeg(Math.atan2(v[0], v[1])) + 360) % 360; }
function centroid(poly) { let la = 0, lo = 0; poly.forEach(p => { la += p[0]; lo += p[1]; }); return [la / poly.length, lo / poly.length]; }
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(p, a, b) { // meters
  const A = xy(a, p), B = xy(b, p), dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / L)) : 0;
  return Math.hypot(A[0] + t * dx, A[1] + t * dy);
}
function lineDist(p, l) { let m = 1e9; for (let i = 0; i < l.length - 1; i++) m = Math.min(m, segDist(p, l[i], l[i + 1])); return m; }
function polyNear(p, poly) { // nearest distance (m) to polygon boundary, 0 if inside
  if (inside(p, poly)) return 0;
  let m = 1e9; for (let i = 0; i < poly.length - 1; i++) m = Math.min(m, segDist(p, poly[i], poly[i + 1])); return m;
}
function nearestPt(p, poly) {
  let best = null, bd = 1e9;
  for (let i = 0; i < poly.length - 1; i++) {
    const A = xy(poly[i], p), B = xy(poly[i + 1], p), dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / L)) : 0, q = [A[0] + t * dx, A[1] + t * dy], d = Math.hypot(q[0], q[1]);
    if (d < bd) { bd = d; best = fromXY(q, p); }
  }
  return best;
}
function farPt(p, poly) { let best = poly[0], bd = 0; poly.forEach(q => { const d = distM(p, q); if (d > bd) { bd = d; best = q; } }); return best; }
function polyFar(p, poly) { let m = 0; poly.forEach(q => m = Math.max(m, distM(p, q))); return m; }
// ray from o through t: parametric distances (m) where it crosses polygon edges
function rayHits(o, t, poly) {
  const T = xy(t, o), L = Math.hypot(T[0], T[1]); if (!L) return [];
  const d = [T[0] / L, T[1] / L], hits = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const A = xy(poly[i], o), B = xy(poly[i + 1], o), e = [B[0] - A[0], B[1] - A[1]];
    const den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-9) continue;
    const s = (A[0] * e[1] - A[1] * e[0]) / den, u = (A[0] * d[1] - A[1] * d[0]) / den;
    if (u >= 0 && u <= 1 && s > 0 && !hits.some(x => Math.abs(x - s) < 0.01)) hits.push(s); // a ray through a vertex touches two edges at one spot: count it once
  }
  return hits.sort((a, b) => a - b);
}
function along(l, metersFromStart) { // point along polyline
  let rem = metersFromStart;
  for (let i = 0; i < l.length - 1; i++) {
    const s = distM(l[i], l[i + 1]);
    if (rem <= s || i === l.length - 2) { const v = xy(l[i + 1], l[i]), f = s ? rem / s : 0; return fromXY([v[0] * f, v[1] * f], l[i]); }
    rem -= s;
  }
  return l[l.length - 1];
}

/* ---------------- course helpers ---------------- */
function holes() { return C.courses[S ? S.course : pref.course].holes; }
function H(n) { return holes()[n - 1]; }
function course() { return S ? S.course : pref.course; }
function clubOf(cn) { const c = C && C.courses[cn]; return (c && c.club) || 'bc'; } // old course data without `club` = Bear Creek
function clubByKey(k) { const cs = C && C.clubs; if (cs && cs[k]) return cs[k]; return Object.assign({}, BC_CLUB, {dem: C && C.dem}); }
function club() { return clubByKey(clubOf(course())); } // the club of the current course
function teesOf(cn) { const c = C && C.courses[cn]; return (c && Array.isArray(c.tees) && c.tees.length) ? c.tees : TEES; }
function validTee(cn, t) { const ts = teesOf(cn); return ts.includes(t) ? t : ts[Math.floor(ts.length / 2)]; } // tee not on this course → its middle tee
function tee() { return validTee(course(), S ? S.tee : pref.tee); }
function fixTee(r) { r.tee = validTee(r.course, r.tee); }
function coursesOfClub(k) {
  const all = Object.keys(C.courses).filter(cn => clubOf(cn) === k);
  const listed = (clubByKey(k).courses || []).filter(cn => C.courses[cn]);
  return listed.length ? listed : all;
}
function greenC(h) { return h._gc || (h._gc = centroid(h.green)); }
function backLine(h) { // from green center back toward tee, extended
  if (h._bl) return h._bl;
  const l = h.line.slice().reverse(); l[0] = greenC(h);
  const a = l[l.length - 2], b = l[l.length - 1], v = xy(b, a), s = Math.hypot(v[0], v[1]) || 1;
  l.push(fromXY([v[0] / s * 400, v[1] / s * 400], b));
  return (h._bl = l);
}
function teePos(h, t) { return along(backLine(h), (h.yds[t || tee()] || 350) / YD); }
function pinOf(n) { const st = S && S.holes[n]; return (st && st.pin) || greenC(H(n)); }
function approachPt(h) { return along(backLine(h), 90 / YD * 1.0); } // ~90 yds out along the line
function greenAxis(h) { // front/back along approach axis
  const a = h.line.length > 2 ? h.line[h.line.length - 2] : teePos(h), c = greenC(h);
  const hits = rayHits(a, c, h.green);
  const D = distM(a, c);
  const s0 = hits.length ? hits[0] : D - 10, s1 = hits.length > 1 ? hits[hits.length - 1] : D + 10;
  const v = xy(c, a), L = Math.hypot(v[0], v[1]), dir = [v[0] / L, v[1] / L];
  return {a, dir, s0, s1, depthYds: (s1 - s0) * YD};
}
function pinFromDepth(h, depthYd, latYd) {
  const g = greenAxis(h), m = g.s0 + depthYd / YD, r = [g.dir[1], -g.dir[0]], lat = (latYd || 0) / YD;
  return fromXY([g.dir[0] * m + r[0] * lat, g.dir[1] * m + r[1] * lat], g.a);
}

/* ---------------- elevation (USGS 3DEP 1 m lidar grid + live fallback) ---------------- */
const DEMS = {}, DEM_BUSY = {}; // one elevation grid per club, loaded when that club is first used
async function cachedFetch(url, ms) { // network first, but if it is slow (weak signal) use the copy saved on this phone
  let c = null; try { c = await caches.open('bcgps-data'); } catch (e) {}
  const net = fetch(url).then(async r => { if (!r.ok) throw new Error('bad'); if (c) { try { await c.put(url, r.clone()); } catch (e) {} } return r; });
  if (!c) return net;
  const hit = await c.match(url);
  if (!hit) return net;
  return Promise.race([net, new Promise((_, rej) => setTimeout(rej, ms || 3000))]).catch(() => hit);
}
async function loadDEM() { // grid of the current club only
  const k = clubOf(course()), m = clubByKey(k).dem;
  if (!m || DEMS[k] || DEM_BUSY[k]) return;
  DEM_BUSY[k] = true;
  try { const buf = await (await cachedFetch(m.file || 'dem.bin', 5000)).arrayBuffer(); if (m.rows && buf.byteLength !== m.rows * m.cols * 2) throw new Error('size'); DEMS[k] = new Uint16Array(buf); render(); } catch (e) { setTimeout(loadDEM, 60e3); } // weak signal: try again in a minute
  DEM_BUSY[k] = false;
} // a saved grid of another size would read as garbage elevations
const liveElev = {};
function greenGridAt(p) { // feet, from the 1 m lidar grid of whichever green p is on
  for (const cn in C.courses) for (const h of C.courses[cn].holes) {
    const g = h.gz; if (!g || p[0] > g.n || p[0] < g.s || p[1] < g.w || p[1] > g.e) continue;
    const r = (g.n - p[0]) / (g.n - g.s) * (g.rows - 1), q = (p[1] - g.w) / (g.e - g.w) * (g.cols - 1);
    const r0 = Math.min(g.rows - 2, Math.floor(r)), q0 = Math.min(g.cols - 2, Math.floor(q)), fr = r - r0, fq = q - q0, v = (a, b) => g.cm[a * g.cols + b];
    const cm = v(r0, q0) * (1 - fr) * (1 - fq) + v(r0, q0 + 1) * (1 - fr) * fq + v(r0 + 1, q0) * fr * (1 - fq) + v(r0 + 1, q0 + 1) * fr * fq;
    return (g.base + cm / 100) * 3.28084;
  }
  return null;
}
function elevAt(p) { // feet
  if (!p) return null;
  const gg = greenGridAt(p); if (gg != null) return gg;
  const k = clubOf(course()), m = clubByKey(k).dem, D = DEMS[k];
  if (D && m && p[0] <= m.n && p[0] >= m.s && p[1] >= m.w && p[1] <= m.e) {
    const r = (m.n - p[0]) / (m.n - m.s) * (m.rows - 1), q = (p[1] - m.w) / (m.e - m.w) * (m.cols - 1);
    const r0 = Math.min(m.rows - 2, Math.floor(r)), q0 = Math.min(m.cols - 2, Math.floor(q)), fr = r - r0, fq = q - q0;
    const g = (a, b) => D[a * m.cols + b];
    const v = g(r0, q0) * (1 - fr) * (1 - fq) + g(r0, q0 + 1) * (1 - fr) * fq + g(r0 + 1, q0) * fr * (1 - fq) + g(r0 + 1, q0 + 1) * fr * fq;
    return (m.base + v * m.scale) * 3.28084;
  }
  const key = p[0].toFixed(5) + ',' + p[1].toFixed(5);
  if (key in liveElev) return liveElev[key];
  liveElev[key] = null;
  fetch(`https://epqs.nationalmap.gov/v1/json?x=${p[1]}&y=${p[0]}&wkid=4326&units=Feet&includeDate=false`).then(r => r.json()).then(j => { const v = +j.value; if (v > -1000) { liveElev[key] = v; render(); } else retry(); }).catch(retry);
  function retry() { setTimeout(() => { delete liveElev[key]; }, 60e3); } // a failed lookup is retried after a minute, not on every GPS fix
  return null;
}

/* ---------------- weather + plays-like ---------------- */
const WX_TTL = 2 * 60e3; // refresh every 2 minutes
let wxModel = null, wxObs = null, wxLoading = false;
// nearest NWS station per club: [id, label, station elevation ft for sea-level -> station pressure]
// 4th field: take wind from the forecast model at your GPS spot instead (station too far for local wind)
const WX_STN = {bc: ['KDFW', 'DFW Airport', 541, false], tcc: ['KAFW', 'Fort Worth Alliance', 722, true]}; // station elevations as NWS lists them (KDFW 164.9 m, KAFW 220.1 m)
function wxStn() { return WX_STN[clubOf(course())] || WX_STN.bc; }
const WX_KEEP = 180 * 60e3, WX_WIND_KEEP = 90 * 60e3; // offline on the course: temperature and pressure age slowly (keep 3 h, shown as aged); wind does not (dropped after 90 min)
function combineWx() {
  const obsFresh = wxObs && wxObs.stn === wxStn()[0] && Date.now() - wxObs.ts < 40 * 60e3;
  if (wxModel && wxModel.club && wxModel.club !== clubOf(course())) wxModel = null; // another club's forecast
  if (wxModel && Date.now() - (wxModel.fetchedAt || 0) > WX_KEEP) wxModel = null; // too old to trust at all
  if (!wxModel && !obsFresh) { wx = null; return; }
  const cur = obsFresh ? Object.assign({}, wxModel ? wxModel.current : {}, wxObs.current) : Object.assign({}, wxModel.current);
  const modelWind = obsFresh && wxStn()[3] && wxModel && wxModel.current && wxModel.current.wind_speed_10m != null;
  if (modelWind) ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'].forEach(k => { if (wxModel.current[k] != null) cur[k] = wxModel.current[k]; });
  if (obsFresh && wxObs.current.apparent_temperature == null) cur.apparent_temperature = null; // the model's feels-like must not ride along with a measured temperature
  if (cur.apparent_temperature == null) cur.apparent_temperature = cur.temperature_2m;
  const age = Date.now() - (obsFresh ? wxObs.fetchedAt : wxModel.fetchedAt || 0);
  if (age > WX_WIND_KEEP) { cur.wind_speed_10m = 0; cur.wind_gusts_10m = 0; } // old wind is worse than no wind
  wx = {current: cur, hourly: wxModel && wxModel.hourly, daily: wxModel && wxModel.daily, aged: age > 10 * 60e3, ageMin: Math.round(age / 60e3),
        src: obsFresh ? wxStn()[1] + ' (measured)' + (modelWind ? ' · wind: model at your spot' : '') : 'Open-Meteo model', obsTs: obsFresh ? wxObs.ts : (wxModel && wxModel.ts)};
}
async function loadWx(force) {
  if (wxLoading || (!force && wx && Date.now() - wxTs < WX_TTL)) return;
  const wxClub = clubOf(course()); let gotWx = false;
  wxLoading = true; window._wxFetches = (window._wxFetches || 0) + 1;
  const p = me() || greenC(H(1));
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${p[0].toFixed(4)}&longitude=${p[1].toFixed(4)}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,precipitation` +
    `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability&daily=sunrise,sunset` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=2&_=${Date.now()}`;
  await Promise.all([
    fetch(u, {cache: 'no-store'}).then(r => r.json()).then(j => { if (j.current) { const off = j.utc_offset_seconds != null ? j.utc_offset_seconds : -21600, sg = off < 0 ? '-' : '+', a = Math.abs(off); j.ts = new Date(j.current.time + ':00' + sg + String(Math.floor(a / 3600)).padStart(2, '0') + ':' + String(Math.floor(a % 3600 / 60)).padStart(2, '0')).getTime() || Date.now(); j.club = wxClub; j.fetchedAt = Date.now(); if (wxClub === clubOf(course())) { wxModel = j; gotWx = true; } /* a slow reply for the old club is dropped */ } }).catch(() => {}),
    loadNWS()
  ]);
  combineWx();
  const fresh = gotWx || (wxObs && Date.now() - wxObs.fetchedAt < 5e3); // did anything arrive in this call?
  if (wx && fresh) { wxTs = Date.now(); wxErr = ''; } else wxErr = 'weather offline — retrying';
  wxLoading = false;
  const ae = document.activeElement;
  if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) { renderHeader(); return; }
  if (S && (tab === 'hole' || tab === 'info')) render(); else if (tab === 'info') render(); else renderHeader();
}
async function loadNWS() { // live observation from the club's nearest NWS station (KDFW for Bear Creek, KAFW for Trophy Club)
  const [stn, , stnFt] = wxStn();
  try {
    const p = (await (await fetch(`https://api.weather.gov/stations/${stn}/observations/latest`, {cache: 'no-store'})).json()).properties;
    const v = o => o && o.value != null ? o.value : null, mph = x => x == null ? null : x / 1.609;
    const t = v(p.temperature); if (t == null) return false;
    const ws = mph(v(p.windSpeed)) || 0, pr = v(p.barometricPressure);
    // KDFW reports no direction for variable or calm wind: borrow the model's direction, or treat it as no wind rather than a north wind
    const wd = v(p.windDirection), md = wxModel && wxModel.current ? wxModel.current.wind_direction_10m : null;
    const cur = {temperature_2m: t * 9 / 5 + 32, wind_speed_10m: wd == null && md == null ? 0 : ws, wind_direction_10m: wd != null ? wd : (md || 0), wind_gusts_10m: mph(v(p.windGust)) || ws};
    if (v(p.relativeHumidity) != null) cur.relative_humidity_2m = Math.round(v(p.relativeHumidity));
    if (pr) cur.surface_pressure = pr / 100 - stnFt / 27.3; // sea-level → station pressure (~1 hPa per 27 ft)
    if (cur.relative_humidity_2m == null && !(wxModel && wxModel.current)) cur.relative_humidity_2m = 50;
    if (cur.surface_pressure == null && !(wxModel && wxModel.current)) cur.surface_pressure = 995;
    wxObs = {current: cur, ts: new Date(p.timestamp).getTime(), stn, fetchedAt: Date.now()};
  } catch (e) {}
}
function wxAge() { if (!wx) return ''; const s = Math.round((Date.now() - wxTs) / 1000); return `Live · ${wx.src} as of ${fmtClock(wx.obsTs)} · checked ${s < 60 ? s + 's' : Math.round(s / 60) + 'm'} ago`; }
function airDensity(tF, hPa, rh) { // kg/m3, moist air
  const T = (tF - 32) * 5 / 9, es = 6.1078 * Math.pow(10, 7.5 * T / (T + 237.3)), pv = rh / 100 * es, pd = hPa - pv;
  return (pd * 100) / (287.058 * (T + 273.15)) + (pv * 100) / (461.495 * (T + 273.15));
}
const RHO0 = airDensity(70, 1013.25, 50);
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = d => DIRS[Math.round(d / 22.5) % 16];
/* Returns {total, slope, air, wind, aim, dh} — all yards except dh (feet) */
function playsLike(from, to) {
  const d = yds(from, to); const r = {d, total: d, slope: 0, air: 0, wind: 0, aim: 0, dh: null, head: 0, cross: 0};
  const e1 = elevAt(from), e2 = elevAt(to);
  if (e1 != null && e2 != null) { r.dh = e2 - e1; r.slope = r.dh / 3 * (r.dh > 0 ? 1 : 0.9); }
  if (wx && wx.current && d > 15) {
    const c = wx.current, rho = airDensity(c.temperature_2m, c.surface_pressure, c.relative_humidity_2m);
    r.air = d * 0.55 * (rho / RHO0 - 1);
    const scale = Math.min(1, d / 120); // short shots fly lower and spend less time in the wind
    const rel = toRad(c.wind_direction_10m - bearing(from, to));
    r.head = c.wind_speed_10m * Math.cos(rel); r.cross = c.wind_speed_10m * Math.sin(rel);
    r.wind = (r.head > 0 ? 0.01 : 0.005) * r.head * d * scale;
    r.aim = r.cross * d * 0.006 * scale; // + = aim right (wind from right)
  }
  r.total = d + r.slope + r.air + r.wind;
  return r;
}
function plChips(r) {
  const f = v => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));
  const out = [];
  if (r.dh != null) out.push(`<span class="chip">${r.dh >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(r.dh))} ft <b>${f(r.slope)}</b></span>`);
  if (wx) out.push(`<span class="chip">wind <b>${f(r.wind)}</b></span>`, `<span class="chip">air <b>${f(r.air)}</b></span>`);
  if (Math.abs(r.aim) >= 1.5) out.push(`<span class="chip">aim <b>${Math.round(Math.abs(r.aim))} yd ${r.aim > 0 ? 'right' : 'left'}</b></span>`);
  return out.join('');
}

/* ---------------- position ---------------- */
function onCourse(p) { return p && distM(p, greenC(H(1))) < 3000; }
// how long a fix stays "where I am": the iPhone app only sends a new fix after moving ~3 m, so standing on a tee for minutes is normal there; the browser sends them continuously
function gpsMaxAge() { return NATIVE ? 600e3 : 120e3; }
function me() {
  if (manualMe) return manualMe;
  if (gps && onCourse(gps.p) && Date.now() - gps.ts < gpsMaxAge()) return gps.p;
  return null;
}
function onThisHole(n, p) { const h = H(n); return p && (lineDist(p, h.line) < 110 || yds(p, greenC(h)) < h.yds[tee()] + 40); }
function posFor(n) { const m = me(); return m && (manualMe || onThisHole(n, m)) ? m : teePos(H(n)); }
function clubNear(p) { // which club's grounds are you at (within 3 km of a course's 1st green)?
  if (!p || !C || !C.clubs) return null;
  for (const k in C.clubs) for (const cn of coursesOfClub(k)) { const h = C.courses[cn].holes[0]; if (h && distM(p, greenC(h)) < 3000) return k; }
  return null;
}
let autoClubDone = false; // also set when you pick a club or course yourself: your choice beats the GPS
function autoClub() { // no round going and you're standing at the other club: switch the setup to it once, on a real fix
  if (S || autoClubDone || !gps || gps.acc > 100) return; const k = clubNear(gps.p);
  if (k) { autoClubDone = true; if (k !== clubOf(pref.course)) pickClub(k); }
}
function posLabel() {
  if (manualMe) return '📍 Manual position (tap 📍 Me again → GPS)';
  if (gps && onCourse(gps.p) && !onThisHole(viewHole, gps.p)) return `🛰 You're not on this hole — showing from the ${tee()} tee`;
  if (gps && onCourse(gps.p)) return `<span class="liveDot"></span><b style="color:var(--acc)">LIVE ${gps.src === 'watch' ? '⌚ WATCH' : NATIVE ? '📱 PHONE' : ''} GPS</b> ±${Math.round(gps.acc * YD)} yd · ${Math.max(0, Math.round((Date.now() - gps.ts) / 1000))}s ago` + (gps.acc > 25 ? ' <span class="warnTxt">(weak)</span>' : '');
  if (gps) { const k = clubNear(gps.p); if (k && k !== clubOf(course())) return `🛰 You're at ${esc(clubByKey(k).short)} — this ${S ? 'round' : 'setup'} is ${esc(club().short)} → showing from the ${tee()} tee`; }
  if (gps) return `🛰 GPS ok but you're off-course → showing from the ${tee()} tee`;
  return `${gpsErr ? '⚠️ ' + esc(gpsErr) + ' — ' : '🛰 waiting for GPS — '}showing from the ${tee()} tee`;
}
let lastRender = 0;
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bcgps);
let gpsSrc = 'phone', watchPaired = false, lastNativeState = '';
function postNative(o) { if (NATIVE) try { window.webkit.messageHandlers.bcgps.postMessage(o); } catch (e) {} }
window.bcNative = {
  loc(lat, lon, acc, src) {
    if (acc > 50 && gps && gps.acc <= 50 && Date.now() - gps.ts < 120e3) return; // the phone's coarse fallback must not replace a good recent (Watch) fix
    gps = {p: [lat, lon], acc, ts: Date.now(), src}; gpsErr = ''; autoClub(); trackHoleByGPS(); liveUpdate();
  },
  setSource(s, paired) { gpsSrc = s; watchPaired = !!paired; liveUpdate(); },
  err(msg) { gpsErr = msg; liveUpdate(); },
  cmd(name, n) { // one-tap actions from the Watch (n = hole shown on the watch) and the lock screen
    if (!S || !S.started || S.ended) return;
    const hole = n >= 1 && n <= 18 && S.order.includes(n) ? n : S.cur; // the Watch's hole only if it is part of this round
    if (name === 'shot') quickShot(hole);
    else if (name === 'next') advanceFrom(S.cur);
    else if (name === 'undo') { // last shot on that hole; or on the hole just left, when it has none and the advance was less than a minute ago (a tap right after auto-advance)
      const i = S.order.indexOf(hole), prev = i > 0 ? S.order[i - 1] : null, ps = prev ? S.holes[prev] : null;
      const st = hs(hole).shots.length || !ps || !(Date.now() - (ps.endTs || 0) < 60e3) ? hs(hole) : ps;
      if (st.shots.length) { st.shots.pop(); st.manual = false; st.adj = null; save(); render(); }
    }
  }
};
function setGpsSource(s) { gpsSrc = s; postNative({type: 'source', value: s}); liveUpdate(); }
function pushNativeState() { // tell the iPhone app (and through it the Watch) which hole, pin and weather to use
  if (!NATIVE || !C) return;
  const n = viewHole, p = pinOf(n), c = wx && wx.current;
  const st = {type: 'state', course: course(), club: clubOf(course()), hole: n, tee: tee(), par: H(n).par, pin: [p[0], p[1]], pinSet: !!(S && S.holes[n] && S.holes[n].pin), shots: S && S.started && !S.ended && S.holes[S.cur] ? counted(S.holes[S.cur]) : -1, cur: S && S.started && !S.ended ? S.cur : 0};
  if (c) st.wx = {t: c.temperature_2m, rh: c.relative_humidity_2m, p: c.surface_pressure, ws: c.wind_speed_10m, wd: c.wind_direction_10m};
  const k = JSON.stringify(st); if (k !== lastNativeState) { lastNativeState = k; postNative(st); }
  try { // yardages for the lock-screen Live Activity (only while a round is on)
    if (!S || S.ended) return;
    const h = H(n), from = posFor(n), pin = p, hits = rayHits(from, pin, h.green);
    const f = inside(from, h.green) ? 0 : hits.length >= 2 ? hits[0] * YD : polyNear(from, h.green) * YD;
    const b = inside(from, h.green) ? polyFar(from, h.green) * YD : hits.length >= 2 ? hits[hits.length - 1] * YD : polyFar(from, h.green) * YD;
    const pl = playsLike(from, pin), ex = pl.total - pl.d;
    const lv = {type: 'live', hole: n, par: h.par, mid: Math.round(pl.d), plays: Math.round(pl.total), front: Math.round(f), back: Math.round(b), fPl: Math.round(f + ex), bPl: Math.round(b + ex), shots: S.holes[n] ? counted(S.holes[n]) : 0};
    const lk = JSON.stringify(lv), nowT = Date.now(); if (lk !== lastLive && nowT - lastLiveT > 4000) { lastLive = lk; lastLiveT = nowT; postNative(lv); } // at most one lock-screen update per 4 s
  } catch (e) {}
}
let lastLive = '', lastLiveT = 0;
function endLive() { lastLive = ''; lastLiveT = 0; postNative({type: 'endlive'}); }
function startGPS() {
  if (NATIVE) { postNative({type: 'ready'}); return; } // the iPhone app feeds GPS (phone or watch) through bcNative.loc
  if (!navigator.geolocation) { gpsErr = 'GPS not supported'; return; }
  navigator.geolocation.watchPosition(p => {
    gps = {p: [p.coords.latitude, p.coords.longitude], acc: p.coords.accuracy, ts: Date.now()}; gpsErr = '';
    autoClub(); trackHoleByGPS();
    liveUpdate();
  }, e => {
    if (e.code === 1) { gpsErr = 'Location permission denied — enable it for this site in Settings'; render(); return; }
    if (!gps || Date.now() - gps.ts > 60e3) gpsErr = 'Searching for GPS…';
    liveUpdate();
  }, {enableHighAccuracy: true, maximumAge: 0});
}

/* ---------------- pace / GPS hole tracking ---------------- */
let gpsCand = null;
function nearestHole(p) {
  let best = null, bd = 1e9;
  holes().forEach(h => { const d = Math.min(lineDist(p, h.line), polyNear(p, h.green) + 5); if (d < bd) { bd = d; best = h.n; } });
  return bd < 40 ? best : null;
}
function trackHoleByGPS() {
  if (!S || !S.started || S.ended || !gps || !onCourse(gps.p)) return;
  if (gps.acc > 30) return; // a weak fix (tunnel, cold start, pocket) must not move the round
  const now = Date.now(), n = nearestHole(gps.p);
  // off every hole (cart path, between tees) or a long gap in fixes: the dwell starts over, so one old fix cannot confirm a hole minutes later
  // (60 s, not less: the phone's 3 m distance filter means fixes can pause while you stand still on the tee)
  if (!n || (gpsCand && now - gpsCand.last > 60e3)) gpsCand = null;
  if (!n) return;
  if (!gpsCand || gpsCand.n !== n) { gpsCand = {n, ts: now, last: now}; return; }
  gpsCand.last = now;
  if (now - gpsCand.ts < 30e3) return; // dwell 30 s
  if (S.gpsHole !== n) {
    const prev = S.gpsHole;
    if (prev && S.holes[prev] && !S.holes[prev].gpsOut) S.holes[prev].gpsOut = gpsCand.ts;
    const st = hs(n); if (!st.gpsIn) st.gpsIn = gpsCand.ts;
    S.gpsHole = n; save();
    if (pref.autoAdv !== false && prev && S.order.indexOf(n) === S.order.indexOf(prev) + 1 && S.cur === prev && !hs(prev).done) advanceFrom(prev);
  }
  if (pendingScore && !$('#modal').innerHTML) scorePrompt(pendingScore);
}
function hs(n) { return S.holes[n] || (S.holes[n] = {shots: [], adj: null, done: false}); }
function fmtDur(ms) { if (ms == null || ms < 0) return '—'; const m = Math.floor(ms / 60e3), h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}` : `${m}m`; }
function fmtClock(ts) { return ts ? new Date(ts).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : '—'; }
function holeTime(n) {
  const st = S && S.holes[n]; if (!st) return null;
  const a = st.gpsIn || st.startTs, b = st.gpsOut || st.endTs || (n === S.cur && !S.ended ? Date.now() : null);
  return a && b ? b - a : null;
}
function paceInfo() { // minutes ahead(-)/behind(+) of a 4:12 pace
  if (!S || !S.started) return null;
  let exp = 0, done = 0;
  S.order.forEach(n => { if (S.holes[n] && S.holes[n].done) { exp += PACE_MIN[H(n).par]; done++; } });
  const end = S.ended || Date.now(), el = (end - S.started) / 60e3;
  const cs = S.holes[S.cur], curEl = (!S.ended && cs && cs.startTs && !cs.done) ? (end - cs.startTs) / 60e3 : 0;
  const credit = S.ended ? 0 : Math.min(PACE_MIN[H(S.cur).par], curEl);
  return {done, elapsed: el, expected: exp, diff: done ? Math.round(el - exp - credit) : 0};
}

/* ---------------- scoring ---------------- */
function counted(st) { return st.shots.filter(s => !s.g || s.g.counts).length; }
function rel(n) { const st = S && S.holes[n]; return st ? relOf(st, H(n).par) : null; }
function holeData(r, n) { return C.courses[r.course].holes[n - 1]; }
function holeStats(r, n) { // auto from logged shots, overridable by taps
  const st = r.holes[n]; if (!st) return null;
  const h = holeData(r, n), sh = st.shots.filter(s => !s.g || s.g.counts);
  const putts = st.putts != null ? st.putts : sh.filter(s => s.t === 'Putt').length;
  let gir = st.gir != null ? st.gir : null;
  if (gir == null && sh.length) { const k = sh.findIndex(s => s.pos && (inside(s.pos, h.green) || polyNear(s.pos, h.green) < 2)); if (k >= 0) gir = (k + 1) <= h.par - 2; else if (st.done) gir = sh.length - putts <= h.par - 2 && putts > 0; }
  let fir = st.fir != null ? st.fir : null;
  if (fir == null && h.par >= 4 && sh[0] && sh[0].pos && (h.fw || []).length) {
    if (h.fw.some(f => inside(sh[0].pos, f))) fir = 'hit';
    else { const v0 = xy(greenC(h), h.line[0]), v1 = xy(sh[0].pos, h.line[0]); fir = (v0[0] * v1[1] - v0[1] * v1[0]) > 0 ? 'L' : 'R'; }
  }
  return {putts, gir, fir, par: h.par};
}
function setStat(n, k, v) { const st = hs(n); st[k] = (st[k] === v ? null : v); save(); render(); }
function bumpPutts(d) { const st = hs(viewHole), cur = holeStats(S, viewHole).putts; st.putts = Math.max(0, cur + d); save(); render(); }
function roundStats(r) {
  let fh = 0, ft = 0, gh = 0, gt = 0, putts = 0, ph = 0, rel = 0, thru = 0; const dist = {eagle: 0, birdie: 0, par: 0, bogey: 0, dbl: 0};
  r.order.forEach(n => { const st = r.holes[n]; if (!st || !st.done) return; const s = holeStats(r, n), h = holeData(r, n);
    if (s.fir != null && h.par >= 4) { ft++; if (s.fir === 'hit') fh++; }
    if (s.gir != null) { gt++; if (s.gir) gh++; }
    if (st.putts != null || st.shots.some(x => !x.g || x.g.counts)) { putts += s.putts; ph++; } // a hole scored by number only has no putt count, not zero putts
    const v = relOf(st, h.par);
    rel += v; thru++; dist[v <= -2 ? 'eagle' : v === -1 ? 'birdie' : v === 0 ? 'par' : v === 1 ? 'bogey' : 'dbl']++; });
  return {fh, ft, gh, gt, putts, ph, rel, thru, dist};
}
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
function relStr(r) { return r == null ? '—' : r === 0 ? 'E' : (r > 0 ? '+' + r : '−' + Math.abs(r)); }
function relCls(r) { return r < 0 ? 'under' : r > 0 ? 'over' : ''; }
function totals() { let r = 0, thru = 0, str = 0; S.order.forEach(n => { const v = rel(n); if (v != null && (S.holes[n].done || S.holes[n].manual)) { r += v; thru++; str += H(n).par + v; } }); return {r, thru, str}; }
// Each stroke tap = "I'm standing over the ball this shot left me" → s.pos is where that shot FINISHED.
// A shot starts at the previous counted shot's finish (or the tee for stroke 1).
function shotStart(n, idx) {
  const st = hs(n), prev = st.shots.slice(0, idx).filter(s => (!s.g || s.g.counts) && !s.gimme);
  if (!prev.length) return teePos(H(n));
  return prev[prev.length - 1].pos || null;
}
function shotType(n, idx) {
  const h = H(n), st = hs(n), prior = st.shots.slice(0, idx).filter(s => !s.g || s.g.counts).length;
  if (prior === 0) return h.par === 3 ? 'Tee shot' : 'Drive';
  const start = shotStart(n, idx);
  if (start && (inside(start, h.green) || polyNear(start, h.green) < 2)) return 'Putt';
  const d = start ? yds(start, pinOf(n)) : null;
  if (d != null && d < 40) return 'Chip';
  if (h.par === 5 && prior === 1) return 'Second';
  return 'Approach';
}
function logShot(n, player, type, gimmick) {
  const st = hs(n), pos = me(); st.manual = false; st.adj = null; // logged strokes take over from any ± override
  const s = {p: player, ts: Date.now(), pos: pos || null, t: type || null};
  if (gimmick) s.g = gimmick;
  if (!s.t && !gimmick) s.t = shotType(n, st.shots.length);
  if (n === viewHole) target = null; // the ball has moved: a target tapped for the last shot is stale
  st.shots.push(s); save(); render();
}
function shotDist(n, i) { // {txt} distance this shot travelled: start (tee / previous ball) → where you logged it
  const st = hs(n), s = st.shots[i];
  if (s.gimme || (s.g && !s.g.counts)) return null;
  const start = shotStart(n, i);
  const isLast = st.done && st.shots.slice(i + 1).every(x => (x.g && !x.g.counts));
  const end = s.t === 'Putt' && isLast ? pinOf(n) : s.pos;
  if (!start || !end) return null;
  const y = yds(start, end);
  if (s.t === 'Putt') return Math.round(y * 3) + ' ft';
  return Math.round(y) + ' yd' + (i === st.shots.findIndex(x => !x.g || x.g.counts) ? ' from tee' : '');
}
function completeHole() {
  const n = viewHole, st = hs(n);
  st.done = true; st.endTs = st.endTs || Date.now(); if (!st.startTs) st.startTs = S.started; if (S.pendingScore === n) S.pendingScore = null;
  if (!counted(st) && st.adj == null) st.adj = 0;
  if (n !== S.cur) { save(); render(); return; } // scoring a hole you browsed to: record it, but the round stays where it is
  const i = S.order.indexOf(n);
  if (i === S.order.length - 1) { S.ended = Date.now(); save(); endLive(); tab = 'card'; render(); return; }
  const nx = S.order[i + 1]; S.cur = nx; viewHole = nx; target = null; manualMe = null;
  const ns = hs(nx); if (!ns.startTs) ns.startTs = Date.now();
  save(); render(); fitHole(true);
}

/* ---------------- auto-advance + quick score prompt ---------------- */
let pendingScore = null;
function advanceFrom(prev) { // move to the next hole, then ask for the score of the one just played
  if (!S || S.ended || S.preview) return;
  const i = S.order.indexOf(prev); if (i < 0 || i >= S.order.length - 1) return;
  const nx = S.order[i + 1], wasViewing = viewHole === prev;
  S.cur = nx; if (wasViewing) { viewHole = nx; target = null; manualMe = null; }
  const ns = hs(nx); if (!ns.startTs) ns.startTs = Date.now();
  const ps = hs(prev);
  if (!ps.done) {
    pendingScore = prev; S.pendingScore = prev;
    // strokes were logged: the hole counts from now on (the prompt can still correct it); "Later" must not drop it from the total
    if (counted(ps)) { ps.done = true; if (!ps.endTs) ps.endTs = Date.now(); if (!ps.startTs) ps.startTs = S.started; }
  }
  save(); render(); if (wasViewing) fitHole(true);
  if (pendingScore && !$('#modal').innerHTML) scorePrompt(pendingScore);
}
function scorePrompt(n) {
  pendingScore = null; const st = hs(n), h = H(n), c = counted(st), cur = rel(n); // S.pendingScore stays until a score is entered: "Later" leaves a reminder banner
  const guess = c || (cur != null ? h.par + cur : h.par);
  const lbl = r => r <= -2 ? 'Eagle' : r === -1 ? 'Birdie' : r === 0 ? 'Par' : r === 1 ? 'Bogey' : r === 2 ? 'Double' : '+' + r;
  const opts = []; for (let k = Math.max(1, h.par - 2); k <= h.par + 3; k++) opts.push(k);
  modal(`<h3 style="margin:0 0 4px">Hole ${n} — what was your score?</h3>
    <div class="small mut">Par ${h.par}${c ? ' · ' + c + ' shot' + (c > 1 ? 's' : '') + ' logged' : ''}</div>
    <div class="row" style="flex-wrap:wrap;margin:10px 0">${opts.map(k => `<button class="${k === guess ? 'pri' : ''}" style="flex:1 0 28%;padding:14px 4px;font-size:22px;font-weight:800" onclick="setHoleScore(${n},${k})">${k}<div style="font-size:11px;font-weight:600;opacity:.8">${lbl(k - h.par)}</div></button>`).join('')}</div>
    <div class="row"><button onclick="closeModal()">Later</button><button onclick="goBackTo(${n})">↩ Still on ${n}</button></div>`);
}
function setHoleScore(n, k) {
  if (S.pendingScore === n) S.pendingScore = null;
  const st = hs(n), h = H(n);
  if (k === counted(st)) { st.manual = false; st.adj = null; } else { st.adj = k - h.par; st.manual = true; }
  st.done = true; if (!st.endTs) st.endTs = Date.now(); if (!st.startTs) st.startTs = S.started;
  save(); closeModal(); render();
}
function goBackTo(n) { // advanced by mistake: undo what the advance wrote, so hole times and pace stay honest
  const nx = S.cur, ns = nx !== n ? S.holes[nx] : null;
  if (ns && !ns.done && !counted(ns)) { delete ns.startTs; delete ns.gpsIn; } // the hole we jumped to never really started
  const st = hs(n); st.done = false; delete st.endTs; delete st.gpsOut; // still playing this one
  S.cur = n; viewHole = n; target = null; S.gpsHole = n; gpsCand = null; pendingScore = null; S.pendingScore = null; save(); closeModal(); render(); fitHole(true);
}
function quickShot(n) { // one-tap stroke from the Watch or lock screen; a hole outside this round, or one already finished and not current, is ignored
  if (!S || !S.started || S.ended || S.preview) return;
  const h = n >= 1 && n <= 18 && S.order.includes(n) ? n : S.cur;
  if (h !== S.cur && S.holes[h] && S.holes[h].done) return;
  logShot(h, null);
}

/* ---------------- dictation ---------------- */
const NUMW = {one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, five: 5, 2: 2, 3: 3, 4: 4, 5: 5, a: 1, single: 1}; // "to/too putts" is how speech-to-text hears "two putts"
function parseDictation(text, n) {
  const names = (S.mode === 'scramble' ? S.players : []).map((nm, i) => ({i, k: nm.trim().toLowerCase()})).filter(x => x.k);
  const findP = seg => {
    for (const x of names) { const re = new RegExp('\\b' + x.k.replace(/[^a-z0-9 ]/g, '') + "('?s)?\\b"); if (re.test(seg)) return x.i; }
    const pre = names.filter(x => x.k.length >= 3 && new RegExp('\\b' + x.k.slice(0, 3).replace(/[^a-z0-9]/g, '')).test(seg));
    if (pre.length === 1) return pre[0].i; // a 3-letter start only counts when it points at exactly one golfer
    if (/\b(me|my|i)\b/.test(seg)) { const t = names.find(x => x.i === 0); if (t) return 0; }
    return null;
  };
  const typ = seg => /\b(drives?|driver|drove|tee ?shot|off the tee)\b/.test(seg) ? 'Drive' :
    /\b(putts?|putted|putter|made it|sank|holed|drained|tap ?in)\b/.test(seg) ? 'Putt' :
    /\b(chips?|chipped|pitch|pitched|bunker shot|sand|flop)\b/.test(seg) ? 'Chip' :
    /\b(lay ?up|second|layed up|laid up|fairway wood|hybrid)\b/.test(seg) ? 'Second' :
    /\b(approach|irons?|wedges?|third|into the green|on the green|hit the green)\b/.test(seg) ? 'Approach' : null;
  const gim = seg => { const m = seg.match(/\b(mulligan|mully|string|throw|threw|kick|kicked|foot wedge|re-?tee|drop)\b/); if (!m) return null;
    const w = m[1]; const kind = /mul/.test(w) ? 'Mulligan' : /string/.test(w) ? 'String' : /thr/.test(w) ? 'Throw' : /kick|foot/.test(w) ? 'Kick' : w === 'drop' ? 'Drop' : 'Re-tee';
    const ft = seg.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(feet|foot|ft|inches|yards)/);
    return {kind, note: ft ? ft[0] : '', counts: false}; };
  const out = [];
  const segs = text.toLowerCase().replace(/[.;!?]/g, ',').split(/,|\bthen\b|\bafter that\b|\bnext\b|\band\b/).filter(s => s && s.trim().length > 1);
  let lastP = null;
  for (let seg of segs) {
    seg = seg.trim();
    let p = findP(seg); const g = gim(seg); let t = typ(seg);
    if (!g && p == null && !t) continue;
    if (p == null && t) p = lastP; // "Travis driver, two putts": the putts are Travis's too
    if (p != null) lastP = p;
    let count = 1; const cm = seg.match(/\b(two|three|four|five|2|3|4|5)[ -]?putt/) || seg.match(/\b(to|too)[ -]?putts\b/); if (cm) { count = NUMW[cm[1]] || 1; t = 'Putt'; } // "to putts" only in the plural, so "going to putt" stays one
    if (g) out.push({p, t: null, g});
    else for (let i = 0; i < count; i++) out.push({p, t});
  }
  return out;
}
let dictTimer = null, dictRec = null, dictHole = null; // dictHole: the hole the sheet was opened for, so an auto-advance mid-sentence cannot move the shots
function stopDictRec() { if (dictRec) { try { dictRec.abort(); } catch (e) {} dictRec = null; } }
function stopDictation() { clearInterval(dictTimer); stopDictRec(); }
function startDictation() {
  clearInterval(dictTimer); stopDictRec();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  openDictateSheet('');
  if (!SR) { $('#dictStatus').textContent = 'Voice not supported in this browser — tap the text box and use your keyboard mic 🎤.'; return; }
  try {
    const r = new SR(); r.lang = 'en-US'; r.interimResults = true; r.continuous = false; dictRec = r;
    $('#dictStatus').textContent = '🎙 Listening… e.g. "Drew drive, Chris approach, Travis two putts"';
    // an aborted recognizer ("Again" or Cancel) still fires onerror/onend afterwards: those must not touch the new sheet
    r.onresult = e => { if (dictRec !== r) return; const box = $('#dictTxt'); if (!box) return; let t = ''; for (const res of e.results) t += res[0].transcript; box.value = t; previewDictation(); };
    r.onerror = e => { if (dictRec !== r) return; const s = $('#dictStatus'); if (s) s.textContent = 'Mic error (' + e.error + ') — type or use keyboard mic instead.'; };
    r.onend = () => { if (dictRec !== r) return; dictRec = null; const s = $('#dictStatus'); if (!s) return;
      if (parseDictation($('#dictTxt').value, dictHole).length) { let k = 3; s.textContent = 'Adding in 3… (tap the box to edit)'; dictTimer = setInterval(() => { const q = $('#dictStatus'); if (!q) { clearInterval(dictTimer); return; } if (--k <= 0) { clearInterval(dictTimer); applyDictation(); } else q.textContent = 'Adding in ' + k + '… (tap the box to edit)'; }, 1000); }
      else if (/Listening/.test(s.textContent)) s.textContent = 'Didn\'t catch a shot — try again or type it.'; };
    r.start();
  } catch (e) { dictRec = null; $('#dictStatus').textContent = 'Mic unavailable — type or use keyboard mic.'; }
}
function previewDictation() {
  const items = parseDictation($('#dictTxt').value, dictHole), st = hs(dictHole);
  let k = counted(st);
  $('#dictPrev').innerHTML = items.length ? items.map(it => it.g
    ? `<div class="shot"><span class="n g">G</span><span class="t">${esc(it.g.kind)} ${esc(it.g.note)} — ${it.p != null ? esc(S.players[it.p]) : 'team'}</span></div>`
    : `<div class="shot"><span class="n">${++k}</span><span class="t">${esc(it.t || '(auto)')} — ${it.p != null ? esc(S.players[it.p]) : (S.mode === 'scramble' ? '<span class="warnTxt">who?</span>' : 'me')}</span></div>`).join('')
    : '<div class="mut small">Nothing recognized yet. Use player names + drive / approach / chip / putt / mulligan / string.</div>';
}
function openDictateSheet(txt) {
  if (!$('#dictTxt')) dictHole = viewHole; // the hole the sheet was opened on, even if GPS moves the round on
  modal(`<h3 style="margin:0 0 6px">🎙 Dictate shots — Hole ${dictHole}</h3>
    <div id="dictStatus" class="small mut"></div>
    <textarea id="dictTxt" rows="3" placeholder="Drew drive, Chris approach, Travis chip, Mike made the putt">${esc(txt)}</textarea>
    <div id="dictPrev" style="margin:8px 0"></div>
    <div class="row"><button onclick="stopDictation();closeModal()">Cancel</button><button onclick="startDictation()">🎙 Again</button><button class="pri" onclick="applyDictation()">Add</button></div>`);
  $('#dictTxt').addEventListener('input', () => { clearInterval(dictTimer); previewDictation(); }); previewDictation();
}
function applyDictation() {
  clearInterval(dictTimer); stopDictRec();
  const n = dictHole != null ? dictHole : viewHole, items = parseDictation($('#dictTxt').value, n);
  items.forEach(it => logShot(n, it.p, it.t, it.g));
  closeModal();
}

/* ---------------- modal helpers ---------------- */
function modal(html) { $('#modal').innerHTML = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="sheet">${html}</div></div>`; }
function closeModal() { $('#modal').innerHTML = ''; clearInterval(dictTimer); stopDictRec(); } // closing the dictation sheet also stops the mic
function gimmickSheet() {
  const pl = S.mode === 'scramble' ? `<label>Whose? (optional)</label><select id="gP"><option value="">Team</option>${S.players.map((p, i) => p ? `<option value="${i}">${esc(p)}</option>` : '').join('')}</select>` : '';
  modal(`<h3 style="margin:0 0 6px">Scramble gimmick — Hole ${viewHole}</h3>
    <div class="grid3">${['Mulligan', 'String', 'Throw', 'Kick', 'Re-tee', 'Other'].map(k => `<button class="gk" onclick="document.querySelectorAll('.gk').forEach(b=>b.classList.remove('on'));this.classList.add('on');window._gk='${k}'">${k}</button>`).join('')}</div>
    ${pl}<label>Note (e.g. "4 ft of string to tap in", "mulligan off the tee")</label><input id="gN">
    <label><input type="checkbox" id="gC" style="width:auto"> Counts as a stroke</label>
    <div class="row" style="margin-top:10px"><button onclick="closeModal()">Cancel</button><button class="pri" onclick="addGimmick()">Add</button></div>`);
  window._gk = 'Mulligan'; document.querySelector('.gk').classList.add('on');
}
function addGimmick() {
  const p = $('#gP') && $('#gP').value !== '' ? +$('#gP').value : null;
  logShot(viewHole, p, null, {kind: window._gk, note: $('#gN').value.trim(), counts: $('#gC').checked});
  closeModal();
}

/* ---------------- map ---------------- */
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CachedTiles = L.TileLayer.extend({ // satellite tiles are saved on the phone: instant on revisit, works with no signal
  createTile(coords, done) {
    const img = document.createElement('img'); img.alt = ''; img.setAttribute('role', 'presentation');
    const url = this.getTileUrl(coords);
    (async () => {
      try {
        const c = await caches.open('bcgps-tiles'); let r = await c.match(url);
        if (!r) { r = await fetch(url); if (!r.ok) throw new Error('bad'); c.put(url, r.clone()); }
        const u = URL.createObjectURL(await r.blob());
        img.onload = img.onerror = () => { URL.revokeObjectURL(u); done(null, img); }; img.src = u;
      } catch (e) { img.onload = img.onerror = () => done(null, img); img.src = url; }
    })();
    return img;
  }
});
function tileXY(lat, lon, z) { const n = 2 ** z, r = lat * Math.PI / 180; return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)]; }
function courseTiles() {
  let a = 90, b = -90, c = 180, d = -180;
  Object.keys(C.courses).filter(cn => clubOf(cn) === clubOf(course())).forEach(cn => C.courses[cn].holes.forEach(h => h.line.concat(h.green).forEach(p => { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); })));
  a -= .002; b += .002; c -= .0025; d += .0025;
  const out = [];
  for (let z = 15; z <= 19; z++) { const t1 = tileXY(b, c, z), t2 = tileXY(a, d, z); for (let x = t1[0]; x <= t2[0]; x++) for (let y = t1[1]; y <= t2[1]; y++) out.push(TILE_URL.replace('{z}', z).replace('{y}', y).replace('{x}', x)); }
  return out;
}
let offBusy = false;
async function downloadOffline() {
  if (offBusy) return;
  const list = courseTiles();
  if (!confirm('Save the satellite map of ' + club().name + ' on this phone (about ' + Math.round(list.length * 0.022) + ' MB, ' + list.length + ' tiles)? Best on Wi-Fi.')) return;
  offBusy = true; const st = $('#offStat'); let done = 0, fail = 0;
  try {
    const c = await caches.open('bcgps-tiles'); let i = 0;
    const worker = async () => { while (i < list.length) { const u = list[i++]; try { if (!(await c.match(u))) { const r = await fetch(u); if (!r.ok) throw new Error('bad'); await c.put(u, r); } } catch (e) { fail++; } done++; if (st && done % 10 === 0) st.textContent = 'Saving… ' + Math.round(done / list.length * 100) + '%'; } };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    if (!fail) { try { localStorage.setItem(offKey(clubOf(course())), String(Date.now())); } catch (e) {} }
    if (st) st.textContent = fail ? 'Saved with ' + fail + ' missing tiles — try again on better signal.' : '✅ Saved for offline use.';
  } catch (e) { if (st) st.textContent = 'Could not save maps on this device.'; }
  offBusy = false;
}
function offKey(k) { return k === 'bc' ? 'bc_offline' : 'bc_offline_' + k; } // Bear Creek keeps its old key
function offlineStatus() { let t = null; try { t = localStorage.getItem(offKey(clubOf(course()))); } catch (e) {} return t ? '✅ Saved ' + new Date(+t).toLocaleDateString([], {month: 'short', day: 'numeric'}) : 'Not saved yet'; }
function initMap() {
  if (map) return;
  map = L.map('map', {zoomControl: false, attributionControl: true, tap: true, maxZoom: 21, rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false, rotateControl: false, compassBearing: false});
  new CachedTiles(TILE_URL, {maxNativeZoom: 19, maxZoom: 21, attribution: 'Esri, Maxar · © OpenStreetMap'}).addTo(map);
  layers = L.layerGroup().addTo(map);
  map.on('click', e => onMapTap([e.latlng.lat, e.latlng.lng]));
  map.on('contextmenu', e => { target = [e.latlng.lat, e.latlng.lng]; render(); });
}
function onMapTap(p) {
  if (tapMode === 'target') target = p;
  else if (tapMode === 'pin') { if (!S) { alert('Start a round to set pins.'); return; } hs(viewHole).pin = p; save(); tapMode = 'target'; }
  else if (tapMode === 'me') { manualMe = p; tapMode = 'target'; }
  render();
}
let holeUp = (load(LS_PREF) || {}).holeUp !== false, flying = null;
function holeBearing(h) { return bearing(teePos(h), greenC(h)); }
// fit points into the map with the map rotated so the hole runs bottom (tee) -> top (green)
function fitRotated(pts, b) {
  const sz = map.getSize();
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9; const o = pts[0], t = toRad(b);
  pts.forEach(p => { const v = xy(p, o), x = v[0] * Math.cos(t) - v[1] * Math.sin(t), y = v[0] * Math.sin(t) + v[1] * Math.cos(t); minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); });
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, ctr = fromXY([cx * Math.cos(t) + cy * Math.sin(t), -cx * Math.sin(t) + cy * Math.cos(t)], o);
  const w = Math.max(20, maxx - minx), hgt = Math.max(20, maxy - miny);
  const mpp = Math.max(w / Math.max(50, sz.x - 40), hgt / Math.max(50, sz.y - 40));
  const z = Math.min(19, Math.log2(156543.03 * Math.cos(toRad(ctr[0])) / mpp));
  map.setView(ctr, z, {animate: false});
}
function fitHole(force) {
  if (!map || flying) return;
  const h = H(viewHole), pts = h.line.concat(h.green).concat([teePos(h)]);
  const m = me(); if (m && lineDist(m, h.line) < 250) pts.push(m);
  if (force || mapHole !== viewHole) {
    const b = holeUp ? holeBearing(h) : 0;
    if (map.setBearing) map.setBearing(-b);
    if (holeUp && map.setBearing) fitRotated(pts, b); else map.fitBounds(L.latLngBounds(pts), {padding: [24, 24], maxZoom: 19});
    mapHole = viewHole;
  }
}
function toggleHoleUp() { holeUp = !holeUp; const p = load(LS_PREF) || {}; p.holeUp = holeUp; try { localStorage.setItem(LS_PREF, JSON.stringify(Object.assign(pref, {holeUp}))); } catch (e) {} fitHole(true); render(); }
function flyover() { // tee -> green fly-along, then back to the whole hole
  if (!map) return;
  if (flying) { clearTimeout(flying); flying = null; fitHole(true); return; }
  const h = H(viewHole), path = backLine(h).slice(0, -1).reverse(), tee = teePos(h), total = distM(tee, greenC(h));
  const b = holeBearing(h); if (map.setBearing) map.setBearing(holeUp ? -b : 0);
  const stops = []; for (let d = 0; d <= total; d += 35) stops.push(along([tee].concat(path.slice(1)), d)); stops.push(greenC(h));
  let i = 0;
  const step = () => {
    if (!map) { flying = null; return; } // the map was torn down (tab change) mid-flight
    if (i >= stops.length) { flying = setTimeout(() => { flying = null; fitHole(true); }, 1800); return; }
    map.setView(stops[i], i === stops.length - 1 ? 19.5 : 18, {animate: true, duration: 0.5}); i++;
    flying = setTimeout(step, 520);
  };
  map.setView(stops[0], 18, {animate: false}); flying = setTimeout(step, 400);
}
function killMap() { if (flying) { clearTimeout(flying); flying = null; } if (map) { map.remove(); map = null; mapHole = null; } } // a pending flyover must die with the map, or fitHole stays locked
const icon = (cls, html) => L.divIcon({className: '', html: `<div class="${cls}">${html || ''}</div>`, iconSize: null});
function drawMap() {
  initMap(); layers.clearLayers();
  const h = H(viewHole), pin = pinOf(viewHole), from = posFor(viewHole);
  (h.fw || []).forEach(f => L.polygon(f, {color: '#7fdc8f', weight: 1, fillOpacity: .05, interactive: false}).addTo(layers));
  (h.cr || []).forEach(p => L.polygon(p, {color: '#58a8ff', weight: 1, fillColor: '#58a8ff', fillOpacity: .35, interactive: false}).addTo(layers)); // creek shown full length only on holes it affects
  h.hz.forEach(z => L.polygon(z.p, {color: z.t === 'b' ? '#f3dc9b' : '#58a8ff', weight: 2, fillOpacity: .15, interactive: false}).addTo(layers));
  L.polygon(h.green, {color: '#fff', weight: 2, fillOpacity: .08, interactive: false}).addTo(layers);
  L.polyline(h.line, {color: '#fff', weight: 1.5, dashArray: '4 6', opacity: .7, interactive: false}).addTo(layers);
  teesOf(course()).forEach(t => { const p = teePos(h, t); L.circleMarker(p, {radius: 5, color: '#000', weight: 1, fillColor: TEE_COL[t], fillOpacity: 1, interactive: false}).addTo(layers); });
  [100, 150, 200, 250].forEach(y => { const p = along(backLine(h), y / YD); if (yds(from, greenC(h)) > y + 10) { L.marker(p, {icon: icon('dot'), interactive: false}).addTo(layers); L.marker(p, {icon: icon('lay', y), interactive: false}).addTo(layers); } });
  { const li = layupInfo(from, viewHole);
    if (li.corner) L.circleMarker(li.corner.p, {radius: 7, color: '#fff', weight: 2, fillColor: '#5aa9ef', fillOpacity: .9, interactive: false}).addTo(layers);
    if (li.layup) { L.circleMarker(li.layup.p, {radius: 7, color: '#000', weight: 2, fillColor: '#f0b43c', fillOpacity: .95, interactive: false}).addTo(layers); } }
  L.marker(pin, {icon: icon('flag', '⛳'), interactive: false}).addTo(layers);
  L.marker(from, {icon: icon('me'), interactive: false}).addTo(layers);
  if (gps && onCourse(gps.p) && !manualMe) L.circle(gps.p, {radius: gps.acc, color: '#2f8cff', weight: 1, fillOpacity: .08, interactive: false}).addTo(layers);
  if (target) {
    L.polyline([from, target, pin], {color: '#f0b43c', weight: 3, interactive: false}).addTo(layers);
    L.marker(target, {icon: icon('tgt'), interactive: false}).addTo(layers);
    const m1 = [(from[0] + target[0]) / 2, (from[1] + target[1]) / 2], m2 = [(target[0] + pin[0]) / 2, (target[1] + pin[1]) / 2];
    L.marker(m1, {icon: icon('lbl y', Math.round(yds(from, target))), interactive: false}).addTo(layers);
    L.marker(m2, {icon: icon('lbl', Math.round(yds(target, pin))), interactive: false}).addTo(layers);
  } else L.polyline([from, pin], {color: '#ffffff', weight: 2, opacity: .6, interactive: false}).addTo(layers);
  // shots
  if (S && S.holes[viewHole]) { // shot trail: tee → each ball
    const trail = [teePos(h)];
    S.holes[viewHole].shots.forEach(s => { if (s.pos && (!s.g || s.g.counts) && !s.gimme) { trail.push(s.pos); L.circleMarker(s.pos, {radius: 5, color: '#fff', weight: 1, fillColor: '#ff9900', fillOpacity: 1, interactive: false}).addTo(layers); } });
    if (trail.length > 1) L.polyline(trail, {color: '#ff9900', weight: 2, dashArray: '2 5', interactive: false}).addTo(layers);
  }
  fitHole(false);
}

/* ---------------- hazards ---------------- */
function layupInfo(from, n) {
  const h = H(n), pin = pinOf(n), D = yds(from, pin), L0 = pref.layup || 100, out = {};
  if (h.par > 3 && D > L0 + 40) { const lp = along(backLine(h), L0 / YD); if (yds(from, lp) > 30) out.layup = {p: lp, leave: L0, d: yds(from, lp), pl: playsLike(from, lp).total}; } // nobody lays up on a par 3
  const l = h.line, v0 = xy(pin, from), Lv = Math.hypot(v0[0], v0[1]) || 1;
  for (let i = 1; i < l.length - 1; i++) {
    const b1 = bearing(l[i - 1], l[i]), b2 = bearing(l[i], l[i + 1]); let turn = ((b2 - b1 + 540) % 360) - 180;
    if (Math.abs(turn) < 15) continue;
    const cv = xy(l[i], from), proj = (cv[0] * v0[0] + cv[1] * v0[1]) / Lv, dc = yds(from, l[i]);
    if (proj < 0 || dc < 40) continue;
    out.corner = {p: l[i], dir: turn > 0 ? 'right' : 'left', d: dc, pl: playsLike(from, l[i]).total, toPin: yds(l[i], pin)};
    break;
  }
  return out;
}
let gvCache = {k: '', html: ''}; // the slope picture only changes with hole, pin or approach direction, not with every GPS fix
function greenView(n, from) {
  const h = H(n), g = h.gz; if (!g) return '';
  const gc = greenC(h), pin = pinOf(n), b = toRad(Math.round(bearing(from, gc) / 5) * 5);
  const key = course() + ':' + n + ':' + pin[0] + ',' + pin[1] + ':' + b;
  if (gvCache.k === key) return gvCache.html;
  const R = p => { const v = xy(p, gc); return [v[0] * Math.cos(b) - v[1] * Math.sin(b), v[0] * Math.sin(b) + v[1] * Math.cos(b)]; }; // approach = up
  const poly = h.green.map(R); let mx = 0; poly.forEach(p => mx = Math.max(mx, Math.abs(p[0]), Math.abs(p[1]))); const SC = 130 / (mx + 3);
  const P = v => [(150 + v[0] * SC).toFixed(1), (150 - v[1] * SC).toFixed(1)];
  const zAt = (r, c) => g.cm[r * g.cols + c], latOf = r => g.n - (g.n - g.s) * r / (g.rows - 1), lonOf = c => g.w + (g.e - g.w) * c / (g.cols - 1);
  const cells = []; let zmin = 1e9, zmax = -1e9;
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) { const p = [latOf(r), lonOf(c)]; if (!inside(p, h.green)) continue; const z = zAt(r, c); cells.push({p, r, c, z}); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  if (cells.length < 6) return '';
  // plane fit -> overall tilt
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0; const N = cells.length;
  cells.forEach(k => { const v = xy(k.p, gc); sx += v[0]; sy += v[1]; sz += k.z; sxx += v[0] * v[0]; syy += v[1] * v[1]; sxy += v[0] * v[1]; sxz += v[0] * k.z; syz += v[1] * k.z; });
  const mx_ = sx / N, my_ = sy / N, mz = sz / N, cxx = sxx / N - mx_ * mx_, cyy = syy / N - my_ * my_, cxy = sxy / N - mx_ * my_, cxz = sxz / N - mx_ * mz, cyz = syz / N - my_ * mz;
  const det = cxx * cyy - cxy * cxy || 1, ga = (cxz * cyy - cyz * cxy) / det, gb = (cyz * cxx - cxz * cxy) / det; // cm per m = %
  const tilt = Math.hypot(ga, gb), down = [-ga, -gb], dr = [down[0] * Math.cos(b) - down[1] * Math.sin(b), down[0] * Math.sin(b) + down[1] * Math.cos(b)];
  const ang = (Math.atan2(dr[0], dr[1]) * 180 / Math.PI + 360) % 360; // 0 = away from you (back), 180 = toward you (front)
  const dirTxt = ['back', 'back-right', 'right', 'front-right', 'front', 'front-left', 'left', 'back-left'][Math.round(ang / 45) % 8];
  const col = t => { const a1 = [31, 107, 58], a2 = [216, 240, 138]; return `rgb(${a1.map((v, i) => Math.round(v + (a2[i] - v) * t)).join(',')})`; };
  const cs = Math.max(2.6, SC * 1.6);
  let svg = cells.map(k => { const q = P(R(k.p)); return `<rect x="${(q[0] - cs / 2).toFixed(1)}" y="${(q[1] - cs / 2).toFixed(1)}" width="${cs.toFixed(1)}" height="${cs.toFixed(1)}" fill="${col((k.z - zmin) / Math.max(1, zmax - zmin))}"/>`; }).join('');
  // slope arrows every ~3 m (downhill)
  const stp = 4; let arrows = '';
  cells.filter(k => k.r % stp === 1 && k.c % stp === 1 && k.r > 0 && k.c > 0 && k.r < g.rows - 1 && k.c < g.cols - 1).forEach(k => {
    const dzx = (zAt(k.r, k.c + 1) - zAt(k.r, k.c - 1)) / (2 * (g.e - g.w) * 111320 * Math.cos(toRad(gc[0])) / (g.cols - 1));
    const dzy = (zAt(k.r - 1, k.c) - zAt(k.r + 1, k.c)) / (2 * (g.n - g.s) * 110920 / (g.rows - 1));
    const sl = Math.hypot(dzx, dzy); if (sl < 0.5) return;
    const v = [-dzx / sl, -dzy / sl], vr = [v[0] * Math.cos(b) - v[1] * Math.sin(b), v[0] * Math.sin(b) + v[1] * Math.cos(b)];
    const q = P(R(k.p)), L1 = Math.min(16, 5 + sl * 3), x2 = +q[0] + vr[0] * L1, y2 = +q[1] - vr[1] * L1;
    const c = sl < 1.5 ? '#ffffff' : sl < 3 ? '#f0b43c' : '#ef6a5a';
    arrows += `<line x1="${q[0]}" y1="${q[1]}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="2" marker-end="url(#ah${c.slice(1)})"/>`;
  });
  const mk = c => `<marker id="ah${c.slice(1)}" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${c}"/></marker>`;
  const pq = P(R(pin));
  const ft = ((zmax - zmin) / 100 * 3.28084).toFixed(1);
  const html = `<div class="card"><div class="row"><b style="flex:2">🟢 Green slope — hole ${n}</b><span class="small mut" style="text-align:right">USGS 1 m lidar</span></div>
    <svg viewBox="0 0 300 300" style="width:100%;max-width:340px;display:block;margin:6px auto;background:#0b1410;border-radius:12px">
      <defs>${mk('#ffffff')}${mk('#f0b43c')}${mk('#ef6a5a')}</defs>
      ${svg}<polygon points="${poly.map(p => P(p).join(',')).join(' ')}" fill="none" stroke="#fff" stroke-width="2"/>${arrows}
      <circle cx="${pq[0]}" cy="${pq[1]}" r="6" fill="#ef6a5a" stroke="#fff" stroke-width="2"/>
      <text x="150" y="292" fill="#9fb0a6" font-size="13" text-anchor="middle">▲ you approach from here</text></svg>
    <div style="font-size:18px"><b>Falls ${dirTxt}</b> · ${tilt.toFixed(1)}% overall · ${ft} ft high-to-low</div>
    <div class="small mut">Arrows run downhill: white &lt;1.5%, yellow 1.5–3%, red &gt;3%. Lighter = higher ground.</div></div>`;
  gvCache = {k: key, html};
  return html;
}
function hazardsFrom(from, h) {
  const pin = pinOf(h.n), D = distM(from, pin), v = xy(pin, from), L0 = Math.hypot(v[0], v[1]) || 1, u = [v[0] / L0, v[1] / L0];
  const g = greenC(h), res = [];
  h.hz.forEach(z => {
    const P = z.p; if (!P || P.length < 2) return;
    const closed = P.length > 3 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]; // creeks are open lines, not rings
    // where the hazard sits along the line of play: projections of its points onto from→pin (m), and how far off the line it comes
    let pMin = 1e9, pMax = -1e9, sMin = 1e9;
    P.forEach(q => { const w = xy(q, from), pr = w[0] * u[0] + w[1] * u[1]; pMin = Math.min(pMin, pr); pMax = Math.max(pMax, pr); sMin = Math.min(sMin, Math.abs(u[0] * w[1] - u[1] * w[0])); });
    if (pMax < 0 || pMin > D + 25 || sMin > 80) return; // entirely behind you, well past the pin, or far off to the side
    if (closed && inside(from, P)) return; // standing in it
    // where the line of play crosses it (this side of the pin): reach = where you enter it, carry = where you are over it
    const hits = rayHits(from, pin, P).filter(s => s <= D + 25);
    const nearM = closed ? polyNear(from, P) : lineDist(from, P);
    let reachM, carryM;
    if (hits.length) { reachM = hits[0]; carryM = hits.length > 1 ? hits[1] : (closed ? null : hits[0]); } // a lake crossed twice: the first pair; a creek line: one number
    else { reachM = nearM; carryM = pMax <= D + 25 ? Math.max(nearM, pMax) : null; } // beside the line: carry = past its far end, none if it runs past the pin
    const reach = reachM * YD, carry = carryM == null ? null : carryM * YD;
    if (reach > 300) return; // only hazards within 300 yards
    const near = distM(centroid(P), g) < 35;
    const rp = hits.length ? fromXY([u[0] * reachM, u[1] * reachM], from) : nearestPt(from, P), cp = carryM == null ? null : fromXY([u[0] * carryM, u[1] * carryM], from);
    const rw = rp ? xy(rp, from) : [0, 0], side = u[0] * rw[1] - u[1] * rw[0];
    const lat = hits.length || Math.abs(side) < 8 ? 'center' : side > 0 ? 'left' : 'right';
    res.push({name: (z.t === 'b' ? 'Bunker' : 'Water') + ' ' + (near ? (lat === 'center' ? 'front of green' : 'green ' + lat) : lat), reach, carry, reachPl: rp ? playsLike(from, rp).total : reach, carryPl: cp ? playsLike(from, cp).total : null, t: z.t});
  });
  return res.sort((a, b) => a.reach - b.reach).slice(0, 8);
}

/* ---------------- rendering ---------------- */
let lastView = '';
function render() {
  if (!C) return;
  const vk = tab + '-' + viewHole + '-' + (S ? (S.preview ? 'p' : 's') : 'n');
  if (vk !== lastView) { lastView = vk; const m = $('#main'); if (m) setTimeout(() => { m.scrollTop = 0; }, 0); }
  renderHeader(); renderBanner();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  if (tab === 'hole') renderHole(); else { killMap(); if (tab === 'card') renderCard(); else if (tab === 'pins') renderPins(); else renderInfo(); }
}
function renderHeader() {
  $('#hdrSub').innerHTML = S && S.name ? `<b style="color:var(--fg)">${esc(S.name)}</b><br>${course()} · ${tee()}` : `${course()} · ${tee()} tees${S ? ' · ' + (S.mode === 'scramble' ? 'Scramble' : 'Solo') : ''}`;
  if (S && S.started) {
    const t = totals(), pi = paceInfo();
    $('#clock').innerHTML = `<b>${fmtDur((S.ended || Date.now()) - S.started)}</b> · <span class="${relCls(t.r)}">${relStr(t.thru ? t.r : null)}</span>${t.thru ? ' thru ' + t.thru : ''}<br>hole ${fmtDur(holeTime(S.cur))}${pi && pi.done ? ` · <span class="${pi.diff > 3 ? 'over' : 'under'}">${pi.diff > 0 ? pi.diff + 'm behind' : Math.abs(pi.diff) + 'm ahead'}</span>` : ''}`;
  } else $('#clock').innerHTML = new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}
function renderBanner() {
  let html = '';
  if (saveErr) html += `<div class="banner" style="background:var(--bad);color:#fff"><span style="flex:1">⚠️ Phone storage is full — scores are NOT being saved. Delete old rounds or the pin photo.</span></div>`;
  if (bootErr) html += `<div class="banner"><span style="flex:1">${esc(bootErr)}</span><button class="sm" onclick="bootErr='';render()">✕</button></div>`;
  if (S && S.started && !S.ended && !$('#modal').innerHTML) { // every hole already left behind with no score: the first one gets the reminder
    const i = S.order.indexOf(S.cur), miss = S.order.slice(0, Math.max(0, i)).filter(n => { const st = S.holes[n]; return !st || (!st.done && !st.manual); });
    if (miss.length) html += `<div class="banner"><span style="flex:1">Hole ${miss[0]} has no score yet${miss.length > 1 ? ' (+' + (miss.length - 1) + ' more)' : ''}</span><button class="sm" onclick="scorePrompt(${miss[0]})">Enter</button></div>`;
  }
  if (S && S.started && !S.ended && S.gpsHole && S.gpsHole !== S.cur && !(S.holes[S.gpsHole] || {}).done && gps && onCourse(gps.p)) {
    html += `<div class="banner"><span style="flex:1">GPS says you're on hole ${S.gpsHole}</span><button class="sm" onclick="goHole(${S.gpsHole},true)">Switch</button><button class="sm" onclick="S.gpsHole=S.cur;save();render()">✕</button></div>`;
  }
  $('#banner').innerHTML = html;
}
function goHole(n, makeCur) { if (n !== viewHole) manualMe = null; viewHole = n; target = null; if (makeCur && S) { S.cur = n; const st = hs(n); if (!st.startTs) st.startTs = Date.now(); save(); } render(); fitHole(true); }
function stepHole(d) { const ord = S ? S.order : [...Array(18)].map((_, i) => i + 1); const i = ord.indexOf(viewHole); goHole(ord[(i + d + 18) % 18], false); }

function liveHtml(part) {
  const n = viewHole, h = H(n), st = hs(n), from = posFor(n), pin = pinOf(n);
  const fb = (() => { const hits = rayHits(from, pin, h.green); if (inside(from, h.green)) return {f: 0, b: polyFar(from, h.green) * YD}; if (hits.length >= 2) return {f: hits[0] * YD, b: hits[hits.length - 1] * YD}; return {f: polyNear(from, h.green) * YD, b: polyFar(from, h.green) * YD}; })();
  const pl = playsLike(from, pin), mid = yds(from, pin);
  const gpsOn = !manualMe && gps && onCourse(gps.p) && onThisHole(n, gps.p) && Date.now() - gps.ts < gpsMaxAge();
  const hz = hazardsFrom(from, h);
  if (part === 'top') {
    // the big card says plainly where its number is measured from: a live fix, a spot you tapped, or the tee because GPS is missing, stale or on another hole
    const noFix = !!(S && S.started && !gpsOn && !manualMe);
    const lab = gpsOn ? '<span class="liveDot"></span>Live distance' : manualMe ? 'From your tapped spot' : 'From the tee · ' + (!gps ? 'no GPS' : Date.now() - gps.ts >= gpsMaxAge() ? 'GPS stale' : 'other hole');
    const wxTxt = wx ? (wx.aged ? `weather ${wx.ageMin}m old` : 'wind ' + (pl.head > 2 ? 'into' : pl.head < -2 ? 'helping' : 'cross')) : (wxErr ? 'no weather · slope only' : 'weather loading');
    const z = hz[0], hzTxt = z ? ` · ${z.t === 'b' ? '🟨' : '🟦'} <b>${Math.round(z.reach)}</b>${z.carry != null ? '/' + Math.round(z.carry) : ''}` : '';
    const tgt = target ? `<div class="strip aim"><span>🎯 to target <b>${Math.round(yds(from, target))}</b> · then <b>${Math.round(yds(target, pin))}</b> to the pin</span><button class="sm" onclick="target=null;render()">✕</button></div>` : '';
    return (NATIVE ? `<div class="row" style="padding:6px 12px 0;gap:6px"><span class="small mut" style="flex:0 0 auto">GPS source</span><button class="sm ${gpsSrc === 'phone' ? 'on' : ''}" onclick="setGpsSource('phone')">📱 Phone</button><button class="sm ${gpsSrc === 'watch' ? 'on' : ''}" onclick="setGpsSource('watch')">⌚ Watch${watchPaired ? '' : ' (not linked)'}</button></div>` : '') + `  <div class="dist big ${noFix ? 'nogps' : ''}" style="margin-top:6px"><div class="mid"><div class="lab">${lab}${noFix ? '' : ' · ' + (st.pin ? 'pin' : 'middle')}</div><div class="num">${Math.round(mid)}</div><div class="small mut">yards</div></div>
    <div class="pls"><div class="lab">Plays like</div><div class="num">${Math.round(pl.total)}</div><div class="small mut">${pl.dh != null ? (pl.dh >= 0 ? '▲' : '▼') + Math.abs(Math.round(pl.dh)) + ' ft · ' : ''}${wxTxt}</div></div></div>
  <div class="strip"><span>H${n} · Par ${h.par} · F <b>${Math.round(fb.f)}</b> · B <b>${Math.round(fb.b)}</b>${hzTxt}</span></div>${tgt}
`; // the big numbers need none of the layup / weather work below
  }
  let tgtHtml = '';
  if (target) {
    const a = playsLike(from, target), b = playsLike(target, pin);
    tgtHtml = `<div class="card"><div class="row" style="align-items:flex-start"><div><div class="mut small">TO TARGET</div><div style="font-size:30px;font-weight:800">${Math.round(a.d)}<span class="small mut"> yd</span></div><div class="warnTxt" style="font-weight:700">plays ${Math.round(a.total)}</div></div>
      <div><div class="mut small">TARGET → PIN</div><div style="font-size:30px;font-weight:800">${Math.round(b.d)}<span class="small mut"> yd</span></div><div class="warnTxt" style="font-weight:700">plays ${Math.round(b.total)}</div></div>
      <button class="sm" style="flex:0" onclick="target=null;render()">✕</button></div><div class="chips">${plChips(a)}</div></div>`;
  }
  const c = wx && wx.current;
  const wxHtml = c ? (() => { const rel = c.wind_direction_10m - bearing(from, pin) + 180; return `<span class="chip">🌡 <b>${Math.round(c.temperature_2m)}°</b></span><span class="chip">💨 <b>${Math.round(c.wind_speed_10m)}</b> mph ${compass(c.wind_direction_10m)} (gust ${Math.round(c.wind_gusts_10m)}) <span class="windArrow" style="transform:rotate(${rel}deg)">⬆</span> ${pl.head > 2 ? '<b>into</b>' : pl.head < -2 ? '<b>helping</b>' : 'cross'}</span><span class="chip">💧 ${c.relative_humidity_2m}%</span><span class="chip">${Math.round(c.surface_pressure)} hPa</span><span class="chip">🔄 ${wxAge()}</span>`; })() : `<span class="chip">${wxErr || 'loading weather…'}</span>`;
  return `  <div class="small mut" style="padding:4px 12px">${posLabel()}${tapMode !== 'target' ? ` — <b class="warnTxt">tap the map to place ${tapMode === 'pin' ? 'the pin' : 'yourself'}</b>` : ' — tap map to measure'}</div>
  <div class="dist"><div><div class="lab">Front</div><div class="num sm2">${Math.round(fb.f)}</div><div class="pl">plays ${Math.round(fb.f + (pl.total - pl.d))}</div></div>
    <div><div class="lab">Back</div><div class="num sm2">${Math.round(fb.b)}</div><div class="pl">plays ${Math.round(fb.b + (pl.total - pl.d))}</div></div></div>
  <div style="padding:0 12px"><div class="chips">${plChips(pl)}</div><div class="chips">${wxHtml}</div></div>
  ${tgtHtml}
  ${(() => { const li = layupInfo(from, n); if (!li.layup && !li.corner) return ''; return `<div class="card">${li.corner ? `<div class="hz"><span>↪️ Dogleg ${li.corner.dir} — to the corner</span><span><b>${Math.round(li.corner.d)}</b> <span class="warnTxt">(${Math.round(li.corner.pl)})</span></span></div><div class="small mut" style="margin:-4px 0 4px">${Math.round(li.corner.toPin)} from the corner to the pin</div>` : ''}${li.layup ? `<div class="hz"><span>🎯 Lay up to leave ${li.layup.leave}</span><span><b>${Math.round(li.layup.d)}</b> <span class="warnTxt">(${Math.round(li.layup.pl)})</span></span></div>` : ''}</div>`; })()}
  ${hz.length ? `<div class="card"><div class="mut small" style="margin-bottom:2px">HAZARDS WITHIN 300 — reach / carry <span class="warnTxt">(plays like)</span></div>${hz.map(z => `<div class="hz"><span>${z.t === 'b' ? '🟨' : '🟦'} ${z.name}</span><span><b>${Math.round(z.reach)}</b> <span class="warnTxt">(${Math.round(z.reachPl)})</span> <span class="k">/</span> ${z.carry != null ? `<b>${Math.round(z.carry)}</b> <span class="warnTxt">(${Math.round(z.carryPl)})</span>` : '<span class="mut">—</span>'}</span></div>`).join('')}</div>` : ''}
  ${h.note ? `<div class="card small">📝 ${esc(h.note)}</div>` : ''}
  ${mid <= 60 ? greenView(n, posFor(n)) : ''}
`; // the green-slope picture only matters from inside ~60 yd; from the tee it just pushes the shot buttons down
}
let lastLiveHtml = '', lastTopHtml = '';
function liveUpdate() { // called on every GPS fix: refresh numbers + map overlays, keep the rest of the screen untouched
  if (document.hidden) { if (S && NATIVE) pushNativeState(); return; } // screen locked / app backgrounded: skip all drawing, just feed the lock screen + Watch
  if (tab !== 'hole' || !S || !$('#live')) return;
  // only rewrite what changed: replacing the DOM under a finger swallows the tap (GPS source buttons, target ✕)
  const a = liveHtml(), b = liveHtml('top');
  if (a !== lastLiveHtml) { lastLiveHtml = a; $('#live').innerHTML = a; }
  if (b !== lastTopHtml) { lastTopHtml = b; $('#liveTop').innerHTML = b; }
  renderBanner(); pushNativeState();
  // the map only redraws when you've moved ~3 yd (or every 15 s): saves battery over a round
  const p = posFor(viewHole), now = Date.now();
  if (!lastDraw.p || lastDraw.h !== viewHole || yds(p, lastDraw.p) > 3 || now - lastDraw.t > 15000) { drawMap(); lastDraw = {t: now, p, h: viewHole}; }
}
let lastDraw = {t: 0, p: null, h: null};
function renderHole() {
  if (!S) { renderSetup(); return; }
  const n = viewHole, h = H(n), st = hs(n);
  const r = rel(n);
  const order = S.order, idx = order.indexOf(n);
  const players = S.mode === 'scramble'
    ? `<div class="mut small" style="margin-top:4px">Whose shot did the team use? (stroke ${counted(st) + 1})</div><div class="players">${S.players.map((p, i) => p ? `<button onclick="logShot(${n},${i})">${esc(p)}</button>` : '').join('')}</div>`
    : `<div class="players"><button onclick="logShot(${n},null)">+ Shot (${counted(st) + 1})</button><button onclick="logShot(${n},null,null,{kind:'Penalty',note:'',counts:true})">+ Penalty</button></div>`;
  const shots = st.shots.map((s, i) => {
    const k = st.shots.slice(0, i + 1).filter(x => !x.g || x.g.counts).length, dd = shotDist(n, i);
    return s.g ? `<div class="shot"><span class="n g">G</span><span class="t">${esc(s.g.kind)}${s.g.note ? ' — ' + esc(s.g.note) : ''}${s.p != null && S.players[s.p] ? ' · ' + esc(S.players[s.p]) : ''}${s.g.counts ? ' <b>(+1 stroke)</b>' : ''}</span><button class="x" onclick="delShot(${n},${i})">✕</button></div>`
      : `<div class="shot"><span class="n">${k}</span><span class="t"><select style="width:auto;padding:2px 4px" onchange="hs(${n}).shots[${i}].t=this.value;save()">${['Drive', 'Tee shot', 'Second', 'Approach', 'Chip', 'Putt'].map(o => `<option ${o === s.t ? 'selected' : ''}>${o}</option>`).join('')}</select> ${s.gimme ? '<b class="warnTxt">Gimme</b> (no one)' : S.mode === 'scramble' ? '— <b>' + esc(s.p != null ? S.players[s.p] : 'Team') + '</b>' : ''}${dd ? ' · <b style="color:var(--acc)">' + dd + '</b>' : ''}</span><button class="x" onclick="delShot(${n},${i})">✕</button></div>`;
  }).join('');
  const topHtml = `
  <div class="holebar"><button onclick="stepHole(-1)">◀</button>
    <div class="h"><b>Hole ${n}</b> · Par ${h.par} · Hcp ${h.hcp}<div class="small mut">${h.yds[tee()]} yds (${tee()})${n === S.cur ? '' : ` · <a style="color:var(--acc)" onclick="goHole(${n},true)">make current</a>`}</div></div>
    <button onclick="stepHole(1)">▶</button></div>
  `;
  const bodyHtml = `
  <div class="tapmodes"><button class="sm ${tapMode === 'target' ? 'on' : ''}" onclick="tapMode='target';render()">🎯 Target</button><button class="sm ${tapMode === 'pin' ? 'on' : ''}" onclick="tapMode='pin';render()">⛳ Set pin</button><button class="sm ${tapMode === 'me' ? 'on' : ''}" onclick="if(manualMe){manualMe=null;tapMode='target'}else tapMode='me';render()">📍 ${manualMe ? 'Use GPS' : 'Me'}</button><button class="sm" onclick="fitHole(true)">⤢</button><button class="sm ${holeUp ? 'on' : ''}" onclick="toggleHoleUp()" title="Hole-up map">⬆︎</button><button class="sm" onclick="flyover()" title="Flyover">🎬</button></div>
  <div id="live">${(lastLiveHtml = liveHtml())}</div>
  ${S.preview ? `<div class="card"><b>Preview mode</b> — browsing holes only.<button class="pri" style="width:100%;margin-top:8px" onclick="S=null;render()">◀ Back to round setup</button></div>` : `<div class="card">
    <div class="row"><b style="flex:2">${S.mode === 'scramble' ? '👥 Team shots' : 'Shots'} · Hole ${n}</b><button class="sm" onclick="startDictation()">🎙 Dictate</button>${S.mode === 'scramble' ? '<button class="sm" onclick="gimmickSheet()">🎲 Gimmick</button>' : ''}</div>
    ${players}
    <div style="margin-top:8px">${shots || '<div class="mut small">No shots yet. After each shot, walk or drive to the ball you are playing next, then tap whose shot it was — the distance is measured from the tee or the last ball.</div>'}</div>
    ${(() => { const live = !st.done && !st.manual, c = counted(st); // mid-hole: strokes so far, not a ± that reads like a final score
      const big = live ? (c ? String(c) : '—') : (r == null ? 'E' : relStr(r));
      const sub = live ? (c ? `stroke${c > 1 ? 's' : ''} so far · par ${h.par} · tap ± to set the score` : 'no strokes yet · tap ± to set the score') : `${h.par + r} strokes${st.manual && c ? ' · <span class="warnTxt">override (' + c + ' logged)</span>' : ''}`;
      return `<div class="score"><button class="pm" onclick="bump(-1)">−</button><div class="val"><div class="rel ${live ? '' : relCls(r)}">${big}</div><div class="small mut">${sub}</div></div><button class="pm" onclick="bump(1)">+</button></div>`; })()}
    ${(() => { const s = holeStats(S, n) || {putts: 0, gir: null, fir: null}; const b = (on, txt, fn) => `<button class="sm ${on ? 'on' : ''}" onclick="${fn}">${txt}</button>`;
      return `<div style="margin-top:10px;font-size:16px">${h.par >= 4 ? `<div class="row" style="margin-bottom:6px"><span style="flex:0 0 74px">Fairway</span>${b(s.fir === 'L', '⬅ Left', `setStat(${n},'fir','L')`)}${b(s.fir === 'hit', '✓ Hit', `setStat(${n},'fir','hit')`)}${b(s.fir === 'R', 'Right ➡', `setStat(${n},'fir','R')`)}</div>` : ''}
        <div class="row" style="margin-bottom:6px"><span style="flex:0 0 74px">Green in reg</span>${b(s.gir === true, '✓ Yes', `setStat(${n},'gir',true)`)}${b(s.gir === false, '✗ No', `setStat(${n},'gir',false)`)}</div>
        <div class="row"><span style="flex:0 0 74px">Putts</span><button class="sm" onclick="bumpPutts(-1)">−</button><b style="text-align:center;font-size:22px">${s.putts}</b><button class="sm" onclick="bumpPutts(1)">+</button></div>
        <div class="small mut" style="margin-top:4px">Filled in automatically from your shots — tap to correct.</div></div>`; })()}
    <button style="width:100%;margin-top:10px;padding:12px;background:#3a3216;color:var(--warn);font-weight:700" onclick="gimme()">👌 Gimme — add the final stroke &amp; close hole ${n}</button>
    <button class="pri" style="width:100%;margin-top:8px;padding:14px" onclick="completeHole()">${st.done ? '✓ Completed — save & next' : 'Complete hole ' + n + (idx === order.length - 1 ? ' (finish round)' : '')}</button>
  </div>`}
  <div style="height:20px"></div>`;
  if (!$('#holeTop') || !$('#map') || !$('#liveTop')) {
    killMap();
    $('#main').innerHTML = '<div id="holeTop"></div><div id="liveTop"></div><div id="map" style="margin-top:8px"></div><div id="holeBody"></div>';
  }
  $('#holeTop').innerHTML = topHtml; $('#liveTop').innerHTML = (lastTopHtml = liveHtml('top')); $('#holeBody').innerHTML = bodyHtml;
  const fresh = !map;
  drawMap();
  if (fresh) setTimeout(() => { if (map) { map.invalidateSize(); fitHole(true); } }, 80);
}
function bump(d) { const n = viewHole, st = hs(n); const base = rel(n) != null ? rel(n) : 0; st.adj = base + d; st.manual = true; if (S.pendingScore === n) S.pendingScore = null; save(); render(); }
function delShot(n, i) { const st = hs(n); st.shots.splice(i, 1); st.manual = false; st.adj = null; save(); render(); } // no stale ± left behind to show as a score
function gimme() { // counted stroke, credited to no one, then close the hole
  const n = viewHole, st = hs(n); st.manual = false;
  st.shots.push({p: null, ts: Date.now(), pos: me() || null, t: 'Putt', gimme: true});
  save(); completeHole();
}

function startGrid(action, sel) {
  return `<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px">${[...Array(18)].map((_, i) => `<button class="sm ${sel === i + 1 ? 'on' : ''}" style="padding:10px 0" onclick="${action.replace('N', i + 1)}">${i + 1}</button>`).join('')}</div>`;
}
function setStart(n) { // change starting hole before play (keeps everything already logged)
  if (Object.values(S.holes).some(h => h.done)) { render(); return; } // rotating the order mid-round would skip holes
  const order = []; for (let i = 0; i < 18; i++) order.push(((n - 1 + i) % 18) + 1);
  S.order = order;
  if (!Object.values(S.holes).some(h => h.done)) { S.cur = n; viewHole = n; const st = hs(n); st.startTs = st.startTs || Date.now(); }
  save(); render();
}
function renderSetup() {
  killMap();
  const ck = clubOf(pref.course), cks = C.clubs ? Object.keys(C.clubs) : [], tv = validTee(pref.course, pref.tee);
  const tees = teesOf(pref.course).map(t => `<option ${t === tv ? 'selected' : ''}>${t}</option>`).join('');
  const clubRow = cks.length ? `<label>Club</label><div class="row">${cks.map(k => `<button class="${ck === k ? 'on' : ''}" onclick="pickClub('${k}')">${esc(clubByKey(k).short)}</button>`).join('')}</div>` : '';
  $('#main').innerHTML = `<div class="card">
    <h2 style="margin:0 0 4px">New round</h2><div class="mut small">${esc(club().name)} · ${esc(club().place)}</div>
    <label>Round name</label><input placeholder="${esc(defaultName())}" value="${esc(pref.roundName || '')}" oninput="pref.roundName=this.value;savePref()">
    ${clubRow}
    <label>Course</label><div class="row">${coursesOfClub(ck).map(c => `<button class="${pref.course === c ? 'on' : ''}" onclick="setCourse('${c}');render()">${c}</button>`).join('')}</div>
    <label>Tee box</label><select onchange="pref.tee=this.value;savePref();render()">${tees}</select>
    <div class="small mut" style="margin-top:4px">${teesOf(pref.course).map(t => `${t}: ${C.courses[pref.course].holes.reduce((a, h) => a + h.yds[t], 0)} yds`).join(' · ')}<br>Rating/slope ${esc(C.courses[pref.course].rating[tv] || '')}</div>
    <label>Format</label><div class="row">${[['scramble', '👥 Scramble (4)'], ['solo', '🙋 Just me']].map(([k, v]) => `<button class="${pref.mode === k ? 'on' : ''}" onclick="pref.mode='${k}';savePref();render()">${v}</button>`).join('')}</div>
    <label>Starting hole — shotgun start? Tap the hole your cart starts on</label>${startGrid('pref.start=N;savePref();render()', pref.start)}
    ${pref.mode === 'scramble' ? `<label>Team (names optional — leave blank to skip)</label>${[0, 1, 2, 3].map(i => `<input style="margin-bottom:6px" placeholder="Golfer ${i + 1}" value="${esc(pref.players[i] || '')}" oninput="pref.players[${i}]=this.value;savePref()">`).join('')}` : ''}
    <button class="pri" style="width:100%;margin-top:14px;padding:14px;font-size:17px" onclick="startRound()">▶ Start round</button>
    <button style="width:100%;margin-top:8px" onclick="previewCourse()">👀 Preview holes without starting</button>
  </div>
  ${(() => { const rs = Object.values(rounds()).sort((x, y) => (y.updated || 0) - (x.updated || 0)); if (!rs.length) return '';
    return `<div class="card"><b>Saved rounds</b><div class="small mut">Saved on this phone after every tap and keystroke. Resume any time.</div>${rs.map(r => { const sm = roundSummary(r);
      return `<div class="shot"><span class="t"><b>${esc(r.name)}</b><br><span class="small mut">${r.course} · ${r.tee} · ${new Date(r.started).toLocaleDateString([], {month: 'short', day: 'numeric'})} ${fmtClock(r.started)} · ${sm.thru ? relStr(sm.rr) + ' thru ' + sm.thru : 'not started'} · ${r.ended ? '✅ finished' : '<span class="warnTxt">in progress</span>'}</span></span><button class="sm ${r.ended ? '' : 'pri'}" onclick="resumeRound('${r.id}')">${r.ended ? 'Open' : 'Resume'}</button><button class="x" onclick="deleteRound('${r.id}')">🗑</button></div>`; }).join('')}</div>`; })()}
  <div class="card small mut">Tip: open this once on Wi-Fi before the round, then in Safari tap Share → <b>Add to Home Screen</b> so it opens full-screen. Allow location when asked.</div>`;
}
function setCourse(cn) { // callers re-render; switching club loads that club's elevation grid
  const was = clubOf(pref.course);
  autoClubDone = true; // a club or course you chose is not undone by the first GPS fix
  pref.course = cn; pref.tee = validTee(cn, pref.tee); savePref(); loadDEM();
  if (clubOf(cn) !== was) { wx = null; wxModel = null; wxLoading = false; loadWx(true); } // new club: its own weather
}
function pickClub(k) { const cs = coursesOfClub(k); if (cs.length) { setCourse(cs[0]); render(); } }
function startRound() {
  const order = []; for (let i = 0; i < 18; i++) order.push(((pref.start - 1 + i) % 18) + 1);
  const players = pref.mode === 'scramble' ? pref.players.map(p => (p || '').trim()) : ['Me'];
  if (pref.mode === 'scramble' && !players.some(p => p)) { players[0] = 'Golfer 1'; players[1] = 'Golfer 2'; players[2] = 'Golfer 3'; players[3] = 'Golfer 4'; }
  S = {id: 'r' + Date.now(), name: (pref.roundName || '').trim() || defaultName(), course: pref.course, tee: validTee(pref.course, pref.tee), mode: pref.mode, players, order, started: Date.now(), cur: order[0], holes: {}};
  pref.roundName = ''; savePref();
  manualMe = null; gpsCand = null; pendingScore = null; target = null;
  hs(order[0]).startTs = S.started; viewHole = order[0]; tab = 'hole'; save(); requestWake(); render(); loadWx(true);
}
function previewCourse() {
  S = {course: pref.course, tee: validTee(pref.course, pref.tee), mode: pref.mode, players: pref.mode === 'scramble' ? pref.players : ['Me'], order: [...Array(18)].map((_, i) => i + 1), started: null, cur: 1, holes: {}, preview: true};
  viewHole = 1; render();
}
function endRound() {
  if (!confirm('Finish this round? It stays saved on this phone — you can reopen it from the round list.')) return;
  const cs = S.holes[S.cur]; if (cs && !cs.done && counted(cs)) { cs.done = true; cs.endTs = Date.now(); if (!cs.startTs) cs.startTs = S.started; } // strokes on the last hole count
  S.ended = S.ended || Date.now(); save(); endLive(); S = null; manualMe = null; gpsCand = null; pendingScore = null; try { localStorage.removeItem(LS_KEY); } catch (e) {} tab = 'hole'; render();
}

let cardSel = {tee: null, hole: null};
function toggleSel(k, v) { cardSel[k] = cardSel[k] === v ? null : v; render(); }
function scorecardTable(cn, selTee, selHole, interactive) {
  const cr = C.courses[cn], hl = cr.holes, TL = teesOf(cn);
  const dot = TEE_COL;
  const cell = (n, t) => { const r = n === selHole, c = t === selTee; return r && c ? ' class="x2"' : (r || c) ? ' class="x1"' : ''; };
  const hc = n => interactive ? ` onclick="toggleSel('hole',${n})" style="cursor:pointer"` : '';
  const half = (a, b, lab) => {
    let rows = '';
    for (let n = a; n <= b; n++) { const h = hl[n - 1], r = n === selHole ? ' class="x1"' : '';
      rows += `<tr><td${r}${hc(n)}><b>${n}</b></td><td${r}>${h.par}</td><td${r}>${h.hcp}</td>${TL.map(t => `<td${cell(n, t)}>${h.yds[t]}</td>`).join('')}</tr>`; }
    const s = hl.slice(a - 1, b);
    return rows + `<tr><th>${lab}</th><th>${s.reduce((x, h) => x + h.par, 0)}</th><th></th>${TL.map(t => `<th${t === selTee ? ' class="x1"' : ''}>${s.reduce((x, h) => x + h.yds[t], 0)}</th>`).join('')}</tr>`;
  };
  return `<table class="sc"><tr><th>#</th><th>Par</th><th>Hcp</th>${TL.map(t => `<th${t === selTee ? ' class="x1"' : ''}${interactive ?` onclick="toggleSel('tee','${t}')" style="cursor:pointer"` : ''}><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dot[t]};border:1px solid #888"></span><br>${t}</th>`).join('')}</tr>
    ${half(1, 9, 'Out')}${half(10, 18, 'In')}
    <tr><th>Tot</th><th>${hl.reduce((x, h) => x + h.par, 0)}</th><th></th>${TL.map(t => `<th${t === selTee ? ' class="x1"' : ''}>${hl.reduce((x, h) => x + h.yds[t], 0)}</th>`).join('')}</tr>
    <tr><td class="small mut">R/S</td><td></td><td></td>${TL.map(t => `<td class="small mut${t === selTee ? ' x1' : ''}">${esc(cr.rating[t] || '—')}</td>`).join('')}</tr></table>`;
}
function renderStaticCard() {
  const cn = S ? S.course : pref.course, cr = C.courses[cn];
  if (cardSel.tee && !teesOf(cn).includes(cardSel.tee)) cardSel.tee = null; // tee from the other club
  const pick = cardSel.tee && cardSel.hole ? `<div class="small" style="margin-top:6px">Hole <b>${cardSel.hole}</b> from the <b>${cardSel.tee}</b> tees: <b style="color:var(--acc)">${cr.holes[cardSel.hole - 1].yds[cardSel.tee]} yds</b> · par ${cr.holes[cardSel.hole - 1].par} · hcp ${cr.holes[cardSel.hole - 1].hcp}</div>` : '';
  $('#main').innerHTML = `<div class="card"><div class="row">${coursesOfClub(clubOf(cn)).map(c => `<button class="${cn === c ? 'on' : ''}" onclick="${S ? '' : `setCourse('${c}');`}render()" ${S && S.course !== c ? 'disabled style="opacity:.4"' : ''}>${c}</button>`).join('')}</div>
    <div class="small mut" style="margin-top:6px">${esc(club().name)} — ${cn} course scorecard. Tap a tee color and a hole number to highlight them; tap again to clear.</div>${pick}</div>
  <div class="card" style="padding:6px">${scorecardTable(cn, cardSel.tee, cardSel.hole, true)}</div>
  <div class="card small">${esc(cr.blurb)}</div>`;
}
function renderCard() {
  if (!S || S.preview || !S.started) { renderStaticCard(); return; }
  const t = totals();
  const half = (a, b, lab) => {
    let pr = 0, yd = 0, sc = 0, has = false, rows = '';
    for (let n = a; n <= b; n++) { const h = H(n), r = rel(n); pr += h.par; yd += h.yds[S.tee]; if (r != null && (S.holes[n].done || S.holes[n].manual)) { sc += h.par + r; has = true; }
      const cu = n === S.cur && !S.ended ? ' class="curRow"' : ''; rows += `<tr${cu} onclick="tab='hole';goHole(${n},false)"><td><b>${n}</b></td><td>${h.par}</td><td>${h.hcp}</td><td>${h.yds[S.tee]}</td><td class="${relCls(r)}"><b>${r != null ? h.par + r : ''}</b></td><td class="${relCls(r)}">${r != null ? relStr(r) : ''}</td><td>${fmtDur(holeTime(n))}</td></tr>`; }
    return rows + `<tr><th>${lab}</th><th>${pr}</th><th></th><th>${yd}</th><th>${has ? sc : ''}</th><th></th><th></th></tr>`;
  };
  let use = '';
  if (S.mode === 'scramble') {
    const stats = S.players.map(() => ({all: 0, Drive: 0, Approach: 0, Chip: 0, Putt: 0, g: 0}));
    let team = 0, gims = [];
    Object.entries(S.holes).forEach(([n, st]) => st.shots.forEach(s => { if (s.g) { gims.push(`#${n} ${s.g.kind}${s.g.note ? ' (' + s.g.note + ')' : ''}${s.p != null ? ' · ' + S.players[s.p] : ''}`); if (s.p != null) stats[s.p].g++; return; } if (s.p == null) { team++; return; } const k = s.t === 'Tee shot' ? 'Drive' : s.t === 'Second' ? 'Approach' : s.t; stats[s.p].all++; if (stats[s.p][k] != null) stats[s.p][k]++; }));
    use = `<div class="card"><b>Shots used by golfer</b><table><tr><th class="l">Golfer</th><th>Total</th><th>Tee</th><th>Appr</th><th>Chip</th><th>Putt</th><th>Gim</th></tr>${S.players.map((p, i) => p ? `<tr><td class="l">${esc(p)}</td><td><b>${stats[i].all}</b></td><td>${stats[i].Drive}</td><td>${stats[i].Approach}</td><td>${stats[i].Chip}</td><td>${stats[i].Putt}</td><td>${stats[i].g}</td></tr>` : '').join('')}</table>
      ${gims.length ? `<div class="small" style="margin-top:8px"><b>Gimmicks used (${gims.length}):</b><br>${gims.map(esc).join('<br>')}</div>` : ''}</div>`;
  }
  const pi = paceInfo();
  $('#main').innerHTML = `<div class="card"><input value="${esc(S.name || '')}" placeholder="Round name" oninput="S.name=this.value;save();renderHeader()" style="font-weight:700;margin-bottom:8px"><div class="row"><div><div class="mut small">${S.course} · ${S.tee} · ${S.mode === 'scramble' ? 'Scramble' : 'Solo'}</div><div style="font-size:28px;font-weight:800" class="${relCls(t.r)}">${t.thru ? relStr(t.r) : 'E'} <span class="small mut">${t.thru ? t.str + ' strokes thru ' + t.thru : ''}</span></div></div></div>
    <div class="small mut">Started ${fmtClock(S.started)}${S.ended ? ' · finished ' + fmtClock(S.ended) : ''} · elapsed ${fmtDur((S.ended || Date.now()) - (S.started || Date.now()))}${pi && pi.done ? ` · pace target 4:12 → ${pi.diff > 0 ? pi.diff + ' min behind' : Math.abs(pi.diff) + ' min ahead'}` : ''}</div></div>
  <div class="card" style="padding:6px"><table><tr><th>#</th><th>Par</th><th>Hcp</th><th>Yds</th><th>Score</th><th>±</th><th>Time</th></tr>${half(1, 9, 'Out')}${half(10, 18, 'In')}</table>
    <div class="small mut" style="padding:6px">Hole time uses GPS arrival → departure when available, otherwise start → "Complete hole". Tap a row to open that hole.</div></div>
  ${(() => { const s = roundStats(S); if (!s.thru) return '';
    const past = Object.values(rounds()).filter(r => r.id !== S.id && r.order && r.started && C.courses[r.course] && clubOf(r.course) === clubOf(S.course)).map(r => ({r, s: roundStats(r)})).filter(x => x.s.thru >= 9).sort((x, y) => y.r.started - x.r.started).slice(0, 5);
    return `<div class="card"><b>📊 ${S.mode === 'scramble' ? 'Team' : 'Your'} stats</b>
      <div class="dist" style="margin:8px 0 0"><div><div class="lab">Fairways</div><div class="num sm2">${pct(s.fh, s.ft)}</div><div class="small mut">${s.fh}/${s.ft}</div></div><div><div class="lab">Greens (GIR)</div><div class="num sm2">${pct(s.gh, s.gt)}</div><div class="small mut">${s.gh}/${s.gt}</div></div><div><div class="lab">Putts</div><div class="num sm2">${s.putts}</div><div class="small mut">${(s.putts / Math.max(1, s.ph)).toFixed(1)}/hole</div></div></div>
      <div class="small" style="margin-top:8px">${s.dist.eagle ? '🦅 ' + s.dist.eagle + ' eagle · ' : ''}🐦 ${s.dist.birdie} birdie · ${s.dist.par} par · ${s.dist.bogey} bogey · ${s.dist.dbl} double+</div>
      ${past.length ? `<div style="margin-top:10px"><b>Trend — last ${past.length} round${past.length > 1 ? 's' : ''}</b><table style="margin-top:4px"><tr><th class="l">Date</th><th>Score</th><th>FIR</th><th>GIR</th><th>Putts/18</th></tr>${past.map(x => `<tr><td class="l">${new Date(x.r.started).toLocaleDateString([], {month: 'short', day: 'numeric'})}</td><td class="${relCls(x.s.rel)}">${relStr(x.s.rel)} <span class="mut small">(${x.s.thru})</span></td><td>${pct(x.s.fh, x.s.ft)}</td><td>${pct(x.s.gh, x.s.gt)}</td><td>${(x.s.putts / Math.max(1, x.s.ph) * 18).toFixed(0)}</td></tr>`).join('')}</table></div>` : ''}</div>`; })()}
  ${use}
  <div class="card" style="padding:6px"><div class="small mut" style="padding:4px 6px">All tees — your hole (${S.cur}) and tee (${S.tee}) highlighted</div>${scorecardTable(S.course, S.tee, S.ended ? null : S.cur, false)}</div>
  ${S.ended || Object.values(S.holes).some(x => x.done) ? '' : `<div class="card"><b>Starting hole</b> <span class="small mut">(shotgun) — currently #${S.order[0]}; can be changed until the first hole is scored</span>${startGrid('setStart(N)', S.order[0])}</div>`}
  <div class="card row"><button onclick="shareCard()">📤 Share card</button>${S.ended ? `<button onclick="reopenRound()">↩ Reopen round</button>` : `<button onclick="endRound()" style="background:#5a2620">Finish round</button>`}</div>`;
}
function shareCard() {
  const t = totals();
  let s = `${club().short} ${S.course} (${S.tee}) — ${S.mode === 'scramble' ? 'Scramble: ' + S.players.filter(Boolean).join(', ') : 'Solo'}\n${relStr(t.r)} (${t.str}) thru ${t.thru}\n`;
  S.order.forEach(n => { const r = rel(n); if (r != null) s += `#${n} par ${H(n).par}: ${H(n).par + r} (${relStr(r)})  ${fmtDur(holeTime(n))}\n`; });
  if (navigator.share) navigator.share({text: s}).catch(() => {}); else { if (navigator.clipboard) navigator.clipboard.writeText(s).then(() => alert('Copied to clipboard'), () => alert(s)); else alert(s); }
}

function showPhoto() { let p = null; try { p = localStorage.getItem(photoKey()); } catch (e) {} if (!p) return; modal(`<img src="${p}" style="width:100%;border-radius:10px;display:block"><button style="width:100%;margin-top:8px" onclick="closeModal()">Close</button>`); }
function removePhoto() { if (!confirm('Remove the pin sheet photo?')) return; try { localStorage.removeItem(photoKey()); localStorage.removeItem(photoKey() + '_ts'); } catch (e) {} render(); }
function renderPins() {
  let photo = null, photoTs = 0; try { photo = localStorage.getItem(photoKey()); photoTs = +localStorage.getItem(photoKey() + '_ts') || 0; } catch (e) {}
  const rows = S ? S.order.map(n => { const st = hs(n), h = H(n), g = greenAxis(h); return `<tr><td><b>${n}</b></td><td>${st.pin ? '✅' : '<span class="mut">mid</span>'}</td><td>${['F', 'M', 'B'].map((k, i) => `<button class="sm" onclick="quickPin(${n},${[0.25, 0.5, 0.75][i]})">${k}</button>`).join(' ')}</td><td class="small mut">${Math.round(g.depthYds)}y deep</td><td><button class="sm" onclick="tab='hole';tapMode='pin';goHole(${n},false)">tap</button> ${st.pin ? `<button class="sm" onclick="hs(${n}).pin=null;save();render()">✕</button>` : ''}</td></tr>`; }).join('') : '';
  $('#main').innerHTML = `<div class="card"><b>📷 Pin sheet</b><div class="small mut">Snap the pin sheet the starter hands out. It stays on this phone so you can check it on every hole.</div>
    <button class="pri" style="width:100%;margin-top:8px" onclick="$('#photoIn').click()">${photo ? 'Retake photo' : 'Take photo of pin sheet'}</button>
    ${photo ? `<img id="photo" src="${photo}" style="margin-top:8px" onclick="showPhoto()"><div class="small mut">${photoTs ? '📅 Taken ' + new Date(photoTs).toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' ' + fmtClock(photoTs) + ' · ' : ''}Tap the photo to view it full-size.</div><button class="sm" style="margin-top:6px" onclick="removePhoto()">🗑 Remove photo</button>` : ''}</div>
  ${S ? `<div class="card"><b>Set today's pins</b><div class="small mut">Quick: F / M / B = front, middle, back third of the green. Exact: type them below, or use "tap" to drop the pin on the map. Distances update right away.</div>
    <table style="margin-top:6px"><tr><th>#</th><th></th><th>Quick</th><th>Green</th><th>Map</th></tr>${rows}</table></div>
  <div class="card"><b>Type exact pins</b><div class="small mut">One per line: <code>hole  yards-on  [L/R yards]</code><br>e.g. <code>1 22 L4</code> · <code>2 12</code> · <code>3 30 R6</code> · <code>4 18 C</code></div>
    <textarea id="pinTxt" rows="5" placeholder="1 22 L4&#10;2 12&#10;3 30 R6" oninput="window._pinTxt=this.value">${esc(window._pinTxt || '')}</textarea><button class="pri" style="width:100%;margin-top:8px" onclick="applyPinText()">Apply pins</button>
    <div id="pinMsg" class="small mut" style="margin-top:6px"></div></div>` : '<div class="card">Start a round to set pins.</div>'}`;
}
function quickPin(n, f) { const h = H(n), g = greenAxis(h); hs(n).pin = pinFromDepth(h, g.depthYds * f, 0); save(); render(); }
function applyPinText() {
  const lines = $('#pinTxt').value.split(/\n|;/); let ok = 0, bad = [];
  lines.forEach(l => { const m = l.trim().match(/^#?(\d{1,2})\s*[:.\-)]?\s*(\d{1,2})\s*(?:y|yd|yds|paces)?\s*(?:([LRC])\s*(\d{1,2})?)?/i); if (!m) { if (l.trim()) bad.push(l.trim()); return; }
    const n = +m[1]; if (n < 1 || n > 18) { bad.push(l.trim()); return; }
    const side = (m[3] || 'C').toUpperCase(), off = m[4] ? +m[4] : 0;
    hs(n).pin = pinFromDepth(H(n), +m[2], side === 'L' ? -off : side === 'R' ? off : 0); ok++; });
  window._pinTxt = $('#pinTxt').value; save(); render(); $('#pinMsg').textContent = `Set ${ok} pin(s).` + (bad.length ? ' Could not read: ' + bad.join(' | ') : '');
}
$('#photoIn').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image(), url = URL.createObjectURL(f);
  img.onload = () => { const k = Math.min(1, 1600 / Math.max(img.width, img.height)), cv = document.createElement('canvas'); cv.width = img.width * k; cv.height = img.height * k; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    try { localStorage.setItem(photoKey(), cv.toDataURL('image/jpeg', 0.8)); localStorage.setItem(photoKey() + '_ts', String(Date.now())); } catch (er) { alert('Photo too large to store'); } URL.revokeObjectURL(url); render(); };
  img.src = url; e.target.value = '';
});

function renderInfo() {
  const c = wx && wx.current, cr = C.courses[course()];
  let hourly = '';
  if (wx && wx.hourly) { const now = Date.now(); const idx = wx.hourly.time.map((t, i) => [new Date(t).getTime(), i]).filter(([t]) => t > now - 3600e3).slice(0, 6);
    hourly = `<table><tr><th class="l">Time</th><th>°F</th><th>Wind</th><th>Gust</th><th>Rain</th></tr>${idx.map(([t, i]) => `<tr><td class="l">${fmtClock(t)}</td><td>${Math.round(wx.hourly.temperature_2m[i])}</td><td>${Math.round(wx.hourly.wind_speed_10m[i])} ${compass(wx.hourly.wind_direction_10m[i])}</td><td>${Math.round(wx.hourly.wind_gusts_10m[i])}</td><td>${wx.hourly.precipitation_probability[i]}%</td></tr>`).join('')}</table>`; }
  const rho = c ? airDensity(c.temperature_2m, c.surface_pressure, c.relative_humidity_2m) : null;
  const cl = club(), ck = clubOf(course()), dg = String(cl.phone || '').replace(/\D/g, ''), lk = CLUB_LINKS[ck]; // club contact (tel: from the digits)
  const infoCard = `<div class="card"><b>${course()} course</b><div class="small">${esc(cr.blurb)}</div>
    <table style="margin-top:6px"><tr><th class="l">Tee</th><th>Yards</th><th>Rating / Slope</th></tr>${teesOf(course()).map(t => `<tr><td class="l">${t}</td><td>${cr.holes.reduce((a, h) => a + h.yds[t], 0)}</td><td>${esc(cr.rating[t] || '')}</td></tr>`).join('')}</table>
    <div class="small" style="margin-top:6px"><a style="color:var(--acc)" href="tel:${dg.length === 10 ? '+1' : ''}${dg}">📞 Pro shop ${esc(cl.phone)}</a> · ${esc(cl.addr)}${lk ? `<br>
    <a style="color:var(--acc)" target="_blank" href="${lk.site}">Club website</a> · <a style="color:var(--acc)" target="_blank" href="${lk.tee}">Tee times</a>` : ''}</div></div>`;
  $('#main').innerHTML = `
  <div class="card"><b>Weather now</b> <span class="small mut">${wxAge()}</span>
    ${c ? `<div style="font-size:22px;font-weight:800;margin:4px 0">${Math.round(c.temperature_2m)}°F · wind ${Math.round(c.wind_speed_10m)} mph ${compass(c.wind_direction_10m)}, gusts ${Math.round(c.wind_gusts_10m)}</div>
    <div class="small mut">Feels ${Math.round(c.apparent_temperature)}° · humidity ${c.relative_humidity_2m}% · pressure ${Math.round(c.surface_pressure)} hPa · air density ${((rho / RHO0 - 1) * 100).toFixed(1)}% vs. standard (70°F, sea level) → ball flies about ${Math.abs((rho / RHO0 - 1) * 55).toFixed(1)}% ${rho > RHO0 ? 'shorter' : 'farther'}${wx.daily ? ' · sunrise ' + wx.daily.sunrise[0].slice(11) : ''}</div>${hourly}` : `<div class="mut">${wxErr || 'Loading…'}</div>`}</div>
  <div class="card small"><b>How "plays like" is calculated</b><br>
    • <b>Slope:</b> elevation at you vs. the target from USGS lidar (1 m grid on the greens, 5 m elsewhere); 1 yd per 3 ft uphill (≈0.9 downhill).<br>
    • <b>Wind:</b> live wind vs. your shot line: +1% per mph into, −0.5% per mph helping, crosswind gives an aim-off. Scaled down for short shots.<br>
    • <b>Air:</b> temperature, humidity and barometric pressure → air density (≈0.55% distance per 1% density).<br>
    These are standard rules of thumb (like a slope rangefinder plus weather), not a launch monitor. Trust your eyes on gusty days.</div>
  ${infoCard}
  <div class="card"><b>Auto-advance holes</b> <span class="small mut">When you walk to the next tee, move to that hole and ask for the score of the one you just finished.</span><div class="row" style="margin-top:6px"><button class="${pref.autoAdv !== false ? 'on' : ''}" onclick="pref.autoAdv=pref.autoAdv===false;savePref();render()">${pref.autoAdv !== false ? '✅ On' : 'Off'}</button></div></div>
  <div class="card"><b>Offline maps</b> <span class="small mut">Save the satellite map on this phone so holes load instantly and work with no signal.</span><div class="row" style="margin-top:6px"><button class="sm" onclick="downloadOffline()">⬇️ Save maps offline</button><span class="small mut" id="offStat">${offlineStatus()}</span></div></div>
  <div class="card"><b>Favorite layup distance</b><div class="small mut">Used for the "lay up to leave ___" number.</div><div class="row" style="margin-top:6px">${[60, 80, 100, 120, 140].map(v => `<button class="${(pref.layup || 100) === v ? 'on' : ''}" onclick="pref.layup=${v};savePref();render()">${v}</button>`).join('')}</div></div>
  <div class="card small mut">Map: Esri World Imagery · Hole/green/bunker shapes © OpenStreetMap contributors · Elevation: USGS 3DEP lidar (5 m grid) · Weather: Open-Meteo · Scorecard: GolfPass · Rating/slope: 18Birdies (men's; W = women's). Hole shapes are community-mapped; if a green looks off, drop the pin by tapping it.</div>`;
}

/* ---------------- wake lock ---------------- */
async function requestWake() { try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) {} }
window.addEventListener('pagehide', () => save());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); if (document.visibilityState === 'visible') { if (S && S.started && !S.ended) requestWake(); loadWx(true); render(); } });

/* ---------------- manual update ---------------- */
async function forceUpdate() {
  if (!confirm('Reload the app from the server? Your round is saved first.')) return; // top-right button: a mis-tap must not wipe the caches
  if (!navigator.onLine) { alert('No signal — connect to Wi-Fi or cellular to update the app.'); return; }
  const b = $('#updBtn'); if (b) b.textContent = '⏳';
  try { save(); } catch (e) {}
  // refresh the real script URLs (app.js?v=N, vendor/…), and only wipe the caches once every file came back: a failed update must not leave the app empty
  const files = ['./', 'index.html', 'sw.js', 'course.json', 'manifest.json'].concat([...document.scripts].map(s => s.getAttribute('src')).filter(Boolean));
  let ok = false;
  try { const rs = await Promise.all(files.map(f => fetch(f, {cache: 'reload'}).catch(() => null))); ok = rs.every(r => r && r.ok); } catch (e) {}
  if (!ok) { if (b) b.textContent = '🔄'; alert('Could not reach the server — try again with better signal.'); return; }
  try { if ('caches' in window) { for (const k of await caches.keys()) if (/^bcgps-v/.test(k) || k === 'bcgps-data') await caches.delete(k); } } catch (e) {}
  try { if (navigator.serviceWorker) { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } } catch (e) {}
  location.replace(location.pathname + '?u=' + Date.now());
}

/* ---------------- boot ---------------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; render(); });
(async function boot() {
  $('#main').innerHTML = '<div class="card">Loading course…</div>';
  try { C = await (await cachedFetch('course.json', 4000)).json(); closeRings(); } catch (e) { $('#main').innerHTML = '<div class="card">Could not load course data. Check your connection and reload.</div>'; return; }
  if (!C.courses[pref.course]) pref.course = 'West';
  if (!Array.isArray(pref.players)) pref.players = ['Travis', '', '', ''];
  pref.tee = validTee(pref.course, pref.tee); // old prefs (West/East, any tee) keep working
  let cur = null; try { cur = localStorage.getItem(LS_KEY); } catch (e) {}
  if (cur && cur[0] === '{') { try { const old = JSON.parse(cur); if (old && old.order && !old.preview) { old.id = old.id || 'r' + (old.started || Date.now()); old.name = old.name || 'Round ' + new Date(old.started || Date.now()).toLocaleDateString(); S = old; save(); } } catch (e) {} cur = S ? S.id : null; }
  S = cur ? (rounds()[cur] || null) : null;
  if (S && (S.preview || S.ended)) S = null; // finished rounds open from the list
  if (S) { fixTee(S); viewHole = S.cur; if (S.started && !S.ended) requestWake(); if (S.pendingScore && !hs(S.pendingScore).done) pendingScore = S.pendingScore; }
  loadDEM(); // the club of the round (or of the saved pref)
  startGPS();
  try { render(); } catch (e) { // a broken saved round must not brick the app; it stays in Saved rounds
    console.error(e); S = null; try { localStorage.removeItem(LS_KEY); } catch (e2) {} tab = 'hole'; bootErr = "Couldn't open your round — resume it from Saved rounds below."; try { render(); } catch (e3) {}
  }
  loadWx();
  setInterval(renderHeader, 5000);
  setInterval(() => { if (!gps || Date.now() - gps.ts > 1500) liveUpdate(); }, 2000); // GPS fixes already refresh it
  setInterval(() => loadWx(), 20000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
