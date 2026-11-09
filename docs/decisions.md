# Decisions

- 2026-11: Native iPhone + Watch app, distributed through TestFlight, alongside the web app. Why: Watch GPS and live numbers on the wrist.
- 2026-11: Name "GolfHub" and the black/orange/white logo are for testing only. Why: a joke for testing buddies; change before any App Store release.
- 2026-11-06: Creek drawn only near the hole it affects (about 200 yd). Why: the whole waterway network cluttered the map.
- 2026-11-06: Waterway data kept in the repo; the Overpass refresh is best-effort. Why: the refresh can fail.
- 2026-11-09: Leaflet and leaflet-rotate are vendored in `vendor/`, not loaded from CDNs. Why: the first load on the course with no signal had no map library at all (the service worker only caches CDN files after one online visit), and the SW precache can now hold them.
- 2026-11-09: `pack.py` rebuilds `bundle.json`; nothing else writes it. Why: bundle.json is what the workflows unpack over the tree, so an edited app.js that is not repacked is silently reverted by the next workflow run. `python3 pack.py --check` fails when the bundle is stale.
- 2026-11-09: Branch work does not repack `bundle.json`; Travis repacks right before merging. Why: both workflows trigger on any branch when bundle.json changes, so a repack on a feature branch would upload an unreviewed TestFlight build.
- 2026-11-09: Hazard reach / carry are measured along the line from you to the pin: reach is where that line enters the hazard (or the nearest point if it runs beside the line), carry is where the line leaves it (or the hazard's far end along the line). Carry is blank when the hazard runs past the pin. Why: the old carry was the farthest vertex in any direction, which read 597 yd for a lake beside West 4.
- 2026-11-09: A hole with logged strokes counts in the total as soon as you advance from it, even before the score prompt is answered. Why: "Later" on the prompt used to drop the hole from the total while the card row still showed it.
- 2026-11-09: GPS fixes with accuracy worse than 30 m never auto-advance the hole. Why: a cold-start or pocket fix of 80 m can latch the wrong hole and advance early.
- 2026-11-09: West 14 yardages (Blue 144 shorter than Silver 161) stay as they are. Why: GolfPass, the card source, lists exactly those numbers; the oddity is in the published card.
- 2026-11-09: Swift (iPhone / Watch) and workflow findings from the sweep are recorded, not fixed, in this branch. Why: no Xcode here to compile, and a workflow or bundle.json change on a branch starts a TestFlight build.
