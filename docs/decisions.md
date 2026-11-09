# Decisions

- 2026-11: Native iPhone + Watch app, distributed through TestFlight, alongside the web app. Why: Watch GPS and live numbers on the wrist.
- 2026-11: Name "GolfHub" and the black/orange/white logo are for testing only. Why: a joke for testing buddies; change before any App Store release.
- 2026-11-06: Creek drawn only near the hole it affects (about 200 yd). Why: the whole waterway network cluttered the map.
- 2026-11-06: Waterway data kept in the repo; the Overpass refresh is best-effort. Why: the refresh can fail.

- Multi-club data: `course.json` has `clubs` (name, place, phone, courses, per-club DEM file) and each course has `club` and `tees`. Bear Creek stays `bc`, Trophy Club is `tcc`; old app versions still read top-level `dem`.
- Trophy Club tee names Blue/Copper/White/Gold/Silver (the club site says Tee 1-5). Handicaps from GolfPass (the club site has none).
- Holes OSM lacks are traced into `tcc_traced.json` (back tee -> dogleg -> green centre); tees are placed along that line by yardage.
