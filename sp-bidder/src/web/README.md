# Web dashboard (src/web)

The BidPilot web UI + its server. Was parked under a hidden `.frontend/` for the
demo (a polished UI would have undercut the build pitch); un-hidden here as the
app's web layer for the production build. Intact and runnable.

- `../../public/` — the operator worklist page (worklist.html/js) + shared styles.css/fonts. Connect
  gate + simulator view + live read-only view.
- `server.js` — Express server that serves `public/` and exposes the demo + live
  APIs. Imports the engine/adapters from the sibling `../` modules (engine,
  platform, scheduler, config).
- UI dev tools (screenshot / smoke-test the dashboard) are parked in
  `../../scripts/archive/`.

Run it: `npm start` (-> `node src/web/server.js`), open http://localhost:4103.

The terminal demo does NOT use any of this — see `../../docs/demo-notes.md`.
