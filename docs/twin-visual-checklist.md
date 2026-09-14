# 3D twin: visual checklist and browser harnesses

Two scripts exercise the `/twin` page in a real browser, and this page says what a reviewer looks for in the pictures they produce. Neither script needs a dependency: both drive a headless Chromium (Edge on the Windows dev box) over the DevTools protocol with the WebSocket client built into Node 22+.

- `scripts/screenshot-twin.mjs` renders one PNG per camera preset and building and fails only when a PNG is missing or too small to be a real frame. There is no golden-image diff on purpose: SwiftShader's software rasterizer drifts between machines and versions, so a person eyeballs the PNGs against the list below.
- `scripts/perf-twin.mjs` plays the twin for 600 frames and reads the renderer's frame time, draw calls and triangles back from the page; the built-in buildings must stay inside design E's budget.

## Running both

The page has to be built and served. `next start` serves the same chunks Vercel does; the dev server also works but is slower and not what ships.

```bash
npm run build                       # runs the postbuild guard against Node built-ins in browser chunks
npm run start -- --port 3100        # 3000 is the default; pick another port when it is taken
node scripts/screenshot-twin.mjs --url http://localhost:3100
node scripts/perf-twin.mjs --url http://localhost:3100
```

Both default to `--url http://localhost:3000`, check that `/twin` answers before launching a browser, and find the browser the same way: the `BROWSER_BIN` environment variable, else Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, else `google-chrome` on the PATH. Every launch uses a throwaway profile (`--user-data-dir` under the temp folder), so an Edge window that is already open is never reused and nothing is left behind.

### Screenshots

`node scripts/screenshot-twin.mjs [--url …] [--out <dir>] [--only <names>] [--t <minute>] [--days 2] [--week 36] [--seed 1] [--theme light|dark] [--size WxH] [--chrome] [--gpu] [--timeout <ms>]`

- Produces 15 PNGs: three buildings (`dc-west`, `dc-east`, `dc-east-sample`) times five presets (`overview`, `dock`, `pick`, `reserve`, `yard`). `dc-east-sample` is dc-east's staff and calendar on the CSV sample drawing: the page fetches `public/samples/sample-dc-locations.csv` and parses it through the import worker, exactly like the building picker's "Sample warehouse (CSV drawing)".
- Files are `<out>/<building>-<preset>.png`, for example `dc-east-dock.png`. `--out` defaults to `digitaltwin-shots` under the OS temp folder (`%TEMP%\digitaltwin-shots` on Windows, printed on the second line of the output). Pass `--out` to keep a set next to a review. A layout capture or a non-default viewport says so in the name: `dc-east-dock-chrome.png`, `dc-east-dock-chrome-1422x701.png`, `dc-east-dock-400x800.png`.
- Each shot opens `/twin#dc=<dc>&week=36&days=2&seed=1&t=<t>&cam=<preset>[&src=sample]&shot=1[&chrome=1]` in a fresh tab. With `shot=1` the page auto-runs, seeks to `t`, applies the preset, renders one frame at device pixel ratio 1 with day/night lighting and shadows off, hides its chrome (unless `chrome=1` is also set), stops its animation loop and sets `document.title` to `twin:ready`; the script waits for that title and captures the viewport with `Page.captureScreenshot`. The viewport is 1600 × 1000 unless `--size` says otherwise, and the colour scheme is emulated (`--theme light` by default), so the OS theme and display scaling of the machine do not change the pictures.
- `--size WxH` sets the viewport in pixels (`--size 1422x701`), for checking the page at a real window size rather than the review default. `--chrome` adds `chrome=1` to the hash so the page keeps its top bar, camera toolbar, HUD strip, clock, ticker, minimap, side panel and timeline; the frame is still deterministic. Use both together to review the layout (see "The layout" below).
- Rendering is SwiftShader (software) by default so the script runs on a box without a GPU and gives the same pixels run after run on one machine; `--gpu` uses the machine's GPU instead.
- Pass: every PNG exists and is over 30 KB. A blank, black or still-loading frame is mostly one flat colour and compresses to about 7 KB; a real frame of these buildings is 45 to 185 KB. The script prints one line per PNG (`ok`/`FAIL`, path, size, seconds) and exits 1 on any failure, printing the browser's stderr tail and the page's own error notice when there is one.
- `--only dc-east-dock,dc-east-sample-yard` re-shoots a subset. The whole set takes about 15 s on the dev box (the first tab pays for the chunk load, the rest under a second each).

Why not Chromium's own `--screenshot` with `--virtual-time-budget`, as first planned: virtual time runs out the moment the page's main thread idles, which is while the engine is still running in the Web Worker, so it captures the loading frame every time (a 7 KB PNG). Waiting for the page's `twin:ready` title over the DevTools protocol is what the page's shot mode was designed for.

#### Which minute to shoot

`t` is engine minutes from 00:00 on the Monday of `week`. Seed 1, week 36:

| `--t` | Clock | What is on the floor (dc-east) | Good for |
|---|---|---|---|
| `2010` (default) | Tuesday 09:30 | A supplier trailer docked at an inbound door with the receiver beside it, a store trailer docked at an outbound door, the forklift operator in the reserve with a `replenish` queue chip, a picker at the pick module | Trucks, doors, lanes, reserve, chips: the most checks in one frame |
| `570` | Monday 09:30 | Every roster worker in the pick module with `pick` queue chips, no trucks docked yet (day 0's inbound appointments and the first store truck come later in the morning) | Pickers and carts in the aisles |
| `630` | Monday 10:30 | The first store trailer loading at an outbound door, a picker and a replenishment | Loading |
| `1950` | Tuesday 08:30 | A supplier trailer with a `receive 6` chip and two workers at it | Receiving |
| `2100` | Tuesday 11:00 | `replenish 11` with two workers in the reserve | Replenishment pressure |

dc-west has fewer workers and orders; at the default minute nothing is docked and its two dock workers stand at the inbound doors. Shoot `--t 570` for its pickers.

### Performance

`node scripts/perf-twin.mjs [--url …] [--only <names>] [--t 2010] [--days 7] [--week 36] [--seed 1] [--swiftshader] [--timeout <ms>]`

- Opens `/twin#dc=<dc>&week=36&days=7&seed=1&t=<t>[&src=sample]&perf=1` for `dc-west`, `dc-east` and `dc-east-sample`. With `perf=1` the page auto-runs, plays at 300× from `t` for 600 frames, then publishes `window.__twinPerf = { frameMs, drawCalls, triangles }` (frameMs is the mean of `viewer.stats().frameMs` over those frames, the other two are the last frame's `renderer.info`) and sets `document.title` to `twin:perf`. Seven days so the 600 frames never reach the horizon.
- Budget (design E): `frameMs <= 16` and `drawCalls <= 150` for the two built-in buildings; the CSV sample is printed but not judged, because an import's size is the user's. Exit 1 when a built-in is over budget.
- Runs on the machine's GPU by default (headless Chromium uses it) and prints the unmasked WebGL renderer string per building, so a silent fallback to software rendering is visible in the log. `--swiftshader` forces software rendering for a box without a GPU; the frame time is then informational and only the draw-call budget can fail the run.
- Measured on the dev box (Intel UHD via ANGLE D3D11, 1600 × 1000): dc-west 0.9 ms, 52 draw calls, 39.8 k triangles; dc-east 0.6 ms, 73 draw calls, 64.1 k triangles; the CSV sample 0.6 ms, 79 draw calls, 52.4 k triangles. `frameMs` is the main-thread time of one `viewer.frame()` (sampling the playback, applying it to the scene, submitting the draw calls and projecting the labels), which is what the page can measure; the GPU's own time is not in it, so the number says the CPU side has room, not that a 4K canvas with shadows hits 60 fps.

## What to eyeball

Open the PNGs at 100 %. The same person should look at all fifteen: most checks are "the same thing looks the same in every building".

### Every shot

- Light theme and no night lighting: the floor is cream, the walls warm grey, the yard mid-grey; no dim blue cast, no glowing ceiling strips, no shadows (shadows are off in shot mode). The black area above the building and beyond the yard is expected: there is no sky dome or ground plane outside the site in v1.
- Without `--chrome`, the frame is the scene only: no top bar, HUD tiles, side panel, timeline, camera pill, minimap or ticker. The canvas fills the viewport inside the page's rounded 20 px stage frame.
- Nothing is missing or black: four walls, the racks of both zones, the doors on the dock wall, the yard road with its dashed centre line.
- Labels: a white pill with dark text over every worker on the floor (`W-E-003`) and every trailer that is docked or moving (`SUP-HARD truck`, `Buford Highway World Sweets truck`); blue pills over the process homes with the queued count (`receive 1`, `replenish 6`). Text is crisp and legible; a label may overlap a neighbour when two actors share a spot, but none is clipped or upside down.
- Colours match the 2D floor plan: green inbound doors on the left of the dock wall, orange outbound doors on the right; blue-grey pick racks, tan reserve racks; the staging band along the dock wall is a pale strip; pack stations are orange blocks.

### `overview` (above the yard, looking over the dock wall)

- The whole building is in frame with the yard road across the bottom; the two inbound doors, then the outbound doors, on the dock wall; the reserve block of tan racks on the left, the pick module on the right, the three orange pack stations just in front of the pick module (two at dc-west).
- Trailers backed onto the doors are white boxes with a green (supplier) or orange (store) tractor sticking out over the yard road; the queue spots are outlined rectangles in the yard in front of the inbound doors, one column per door, and are empty unless a truck is waiting for a door.
- Reserve positions hold brown (traditional) pallets and a few coloured ones (specialty categories) in the same racks the 2D plan puts them in; pick faces are green, amber and red strips.

### `dock` (eye level from the yard, looking at the dock face)

- Trailers sit with the rear at the dock face and the cab away from the building, wheels on the ground, no part inside the wall; the tractor colour says supplier or store.
- The receiver stands at the docked inbound trailer; behind an open inbound door the dock lane shows the pallets that have been unloaded and not yet put away (small boxes on the apron). At the CSV sample a forklift with a pallet on its forks is at the inbound door.
- Doors without a trailer show the pale door pad; outbound doors that are loading show the orange trailer.

### `pick` (from the depot, looking into the pick module)

- Every face is filled: the coloured slab's height is the fill level and its colour runs green (full) through amber (about one case left) to red (empty); racks with no faces are plain blue-grey.
- Pickers stand or walk in the aisles or at the depot in green vests; a picker on a tour pushes a cart. At the default minute one picker is at the module; `--t 570` puts every worker there.
- The pack stations are the orange blocks in the foreground; a station in use shows a packed pallet on it.

### `reserve` (over the reserve racks)

- Tan uprights and beams, four levels; brown pallets for traditional SKUs and coloured pallets for the specialty categories (the pink and amber ones at dc-east) with a `×n` badge where a position holds a stack.
- During a putaway or a replenishment the forklift is in the aisle with a pallet on its forks and its operator's label above it; between jobs it is parked on the apron.

### `yard` (further back, the whole dock face)

- The dock wall with every door, the yard road, the queue spots and the road's dashed centre line; trailers on the road or at the doors, none floating above it or sunk below.
- The black band beyond the road is expected (no ground plane outside the site).

### The CSV sample (`dc-east-sample-*`)

- Same checks. The walls come from the drawing's outline, so the building is the sample's shape, not dc-east's; racks, doors and zones are where the CSV puts them; the pick module and reserve are colour-ramped and stocked like the built-ins because the same engine ran on it.

### The layout (`--chrome`, one preset is enough)

The page is an app at 1000 px and wider and a document below that. Capture three sizes and look for these things; the first-run hint shows in every capture because the browser profile is fresh.

```bash
node scripts/screenshot-twin.mjs --url http://localhost:3100 --chrome --size 1422x701 --only dc-east-overview
node scripts/screenshot-twin.mjs --url http://localhost:3100 --chrome --size 1280x720 --only dc-east-overview
node scripts/screenshot-twin.mjs --url http://localhost:3100 --chrome --size 400x800 --only dc-east-overview
```

- `1422x701` and `1280x720` (a laptop window): the page fills the viewport exactly, nothing below the fold and no page scrollbar. One compact top bar (crumb, title, run chips, Run again, Copy link). The stage is the hero: it takes every pixel between the top bar and the timeline, with the side panel (Scenario, Inspector, Network, Compare, Help) to its right at 320 to 360 px, scrolling inside itself (the Labor tab's lower cards are cut by the panel's bottom edge, not by the page). Over the stage, top-left: the camera toolbar (Orbit, Follow, Walk, the five presets, View, ?) on one row with every button 32 px tall, then the HUD strip on its own row under it (six headline tiles, the queue sparkline with the waiting count, More). Top-right: the clock pill with the day and time, the speed (`300×` on a fresh load), paused/playing and `skips quiet hours`. Bottom-left: the hint (its Got it button on one line) above the ticker, three lines at 701 px and five at taller windows. Bottom-right: the minimap. The timeline is docked at the bottom with Play, the step buttons, the speed row with `300×` selected, the skip-quiet checkbox, the clock and the `?` legend button; its strip shows the day bands, the queue-pressure area and the red playhead at `t`.
- `400x800` (a phone): single column with 16 px gutters. Top bar wrapped onto three rows, then the stage at 320 px tall showing the building under a toolbar reduced to Orbit, Follow, View and ?; no clock pill or minimap; the ticker at most three lines. Under the stage: the hint as a full-width block, the HUD tiles in a wrapping strip, the timeline with its transport wrapped and the clock on its own last row with `?` at the right, and the side panel as a bottom sheet whose tab row peeks up from the bottom edge. The page scrolls; no horizontal scrollbar.
- What a capture cannot show, check by hand in a browser: More expands the HUD in place (every tile, the queue bars and today's trucks) and Less or Esc collapses it; the View menu and the timeline's `?` legend open as popovers and close on Esc or a click elsewhere; Got it removes the hint and it stays gone after a reload (localStorage `twin.hint.v1`); clicking a toolbar button never orbits or picks on the canvas underneath.

## When a check fails

- A PNG under 30 KB or a black canvas: the page never reached `twin:ready`. Run `node scripts/perf-twin.mjs --only <building>` for the WebGL renderer string (a `no WebGL` answer means the browser flags lost the SwiftShader fallback), and open the same hash in a normal browser to read the page's error notice; the script prints that notice when the page shows one.
- The screenshot script times out with `page says: Simulating…`: the worker did not finish; open the hash in a browser and check the console for a worker error (a rejected scenario posts an error notice instead).
- A trailer 25 ft off the dock or facing the building: the `trailerPose` regression that integration 1 fixed (rear at the door origin, heading `-inward`); `lib/trace/compile.test.ts` pins it.
- Inbound pallets tinted a different category than their rack: the pallet `colorIdx` order (traditional first, then specialty categories in first-seen order) drifted between `lib/trace/compile.ts` and `lib/three/apply.ts`.
- Draw calls over 150 on a built-in: something is no longer merged or instanced; compare with the numbers above per building.
