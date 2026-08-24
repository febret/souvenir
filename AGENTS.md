# AGENTS.md

This file guides coding agents working on Souvenir. It applies to the entire
repository.

## Project summary

Souvenir is a local-first OpenXR media viewer optimized for Meta Quest 3. A
FastAPI/Uvicorn server exposes a configured media library over LAN HTTPS. The
vanilla JavaScript/Three.js client places image and video panels over
passthrough and supports hand-ray interaction, masks, tags, commentary audio,
and background environment effects.

Read these documents before making cross-cutting changes:

- `README.md` - product requirements and quick start
- `doc/architecture.md` - server/client architecture and data flows
- `doc/user-guide.md` - user-visible behavior and controls

## Repository map

- `server/` - Python server, CLI/supervisor, TLS, media APIs, masks, tags, and
  commentary
- `app/index.html` - portal and scene shell
- `app/src/core/` - renderer-independent state, validation, selection, layout,
  and gesture math
- `app/src/services/` - browser HTTP API boundary
- `app/src/ui/` - portal controller and CSS
- `app/src/scene/` - Three.js/OpenXR scene, views, input, and rendering
- `app/public/` - source assets copied by Vite
- `app/dist/` - generated production client; do not edit manually
- `test/server/` - pytest tests
- `test/client/` - Vitest tests
- `test/browser/` - Playwright tests using the real portal/WebGL scene
- `scripts/` - project utility scripts

## Setup and commands

Install only the dependencies already declared by the project:

```bash
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
npm install
```

Common validation commands:

```bash
# Server
python -m pytest test/server -q

# Renderer-independent client tests
npm run test:client

# Production client build
npm run build

# Browser flows; bounded portal + serial WebGL lanes
npm run test:e2e

# Client + browser
npm test
```

Use the smallest relevant command while iterating, then run every affected
layer before finishing. Browser tests are long; do not treat a targeted pass as
a replacement for the full suite when scene behavior changed.

Run the application:

```bash
SOUVENIR_MEDIA_HOME=/path/to/media ./start.sh
```

Optional environment:

```bash
SOUVENIR_PORT=5000
SOUVENIR_COMMENTARY_DIR=/path/to/audio
```

On Windows without a POSIX shell:

```powershell
$env:SOUVENIR_MEDIA_HOME = "D:\Pictures"
python -m server --host 0.0.0.0 --port 8000 --https
```

Enter the literal command `\r` in the running supervisor console to replace the
Uvicorn worker and reload code/static assets without closing browser clients.

## Change discipline

- Make focused changes and preserve unrelated user work.
- Follow existing module boundaries instead of growing large files.
- Search for existing helpers before introducing similar state or math.
- Keep Python imports at module scope.
- Keep browser code as typed-by-convention ES modules; do not introduce a
  framework or TypeScript without an explicit project decision.
- Do not edit generated `app/dist/` files directly. Run `npm run build`.
- Do not add new build, lint, test, or package-management tools unless required
  by the requested feature.
- Update `doc/user-guide.md` when user-visible setup or interaction changes.
- Update `doc/architecture.md` when component responsibilities, persistence,
  APIs, or major data flows change.

## Server rules

### Filesystem trust boundary

All media and commentary inputs are untrusted relative paths.

- Reject absolute paths, drive-qualified paths, traversal, and symlink escape.
- Resolve media only under `SOUVENIR_MEDIA_HOME`.
- Resolve commentary only under `SOUVENIR_COMMENTARY_DIR`.
- Do not expose host paths in media/commentary response identifiers.
- Keep internal data inaccessible through general listing/file/thumbnail APIs.

Internal media-root data:

- `.souvenir-certs/`
- `.souvenir-thumbnails/`
- `.souvenir-masks/`
- `.souvenir-tags.json`

When adding a new internal file or directory, exclude it consistently from
listing, scanning, direct media access, and tests.

### API and persistence

- Preserve existing endpoint response shapes unless the change is intentional
  and every client/test is updated.
- Media/video/commentary seeking depends on correct HEAD and single byte-range
  responses.
- Keep errors explicit; do not return successful empty data for storage or
  validation failures.
- Validate upload MIME, actual content, size, dimensions, and safe target path.
- Use locks and atomic temporary-file replacement for server-persistent state.
- Keep tag definitions shared, while media assignments, commentary assignments,
  per-sound commentary captions, and per-sound volume remain distinct persisted
  namespaces.
- `library_id` scopes browser layouts to the resolved media root. Do not remove
  this reconciliation or stale paths can be replayed against another root.

### Supervisor and TLS

- Parent supervisor and `--worker` mode must not recurse.
- Preserve media/commentary environment, host, port, HTTPS, and certificate
  options across `\r` restarts.
- Keep Ctrl+C cleanup bounded and process-specific.
- Reuse the local CA. Expanding LAN SANs should reissue only the server
  certificate under the existing CA.

## Client architecture rules

### Ownership

- Portal DOM/readiness/settings belong to `HomeController`.
- HTTP details belong to `MediaApi`.
- Serializable panel state belongs to `PanelStore`.
- Pure selection, transform, aspect, display, commentary, and mask logic belongs
  in `app/src/core/`.
- Three.js objects, textures, and imperative interaction adapters belong in
  `app/src/scene/`.
- `SpatialApp` coordinates components; avoid moving all implementation logic
  into it.

### Persistence and asynchronous work

- Portal settings use `souvenir.settings`.
- Spatial state uses `souvenir.layout.v1` and must remain scoped by
  `libraryId`.
- Server-owned masks, tags, commentary assignments, captions, and per-sound
  volume must not be duplicated as authoritative browser state.
- Guard asynchronous media, mask, commentary, tag, and playlist operations with
  generations or serialization where out-of-order completion can corrupt state.
- Dispose replaced textures, canvases, videos, audio sources, listeners, and
  animation timers.

### Quest/OpenXR constraints

- Optimize for Quest 3 first; desktop preview is a development/testing adapter.
- Immersive AR requires HTTPS and a transparent alpha framebuffer.
- Passthrough pixels are not available for post-processing. Environment effects
  must remain a background overlay pass rendered before opaque virtual content.
- Render the effect pass, clear depth, then render panels/UI so virtual content
  is not tinted.
- Use the current XR stereo camera pose for camera-following effects.
- Input is based on WebXR target rays/select events. Buttons are
  activation-only; draggable surfaces explicitly opt into gesture targets.
- One- and two-hand panel/browser manipulation uses fixed ray-hit anchors and
  absolute transforms. Do not replace it with incremental deltas.
- Locked/content-zoom panels manipulate content, not the panel.
- Minimized panels remain fixed-size.
- Draw-mask mode must suppress panel movement and media navigation.

### Media and audio behavior

- Preserve stale-load guards when changing image/video loading.
- Video slideshows advance on `ended`; image slides advance by configured time.
- Tag filters use AND semantics and must affect browser results, playlists,
  previous/next, restoration, and slideshow.
- Commentary owns exactly one AR audio element. Selection is top-three
  score-weighted when positive matches exist, uniform when all scores are zero,
  and recomputed after `ended`.
- Commentary enablement is not persisted because browser audio requires a user
  gesture.

## Testing expectations

Add regression tests for root causes, not just happy paths.

- **Server tests:** temporary roots, traversal/symlink/internal-path rejection,
  response contracts, persistence/restart, malformed storage, concurrency, and
  rollback.
- **Client tests:** pure state and math, normalization, serialization,
  deterministic random boundaries, invalid inputs, and race guards.
- **Browser tests:** real DOM and WebGL scene interactions, API mocks, reload
  persistence, cross-panel behavior, and asynchronous response ordering.

Playwright uses four bounded workers: one portal lane and three scene spec files
that each run their WebGL tests serially. Keep this split unless repeated full
timing/stability runs prove another layout safe; unrestricted per-test
parallelism previously caused WebGL/connection failures. For projected canvas
clicks, prefer real pointer input.
When a long-run helper has already exercised that real path and a click
occasionally has no synchronous effect after many contexts, a narrowly scoped
no-effect-only retry or direct public-method fallback is acceptable; do not hide
actual application errors or assertion failures.

Hardware-only passthrough composition and optical hand tracking cannot be fully
validated by Playwright. Keep renderer-independent geometry thoroughly tested
and document a Quest smoke check for hardware-specific changes.

## Before finishing

1. Confirm the exact requested behavior, including persistence and error cases.
2. Run targeted tests while iterating.
3. Run the production build after client changes.
4. Run all affected full suites.
5. Perform a live server/API smoke test for new filesystem or process behavior.
6. Update user and architecture documentation.
7. Remove temporary project files and stop background processes.
