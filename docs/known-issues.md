# Known issues and gotchas

- Any push that changes `bundle.json` starts the iOS workflow and a TestFlight build. Batch app changes.
- The Overpass (OSM) refresh in `osm.yml` can fail; `water.json` in the repo is the fallback.
- The Live Activity has to fit the lock-screen height; check it after layout changes.

## From the 2026-11-09 review sweep (open, Travis to decide)

### Build and release
- **bundle.json is the source of truth.** Both workflows unpack it over the tree. Any edit to a bundled file (app.js, index.html, sw.js, build.py, README, ios/…) that is not followed by `python3 pack.py` is reverted by the next workflow run, and `osm.yml` commits the revert. `python3 pack.py --check` tells you.
- **Workflows run on every branch.** `ios.yml` and `osm.yml` trigger on `push` with no branch filter, and the workflow files themselves are in `paths`. A bundle.json or workflow edit on a feature branch uploads a TestFlight build and commits "Build app files" onto the branch. Fix when ready: `branches: [main]` on both (that edit itself triggers a build once).
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
- `pausesLocationUpdatesAutomatically` not set to false; no workout recovery on relaunch; 50 Hz device-motion for the whole round (battery).
- Complication timeline has one entry marked live at build time; `reloadAllTimelines()` every 20 s burns the budget.
- Front/back definitions differ slightly from the phone (front is 0 when standing on the green on the phone, not on the Watch).

### Web app and data (not fixed, low priority)
- Fairway polygons exist for only 15 of 36 holes in OSM, so FIR stats are blank on the rest.
- West 17's OSM hole line is 139 yd (Black is 178): it starts at a forward tee. Tee placement is unaffected (it walks back from the green by card yardage).
- The 1 m green grids and the 5 m DEM disagree by up to ~6 m on 5 greens (East 2 worst); a shot from off the green to the pin can mix sources (~7 yd of plays-like).
- `applyPinText` has no end anchor ("1 225" reads as depth 22) and does not clamp depth to the green.
- In the sandbox, Open-Meteo fails CORS through the proxy; on GitHub Pages it works. Not an app bug.
