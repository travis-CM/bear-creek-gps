# GolfHub (Bear Creek GPS)

Travis Gafford's personal golf GPS and scramble scorer for Bear Creek Golf Club (East and West courses), DFW Airport, TX. Web app at https://travis-cm.github.io/bear-creek-gps/, plus a native iPhone + Apple Watch app on TestFlight ("GolfHub Travis"). Built for Travis and his playing partners; big, easy-to-read numbers, pin/center yardage most prominent.

Show all times in US Central. Keep replies short.

## How work runs here (orchestrator + workers)
- You (the main session) are the orchestrator. You plan, write briefs and check results. You don't do bulk work yourself when a worker can do it.
- Workers are subagents on Haiku: `.claude/agents/builder.md` and `.claude/agents/reviewer.md`. Every brief states the goal, the files to read, and a "Done when:" check that can be run or seen.
- Before accepting any worker's output, run its check yourself. If it fails, send it back with the failure. Never pass on a worker's report unchecked.
- Start of every session: read this file and `docs/progress.md`, `docs/decisions.md`, `docs/known-issues.md`. End of every session: update `progress.md`, add new decisions and gotchas, and run the `reflect` skill to propose skill edits with evidence from this session. Travis approves them before you apply them.
- Confirm with Travis before pushing to `main` (it redeploys the web app, and a `bundle.json` change starts a TestFlight build).

## Folder map
- `index.html`, `app.js`, `sw.js`, `manifest.json`, icons/logos — the web app (GitHub Pages from `main`).
- `course.json`, `osm.json`, `water.json`, `dem.bin` — course data (OSM shapes, waterways, USGS lidar elevation).
- `build.py` — builds course data from `osm.json` / `water.json`.
- `ios/` — native app source: `iOS/`, `Watch/`, `WatchWidget/`, `Live/` (Live Activity), `Shared/`, `project.yml` (XcodeGen).
- `bundle.json` — packed app source the iOS workflow unpacks.
- `.github/workflows/ios.yml` — builds and uploads to TestFlight when `bundle.json` changes. `osm.yml` — "Build course app" (course data + commit).
- `docs/progress.md`, `docs/decisions.md`, `docs/known-issues.md` — where we are, what's settled, gotchas.
- `.claude/agents/` — Haiku workers. `.claude/skills/` — one folder per repeatable task.

## Rules
- The "GolfHub" name and black/orange/white logo are a joke for testing buddies; change them before any App Store release.
- Credit data sources as the README does (OpenStreetMap, Esri, USGS 3DEP, Open-Meteo, GolfPass).
- Never commit App Store Connect keys; they live in GitHub secrets.
