// Web-app scenario checks, run in real Chromium (Playwright) against the app served locally.
// Usage: python3 -m http.server 8766 --directory . &   then   node tests/verify.js
// Exit code 0 = all passed. Screenshots land next to this file.
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path');
const C = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'course.json'), 'utf8'));
const W = C.courses.West.holes;
const tee1 = W[0].line[0];
const fails = [], logs = [];
const ok = (name, cond, info) => { (cond ? logs : fails).push(`${cond ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' :: ' + JSON.stringify(info) : ''}`); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], geolocation: { latitude: tee1[0], longitude: tee1[1] }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  const errors = []; const envErr = t => /open-meteo|ERR_FAILED/.test(t);
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.type() + ': ' + m.text(); if (!envErr(t)) errors.push(t); } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof C !== "undefined" && C && document.querySelector('#main').textContent.includes('New round'));
  ok('boot clean', errors.length === 0, errors);
  ok('Leaflet vendored and loaded', await page.evaluate(() => typeof L !== 'undefined' && !!L.TileLayer && !!L.Map.prototype.setBearing));
  // pref migration: old prefs without start/players
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('bcgps_pref_v1', JSON.stringify({ course: 'West', tee: 'Blue', mode: 'solo' })); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof C !== "undefined" && C && document.querySelector('#main').textContent.includes('New round'));
  ok('old prefs get start=1 and 4 players', await page.evaluate(() => pref.start === 1 && pref.players.length === 4), await page.evaluate(() => pref));
  // start a solo round via the real function
  await page.evaluate(() => { pref.mode = 'solo'; startRound(); });
  ok('round started on hole 1', await page.evaluate(() => S && S.cur === 1 && S.order[0] === 1));
  const run = (fn) => page.evaluate(fn);
  // 1: override then shots then complete -> every total agrees
  let r = await run(() => { bump(1); logShot(1, null, 'Drive'); logShot(1, null, 'Putt'); completeHole(); return { rel: rel(1), tot: totals(), sum: roundSummary(S), stats: roundStats(S).rel, cur: S.cur }; });
  ok('override then 2 shots: rel/totals/summary/stats all -2', r.rel === -2 && r.tot.r === -2 && r.sum.rr === -2 && r.stats === -2 && r.cur === 2, r);
  // 2: 5 shots then auto-advance with "Later": hole still counts
  r = await run(() => { for (let i = 0; i < 5; i++) logShot(2, null, 'Drive'); advanceFrom(2); const prompt = !!document.querySelector('#modal .sheet'); closeModal(); return { done: S.holes[2].done, tot: totals(), prompt, cur: S.cur, view: viewHole }; });
  ok('advance with 5 shots logged: done, counted in totals, prompt shown', r.done === true && r.tot.thru === 2 && r.tot.r === -1 && r.prompt && r.cur === 3, r);
  // 3: complete a browsed hole: round does not move or end
  r = await run(() => { goHole(18, false); completeHole(); const a = { ended: !!S.ended, cur: S.cur, view: viewHole }; goHole(5, false); completeHole(); return { ...a, cur2: S.cur, done5: S.holes[5].done }; });
  ok('complete 18 while on 3: not ended; complete 5: cur stays 3, 5 marked done', !r.ended && r.cur === 3 && r.cur2 === 3 && r.done5, r);
  // 4: goBackTo undoes timestamps
  r = await run(() => { goHole(3, true); S.holes[3] = { shots: [], adj: null, done: false, gpsIn: 1000, startTs: 1000 }; advanceFrom(3); S.holes[3].gpsOut = 2000; const nx = S.cur; const before = { nxStart: S.holes[nx].startTs }; goBackTo(3); return { before, gpsOut: S.holes[3].gpsOut, done3: S.holes[3].done, nxStart: S.holes[nx].startTs, cur: S.cur, nx }; });
  ok('goBackTo clears gpsOut/done on 3 and startTs on the hole we jumped to', r.gpsOut === undefined && r.done3 === false && r.nxStart === undefined && r.cur === 3, r);
  // 5: putts per hole ignores holes scored by number only
  r = await run(() => { setHoleScore(7, 4); setHoleScore(8, 3); const s = roundStats(S); return { ph: s.ph, putts: s.putts, thru: s.thru }; });
  ok('number-only holes add no putt-holes', r.ph === 2 && r.putts === 1 && r.thru >= 4, r); // holes 1 and 2 have logged shots, 7 and 8 do not
  // 6: stale adj cleared when shots deleted
  r = await run(() => { goHole(9, false); bump(2); logShot(9, null, 'Drive'); delShot(9, 0); return { rel: rel(9), adj: S.holes[9].adj }; });
  ok('delete last shot leaves no stale ± score', r.rel === null && r.adj === null, r);
  // 7: storage full -> banner
  r = await run(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('quota'); }; logShot(9, null, 'Drive'); const e = saveErr, b = document.querySelector('#banner').textContent; Storage.prototype.setItem = o; save(); return { e, b, after: saveErr }; });
  ok('quota failure sets saveErr and shows banner; clears after a good save', r.e === true && /storage is full/i.test(r.b) && r.after === false, r);
  // 8: GPS hole tracking: accuracy gate and candidate reset
  r = await run(() => {
    const p5 = C.courses.West.holes[4].line[1] || C.courses.West.holes[4].line[0];
    gpsCand = null; gps = { p: p5, acc: 60, ts: Date.now() }; trackHoleByGPS(); const a = gpsCand;
    gps.acc = 5; trackHoleByGPS(); const b = gpsCand && gpsCand.n;
    gpsCand.ts -= 31000; gpsCand.last -= 70000; trackHoleByGPS(); const c = gpsCand && (Date.now() - gpsCand.ts < 5000); // gap -> restarted dwell, not switched
    const hole = S.gpsHole; gpsCand.ts -= 31000; trackHoleByGPS(); return { a, b, c, hole, after: S.gpsHole };
  });
  ok('weak fix ignored; gap restarts dwell; 30 s dwell then switches', r.a === null && r.b === 5 && r.c === true && r.hole !== 5 && r.after === 5, r);
  // 9: manualMe clears on hole change
  r = await run(() => { manualMe = [32.86, -97.05]; goHole(6, false); return manualMe; });
  ok('manual position cleared when changing hole', r === null, r);
  // 10: dictation
  r = await run(() => { S.mode = 'scramble'; S.players = ['Travis', 'Drew', 'Chris', 'Mike']; const f = t => parseDictation(t, 1).map(x => [x.p, x.t, x.g ? x.g.kind : undefined]); const out = {
    a: f('Travis driver, two putts'), b: f('Travis four putts'), c: f('Travis to putts'), d: f('Drew drives'), e: f('Mike chips'), g: f('Chris irons it'), h: f('Travis putter'), i: f('Travis chipped on and two putts'), j: f('Drew mulligan off the tee') };
    S.players = ['Samuel', 'Samantha', '', '']; out.k = f('sam drive'); S.players = ['Sam', 'Dan', '', '']; out.l = f('Sam sand shot'); S.mode = 'solo'; S.players = ['Me']; return out; });
  ok('"Travis driver, two putts" -> drive + 2 putts all Travis', JSON.stringify(r.a) === JSON.stringify([[0, 'Drive', undefined], [0, 'Putt', undefined], [0, 'Putt', undefined]]), r.a);
  ok('"four putts" -> 4', r.b.length === 4 && r.b.every(x => x[1] === 'Putt' && x[0] === 0), r.b);
  ok('"to putts" -> 2', r.c.length === 2, r.c);
  ok('drives/chips/irons/putter typed', r.d[0][1] === 'Drive' && r.e[0][1] === 'Chip' && r.g[0][1] === 'Approach' && r.h[0][1] === 'Putt', [r.d, r.e, r.g, r.h]);
  ok('"chipped on and two putts" keeps Travis on the putts', r.i.length === 3 && r.i.every(x => x[0] === 0), r.i);
  ok('mulligan still a single gimmick', r.j.length === 1 && r.j[0][2] === 'Mulligan', r.j);
  ok('ambiguous 3-letter prefix -> nobody', r.k.length === 1 && r.k[0][0] === null, r.k);
  ok('exact name wins over prefix', r.l[0][0] === 0 && r.l[0][1] === 'Chip', r.l);
  // 10b: dictation "Again": the aborted recognizer must not write into the new sheet
  r = await run(async () => {
    window.webkitSpeechRecognition = class { start() {} abort() { setTimeout(() => { this.onerror && this.onerror({ error: 'aborted' }); this.onend && this.onend(); }, 0); } };
    startDictation(); startDictation(); await new Promise(res => setTimeout(res, 100));
    const status = document.querySelector('#dictStatus').textContent; const live = !!dictRec; closeModal(); const after = dictRec;
    const two = parseDictation('Chris going to putt', 1).length, plural = parseDictation('Chris to putts', 1).length;
    return { status, live, after, two, plural };
  });
  ok('"Again" keeps the new recognizer listening; closeModal stops it', /Listening/.test(r.status) && r.live && r.after === null, r);
  ok('"going to putt" is one putt, "to putts" is two', r.two === 1 && r.plural === 2, r);
  // 11: hazards from Blue tee: carry must be along the line, never the far corner of a lake
  r = await run(() => { const out = {}; for (const [cn, n] of [['West', 4], ['West', 2], ['West', 13], ['West', 7], ['West', 1], ['West', 6], ['West', 11], ['West', 12], ['West', 14]]) { const h = C.courses[cn].holes[n - 1]; const from = teePos(h, 'Blue'); const pin = greenC(h); const D = yds(from, pin); out[cn + n] = { D: Math.round(D), hz: hazardsFrom(from, h).map(z => [z.name, Math.round(z.reach), z.carry == null ? null : Math.round(z.carry)]) }; } return out; });
  const allSane = Object.values(r).every(o => o.hz.every(z => z[1] <= 300 && (z[2] === null || (z[2] >= z[1] && z[2] <= o.D + 30))));
  ok('hazard carry >= reach and never beyond the pin + 30 (or blank)', allSane, r);
  // --- multi-club and sweep-2 scenarios ---
  // A: a round on a course missing from today's data is hidden, never deleted
  r = await run(() => { const all = JSON.parse(localStorage.getItem('bcgps_rounds_v1')); all.rW = {id: 'rW', name: 'W', course: 'Whitworth', tee: 'Junior', mode: 'solo', players: ['Me'], order: [...Array(18)].map((_, i) => i + 1), started: 1, cur: 1, holes: {}}; localStorage.setItem('bcgps_rounds_v1', JSON.stringify(all));
    const keep = C.courses.Whitworth; delete C.courses.Whitworth; const shown = Object.keys(rounds()).includes('rW'); save(); const still = !!JSON.parse(localStorage.getItem('bcgps_rounds_v1')).rW; C.courses.Whitworth = keep; const back = Object.keys(rounds()).includes('rW'); return { shown, still, back }; });
  ok('round on a missing course is hidden but survives save()', r.shown === false && r.still === true && r.back === true, r);
  // B: creek lines stay open, bunkers are closed, Whitworth 15 hazards sane
  r = await run(() => { let openW = 0, openB = 0; for (const cn in C.courses) for (const h of C.courses[cn].holes) for (const z of h.hz) { const P = z.p, c = P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]; if (!c) { if (z.t === 'b') openB++; else openW++; } }
    const keepS = S; S = {course: 'Whitworth', tee: 'Blue', holes: {}, order: [...Array(18)].map((_, i) => i + 1), cur: 15}; const h = C.courses.Whitworth.holes[14]; const hz = hazardsFrom(teePos(h, 'Blue'), h).map(z => [z.name, Math.round(z.reach), z.carry == null ? null : Math.round(z.carry)]); S = keepS; return { openW, openB, hz }; });
  ok('creek lines open, bunkers closed, Whitworth 15 hazards sane', r.openW > 0 && r.openB === 0 && r.hz.every(z => z[1] <= 300 && (z[2] === null || z[2] >= z[1])), r);
  // C: Watch commands respect the hole
  r = await run(() => { const cur = S.cur, before = hs(cur).shots.length; const other = S.order.find(n => n !== cur && S.holes[n] && S.holes[n].done); const ob = hs(other).shots.length;
    bcNative.cmd('shot', other); const a = hs(other).shots.length; bcNative.cmd('shot', cur); const b = hs(cur).shots.length; bcNative.cmd('undo', cur); const c = hs(cur).shots.length;
    return { other, ob, a, before, b, c }; });
  ok('Watch shot on a finished hole ignored; on the current hole logged and undone', r.a === r.ob && r.b === r.before + 1 && r.c === r.before, r);
  // D: autoClub needs a real fix and respects the user's pick
  r = await run(() => { const keepS = S; S = null; const p = C.courses.Hogan.holes[0].line[0]; pref.course = 'West'; autoClubDone = false; gps = { p, acc: 150, ts: Date.now() }; autoClub(); const coarse = pref.course; gps.acc = 8; autoClub(); const fine = pref.course; setCourse('West'); gps = { p, acc: 8, ts: Date.now() }; autoClub(); const after = pref.course; S = keepS; return { coarse, fine, after }; });
  ok('autoClub ignores a coarse fix, switches on a good one, never overrides a user pick', r.coarse === 'West' && r.fine === 'Hogan' && r.after === 'West', r);
  // E: finished round can be reopened; pending-score banner after Later
  r = await run(() => { S.ended = Date.now(); tab = 'card'; render(); const btn = /Reopen round/.test(document.querySelector('#main').textContent); reopenRound(); const re = { ended: S.ended, tab };
    const n = S.cur, i = S.order.indexOf(n); S.holes[n] = { shots: [], adj: null, done: false }; advanceFrom(n); const prompt = !!document.querySelector('#modal .sheet'); closeModal(); render(); const banner = document.querySelector('#banner').textContent; return { btn, re, prompt, banner, pend: S.pendingScore, n }; });
  ok('reopen works; "Later" on a strokeless hole leaves a reminder banner', r.btn && r.re.ended === null && r.re.tab === 'hole' && r.prompt && /no score yet/.test(r.banner) && r.pend === r.n, r);
  r = await run(() => { const n = S.pendingScore || S.order[S.order.indexOf(S.cur) - 1]; goHole(n, false); bump(1); const gone = !/no score yet/.test(document.querySelector('#banner').textContent); goHole(S.cur, false); return { gone }; });
  ok('a ± entry clears the reminder', r.gone, r);
  // F: no layup on par 3s; green slope only near the green; top strip present; no-GPS state visible
  r = await run(() => { const h3 = C.courses.West.holes.find(h => h.par === 3); const li = layupInfo(teePos(h3, 'Blue'), h3.n); goHole(h3.n, false); gps = null; manualMe = null; const top = liveHtml('top'), body = liveHtml(); const far = /Green slope/.test(body);
    manualMe = fromXY([0, -25], greenC(h3)); const near = /Green slope/.test(liveHtml()); manualMe = null; return { layup: !!li.layup, strip: /H\d+ · Par/.test(top) && /F <b>/.test(top), nogps: /nogps/.test(top) && /from the tee/i.test(top), far, near }; });
  ok('par 3 has no layup; slope card only near the green; strip and no-GPS state shown', !r.layup && r.strip && r.nogps && !r.far && r.near, r);
  // G: aged weather is kept (no wind) instead of blanked
  r = await run(() => { const kM = wxModel, kO = wxObs, kW = wx; wxModel = { club: 'bc', fetchedAt: Date.now() - 120 * 60e3, ts: Date.now(), current: { temperature_2m: 70, relative_humidity_2m: 50, surface_pressure: 995, wind_speed_10m: 15, wind_direction_10m: 180, wind_gusts_10m: 20 } }; wxObs = null; combineWx(); const out = { have: !!wx, aged: wx && wx.aged, wind: wx && wx.current.wind_speed_10m, min: wx && wx.ageMin }; wxModel = kM; wxObs = kO; wx = kW; return out; });
  ok('2-hour-old weather is kept as aged with wind dropped', r.have && r.aged === true && r.wind === 0 && r.min >= 119, r);
  // H: a Whitworth Junior round resumes with its tee
  r = await run(() => { const keepS = S; S = { id: 'rJ', name: 'J', course: 'Whitworth', tee: 'Junior', mode: 'solo', players: ['Me'], order: [...Array(18)].map((_, i) => i + 1), started: Date.now(), cur: 15, holes: {} }; fixTee(S); viewHole = 15; tab = 'hole'; render(); const t = document.querySelector('#main').textContent; const out = { tee: S.tee, bad: /NaN|undefined/.test(t), yds: /65 yds \(Junior\)/.test(t) }; S = keepS; viewHole = S.cur; render(); return out; });
  ok('Whitworth Junior round keeps its tee and renders', r.tee === 'Junior' && !r.bad && r.yds, r);
  // 12: no NaN anywhere on hole/card/info after render
  r = await run(() => { const out = {}; for (const t of ['hole', 'card', 'pins', 'info']) { tab = t; render(); out[t] = /NaN|undefined/.test(document.querySelector('#main').textContent); } tab = 'hole'; render(); return out; });
  ok('no NaN/undefined text on any tab', Object.values(r).every(v => !v), r);
  // 13: liveUpdate does not rewrite unchanged DOM
  r = await run(() => { liveUpdate(); const el = document.querySelector('#liveTop').firstElementChild; liveUpdate(); return el === document.querySelector('#liveTop').firstElementChild; });
  ok('liveUpdate keeps the same top DOM node when nothing changed', r === true);
  // 14: photo remove path renders without photo
  r = await run(() => { tab = 'pins'; render(); const t = document.querySelector('#main').textContent; tab = 'hole'; render(); return /Take photo/.test(t); });
  ok('pins tab renders without a photo', r);
  // 15: reload resumes
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof C !== "undefined" && C && typeof S !== "undefined" && S);
  r = await run(() => ({ cur: S.cur, thru: totals().thru }));
  ok('round resumes after reload', r.cur === 4 && r.thru >= 4, r); // scenario E advanced the round from 3 to 4
  // 16: forceUpdate offline refuses and stays put
  await ctx.setOffline(true);
  const url0 = page.url(); await run(() => forceUpdate()); await page.waitForTimeout(500);
  ok('forceUpdate offline does nothing', page.url() === url0);
  await ctx.setOffline(false);
  // 17: service worker + precache
  r = await run(async () => { const reg = await navigator.serviceWorker.getRegistration(); const keys = await caches.keys(); const vk = keys.find(k => /^bcgps-v\d+$/.test(k)); const c = await caches.open(vk || 'bcgps-v0'); const ks = (await c.keys()).map(q => new URL(q.url).pathname); return { active: !!(reg && reg.active), keys, hasVendor: ks.some(k => k.endsWith('vendor/leaflet.js')), hasApp: ks.some(k => k.endsWith('/app.js')), hasTcc: ks.some(k => k.endsWith('/dem_tcc.bin')), count: ks.length }; });
  ok('SW active, versioned precache holds vendor + app.js + dem_tcc.bin', r.active && r.hasVendor && r.hasApp && r.hasTcc, r);
  await page.screenshot({ path: __dirname + '/hole.png' });
  ok('no console errors during the run', errors.length === 0, errors);
  console.log(logs.join('\n')); console.log(fails.join('\n'));
  console.log(`\n${logs.length} passed, ${fails.length} failed`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
