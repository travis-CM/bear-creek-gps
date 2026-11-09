# Known issues and gotchas

- Any push that changes `bundle.json` starts the iOS workflow and a TestFlight build. Batch app changes.
- The Overpass (OSM) refresh in `osm.yml` can fail; `water.json` in the repo is the fallback.
- The Live Activity has to fit the lock-screen height; check it after layout changes.
- Trophy Club: Whitworth tee boxes aren't in OSM, so tee spots are estimates along the traced line; correct them on the course if they're off.
- Whitworth 15's greenside pond is hand-traced in build.py (missing from OSM).
- The CI Overpass fetch for Trophy Club waterways can return an error page; keep the committed `tcc_water.json`.
- Watch elevation uses the 5 m grid only (no 1 m green grids); slope near greens can differ ~1 yd from the phone.
- Watch-as-GPS-source and lock-screen buttons need the iPhone app/web view alive; device-test both.
- sw.js cache version V must be bumped when the precache list changes.

## From the 2026-11-09 review sweep (open, Travis to decide)

### Build and release
- **bundle.json is the source of truth** (repacked on this branch 2026-11-09 with Travis's OK, so the merge to main will build once). Both workflows unpack it over the tree. Any edit to a bundled file (app.js, index.html, sw.js, build.py, README, ios/…) that is not followed by `python3 pack.py` is reverted by the next workflow run, and `osm.yml` commits the revert. `python3 pack.py --check` tells you.
- **(Fixed 2026-11-09, this branch: both workflows now run on `main` only.)** Merging `main` into a branch counts as a bundle.json push. 2026-11-09: the merge commit that brought main's battery work (and its bundle.json) onto the review-sweep branch started both workflows on the branch: TestFlight build #37 went up from the branch and `osm.yml` unpacked the old bundle over app.js/index.html/sw.js/README and committed the revert (e3c8bcc), which had to be restored. Until the workflows get a `branches: [main]` filter, repack (`python3 pack.py`) in the same commit as any merge from main, or expect this.
- **(Fixed 2026-11-09: `branches: [main]` on both.)** Workflows ran on every branch. `ios.yml` and `osm.yml` trigger on `push` with no branch filter, and the workflow files themselves are in `paths`. A bundle.json or workflow edit on a feature branch uploads a TestFlight build and commits "Build app files" onto the branch. Fix when ready: `branches: [main]` on both (that edit itself triggers a build once).
- **Watch course data lags one push.** `ios.yml` builds from the pushed `course.json`/`dem.bin` while `osm.yml` regenerates them in parallel; the bot commit does not retrigger `ios.yml`. `make_assets.py` therefore packs the previous build's data for the Watch.
- **`osm.yml` has no concurrency group and pushes without `pull --rebase`.** A push during its long run fails the job and loses the rebuild.
- **Waterway refresh can wipe `water.json`.** An Overpass "200 with zero elements" passes the check and is moved over the good file; `build.py` then builds with no creeks. Assert `len(elements) > 0` (ideally ≥ half the old count) before `mv`.
- **The Overpass step never runs** (guarded by `! -f osm.json`, which is committed). README and CLAUDE.md said the workflow is named "Fetch course map data"; its name is "Build course app" (fixed in the docs).
- **`logo.svg` is the club's logo**, fetched from arcisgolf.com every build with no validation, committed to a public repo, and unused by the app. Resolve before any App Store release; at least stop fetching it.
- **`build.py` commits silently on partial data**: a failed green-grid fetch (`gz` missing) or a garbage `dem.tif` (nodata clipped to 130 m) still writes `course.json`/`dem.bin`. Assert all 36 grids and a sane elevation range before writing.
- `ios.yml`: secrets are job-level env (scope them to the archive step), `Xcode_26*` glob can pick a beta, no `permissions:` block.

### iPhone app (ios/iOS)
- `Bridge.swift` `updateApplicationContext` is `try?`: a JS `null` (NaN weather value) becomes `NSNull`, the call throws silently, and the Watch stops getting hole/pin/weather until the value is non-null. Strip nulls before sending.
- `bridge.start()` runs only in `.onAppear`: Live Activity button taps and Watch messages that relaunch the app in the background find no handler. Start the bridge from `init`, queue commands until the page reports `ready`.
- Live Activity: the widget never reads `isStale`; no end-on-terminate, so a killed app leaves old yardages on the lock screen for hours. Activity only starts when the app is active.
- A location-permission denial is lost: `locationManagerDidChangeAuthorization` fires before the page loads and the `ready` message does not resend it. User sees "waiting for GPS" forever.
- Watch `transferUserInfo` fallback delivers queued `shot`/`next` commands minutes later; the phone logs them at its current position. Send a timestamp and drop stale commands.
- `WebContainer.swift` `didFailProvisionalNavigation` ignores `NSURLErrorCancelled`.

### Watch app (ios/Watch, WatchWidget)
- Watch `step()` changes the Watch's hole locally and never tells the phone; the next phone context snaps it back, and a "+ Shot" tap is logged on the phone's current hole, not the one the Watch shows.
- `sendMessage` for a shot has no error handler: a failure is silent while the Watch increments the count and plays the success haptic.
- No stale/no-fix indicator: an old yardage stays big and green. `didFailWithError` is empty.
- `pausesLocationUpdatesAutomatically` not set to false; no workout recovery on relaunch. (Motion sensing is now 20 Hz and only while the screen is on, since the battery commit on main.)
- Complication timeline has one entry marked live at build time; `reloadAllTimelines()` every 20 s burns the budget.
- Front/back definitions differ slightly from the phone (front is 0 when standing on the green on the phone, not on the Watch).

### Web app and data (not fixed, low priority)
- Fairway polygons exist for only 15 of 36 holes in OSM, so FIR stats are blank on the rest.
- West 17's OSM hole line is 139 yd (Black is 178): it starts at a forward tee. Tee placement is unaffected (it walks back from the green by card yardage).
- The 1 m green grids and the 5 m DEM disagree by up to ~6 m on 5 greens (East 2 worst); a shot from off the green to the pin can mix sources (~7 yd of plays-like).
- `applyPinText` has no end anchor ("1 225" reads as depth 22) and does not clamp depth to the green.
- In the sandbox, Open-Meteo fails CORS through the proxy; on GitHub Pages it works. Not an app bug.

## Working in this repo (gotchas for the orchestrator and workers)
- Top-level `let`/`const` in app.js (`C`, `S`, `gps`, `pref`, `gpsCand`…) are not `window` properties. In a Playwright harness test them by bare name (`typeof C !== 'undefined' && C`), not `window.C`.
- `hazardsFrom(from, h)` takes the pin from the *current* course (`pinOf(h.n)`): checking an East hole while a West round is open gives nonsense. Set `S.course` first.
- Line-number-based test harnesses (`L.slice(a, b)` on app.js) die on the first edit. Extract functions by name or run the real app in headless Chromium.
- The web-app scenario harness is `tests/verify.js` (31 checks, headless Chromium). Serve the repo on port 8766 first. It is not bundled, so the workflows never touch it.

## From the 2026-11-09 second sweep (Trophy Club + parallel audit)
### Trophy Club data (course.json, build.py)
- **Whitworth 15 pond** is hand-traced in build.py; its ring is now closed, but about 7% of the 15th green lies inside it, so the trace is a few metres off. Needs a look at the imagery. The same pond is listed on hole 12.
- **Whitworth 15 Junior tee = 65 yd** is what GolfPass and TheGrint publish (Silver is 276). Almost certainly a card typo; the Junior marker lands in the pond. Left as published.
- **Trophy Club has no usable fairway polygons**: the OSM download carried the 20 fairway relations without geometry. Fairway-hit stats and the fairway outline are blank there. Re-fetch tcc_osm.json with relation members (`out geom` on relations) to fix.
- **Hogan 8 and 13 OSM lines start at a forward tee** (159 yd vs 210 Blue; 378 vs 418), so the Blue/Copper tee markers are extrapolated 30-45 m behind the line start. Same pattern as West 17.
- Whitworth has no tee polygons in OSM at all; its tee markers are card yardage walked back along the traced line (1-14 yd inside the traced start). Correct them on the course if they look off.
- Hogan 1's green is 238 m², just under the usual 250 m² floor; plausible for its elevated green.
- GolfPass's own tee table for Trophy Club is stale (Hogan Blue 6953 / 72.8 / 123 vs the card's 7060 / 74.1 / 133). course.json follows TheGrint and the club.
### Offline maps
- Trophy Club's offline map is about 3,000 tiles (~66 MB), three times Bear Creek. Save it on Wi-Fi; iOS may evict it. "✅ Saved" comes from localStorage and is not re-verified against the cache.
### Native (added to the earlier lists; the other session's commits resolved or half-resolved several items, see decisions)
- Still open on the iPhone: `updateApplicationContext` swallows NSNull; location denial before page ready is lost; `webReady` never resets on a page reload or web-process death, so commands are dropped silently; `pendingCmds` has no expiry; `Bridge` is created lazily by SwiftUI so a background relaunch may never create it; coarse 100 m phone fallback fixes (the web app now ignores them when a better recent fix exists); the screen now auto-locks mid-round and the web view may be suspended while locked (device-test one locked round).
- Still open on the Watch: `step()` snaps back to the phone's hole after 60 s and drops the pin; shot send has no ack/dedupe and can double-log; no stale/no-fix indicator; `pausesLocationUpdatesAutomatically`; workout recovery; complication timeline is a single entry; wrist-down accuracy can show a 15 yd stale number on raise.

