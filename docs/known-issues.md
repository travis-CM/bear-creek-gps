# Known issues and gotchas

- Any push that changes `bundle.json` starts the iOS workflow and a TestFlight build. Batch app changes.
- The Overpass (OSM) refresh in `osm.yml` can fail; `water.json` in the repo is the fallback.
- The Live Activity has to fit the lock-screen height; check it after layout changes.
- Trophy Club: Whitworth tee boxes aren't in OSM, so tee spots are estimates along the traced line; correct them on the course if they're off.
- Whitworth 15's greenside pond is hand-traced in build.py (missing from OSM).
- The CI Overpass fetch for Trophy Club waterways can return an error page; keep the committed `tcc_water.json`.
