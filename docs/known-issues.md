# Known issues and gotchas

- Any push that changes `bundle.json` starts the iOS workflow and a TestFlight build. Batch app changes.
- The Overpass (OSM) refresh in `osm.yml` can fail; `water.json` in the repo is the fallback.
- The Live Activity has to fit the lock-screen height; check it after layout changes.
