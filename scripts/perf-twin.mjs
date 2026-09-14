// Performance check of the /twin page in a real browser: launches a headless
// Chromium (Edge on the Windows dev box) with the DevTools protocol on a
// local port, opens /twin with perf=1 and reads the numbers back over a raw
// WebSocket (Node 22+ has one built in; no dependency). With perf=1 the page
// auto-runs, plays at 300x from t for 600 frames, then publishes
// window.__twinPerf = { frameMs, drawCalls, triangles } from viewer.stats()
// and sets document.title to "twin:perf". The built-in buildings must stay
// inside design E's budget: frameMs <= 16 (60 fps) and drawCalls <= 150; the
// CSV sample import is reported but not enforced.
//
//   npm run build && npm run start -- --port 3100     # in another terminal
//   node scripts/perf-twin.mjs --url http://localhost:3100
//
// Options: --url <server> (default http://localhost:3000), --only <name,...>
// (dc-west, dc-east, dc-east-sample), --t <minute> (default 2010, Tuesday
// 09:30, the first morning with pick tours), --days (default 7, so 600 frames
// at 300x never reach the horizon), --week, --seed, --swiftshader (software
// rendering for a machine without a GPU: the frame time is then informational
// and only the draw-call budget fails the run), --timeout <real ms>.
// BROWSER_BIN overrides the browser. Headless Chromium uses the machine's GPU
// by default; the unmasked WebGL renderer is printed so a silent fallback to
// software rendering is visible in the log.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BUILDINGS = [
  { name: "dc-west", dc: "dc-west", src: null, enforce: true },
  { name: "dc-east", dc: "dc-east", src: null, enforce: true },
  { name: "dc-east-sample", dc: "dc-east", src: "sample", enforce: false },
];
const FRAME_MS_MAX = 16;
const DRAW_CALLS_MAX = 150;
const WIDTH = 1600;
const HEIGHT = 1000;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const POLL_MS = 500;

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const inline = argv[i].indexOf("=");
  return inline >= 0 ? argv[i].slice(inline + 1) : (argv[i + 1] ?? fallback);
}
const url = String(arg("url", "http://localhost:3000")).replace(/\/+$/, "");
const only = arg("only", null);
const week = Number(arg("week", 36));
const days = Number(arg("days", 7));
const seed = Number(arg("seed", 1));
const t = Number(arg("t", 2010));
const timeoutMs = Number(arg("timeout", 180_000));
const swiftshader = argv.includes("--swiftshader");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browserBin() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  if (existsSync(EDGE)) return EDGE;
  return "google-chrome";
}

/** Fails fast with the fix when nothing serves /twin, instead of a browser tab timing out on an error page. */
async function checkServer(tag) {
  let why = "";
  try {
    const r = await fetch(`${url}/twin`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) why = `answers ${r.status}`;
  } catch (err) {
    // undici wraps the socket error in `cause`; its `code` (ECONNREFUSED, ...) is the useful part.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
    why = `is not answering (${code || (cause instanceof Error && cause.message) || String(err)})`;
  }
  if (why) {
    console.error(`${tag}: ${url}/twin ${why}. Build and start the server first: npm run build, then npm run start -- --port 3100 and pass --url http://localhost:3100.`);
    process.exit(1);
  }
}

function perfUrl(b) {
  const hash = [`dc=${b.dc}`, `week=${week}`, `days=${days}`, `seed=${seed}`, `t=${t}`, ...(b.src ? [`src=${b.src}`] : []), "perf=1"];
  return `${url}/twin#${hash.join("&")}`;
}

// ---------------------------------------------------------------------------
// DevTools protocol over the built-in WebSocket: numbered requests, matched
// replies; events are not needed, the page's title is polled instead.
// ---------------------------------------------------------------------------

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.res(msg.result);
    });
    ws.addEventListener("error", () => reject(new Error(`could not connect to ${wsUrl}`)));
    ws.addEventListener("close", () => {
      for (const p of pending.values()) p.rej(new Error("DevTools connection closed"));
      pending.clear();
    });
  });
}

async function evaluate(page, expression) {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Chromium writes "<port>\n<browser endpoint path>" to DevToolsActivePort in the profile once it listens. */
async function devtoolsEndpoint(profile, child, deadline) {
  const file = path.join(profile, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the browser exited with code ${child.exitCode} before DevTools came up`);
    if (existsSync(file)) {
      const [port, browserPath] = readFileSync(file, "utf8").split(/\r?\n/);
      if (Number(port) > 0 && browserPath?.startsWith("/")) return { wsBase: `ws://127.0.0.1:${port}`, browserPath };
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for the DevTools port");
}

/** A private profile per launch: without one the launch is handed to any Edge window already open and exits at once. */
async function launch(bin) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "twin-perf-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    ...(swiftshader ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []),
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  let browser = null;
  let wsBase = "";
  try {
    const endpoint = await devtoolsEndpoint(profile, child, Date.now() + 30_000);
    wsBase = endpoint.wsBase;
    browser = await connect(`${wsBase}${endpoint.browserPath}`);
  } catch (err) {
    child.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${stderr.trim()}`);
  }
  return {
    browser,
    wsBase,
    async close() {
      await browser.send("Browser.close").catch(() => {});
      browser.close();
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        await Promise.race([exited, sleep(5000)]);
        if (child.exitCode === null) child.kill();
        await exited;
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** A fresh tab with an exact viewport and a fixed colour scheme, navigated to the page. */
async function openPage(b, pageUrl) {
  const { targetId } = await b.browser.send("Target.createTarget", { url: "about:blank" });
  const page = await connect(`${b.wsBase}/devtools/page/${targetId}`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.send("Page.navigate", { url: pageUrl });
  return {
    page,
    async close() {
      page.close();
      await b.browser.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

/** Polls until document.title is `want`; fails early on the page's own error notice. */
async function waitForTitle(page, want, deadline) {
  let title = "";
  while (Date.now() < deadline) {
    let state = null;
    try {
      // Right after Page.navigate the old document may still answer, or none; treat that as not ready.
      state = JSON.parse(await evaluate(page, `JSON.stringify({ title: document.title, error: document.querySelector(".twin-notice.error")?.textContent ?? "" })`));
    } catch {
      state = null;
    }
    if (state) {
      title = state.title;
      if (title === want) return;
      if (state.error) throw new Error(`the page reported an error: ${state.error.replace(/Dismiss$/, "").trim()}`);
    }
    await sleep(POLL_MS);
  }
  const text = await evaluate(page, "document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)").catch(() => "");
  throw new Error(`timed out after ${timeoutMs} ms waiting for document.title "${want}" (title "${title}"; page says: ${text})`);
}

// The unmasked WebGL renderer, so a run that silently fell back to software rendering says so.
const RENDERER_JS = `(() => {
  const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
  if (!gl) return "no WebGL";
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
})()`;

async function measure(b, building) {
  const started = Date.now();
  const tab = await openPage(b, perfUrl(building));
  try {
    await waitForTitle(tab.page, "twin:perf", started + timeoutMs);
    const raw = await evaluate(tab.page, "JSON.stringify(window.__twinPerf)");
    const stats = JSON.parse(raw ?? "null");
    if (!stats || typeof stats.frameMs !== "number" || typeof stats.drawCalls !== "number" || typeof stats.triangles !== "number") {
      throw new Error(`window.__twinPerf is not { frameMs, drawCalls, triangles }: ${raw}`);
    }
    const renderer = await evaluate(tab.page, RENDERER_JS);
    return { ...stats, renderer, seconds: (Date.now() - started) / 1000 };
  } finally {
    await tab.close();
  }
}

async function main() {
  const bin = browserBin();
  if (bin !== "google-chrome" && !existsSync(bin)) {
    console.error(`perf-twin: browser not found at ${bin}; set BROWSER_BIN to a Chromium binary.`);
    process.exit(1);
  }
  const wanted = only ? new Set(String(only).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const buildings = BUILDINGS.filter((b) => !wanted || wanted.has(b.name));
  if (buildings.length === 0) {
    console.error(`perf-twin: --only matched nothing; names are ${BUILDINGS.map((b) => b.name).join(", ")}.`);
    process.exit(1);
  }
  await checkServer("perf-twin");
  console.log(`perf-twin: ${url}/twin at t=${t} (week ${week}, ${days} days, seed ${seed}), 600 frames at 300x, ${WIDTH}x${HEIGHT}, ${swiftshader ? "SwiftShader" : "GPU"} with ${bin}`);
  const b = await launch(bin);
  let failed = 0;
  try {
    // One tab at a time, so no other page's rendering shares the GPU during a measurement.
    for (const building of buildings) {
      let s;
      try {
        s = await measure(b, building);
      } catch (err) {
        failed++;
        console.log(`FAIL ${building.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const frameOk = s.frameMs <= FRAME_MS_MAX;
      const callsOk = s.drawCalls <= DRAW_CALLS_MAX;
      // Software rendering cannot hit 16 ms at this size; report it, judge only the draw calls.
      const pass = !building.enforce || (swiftshader ? callsOk : frameOk && callsOk);
      if (!pass) failed++;
      const verdict = !building.enforce ? "reported only (an import)" : pass ? "ok" : "OVER BUDGET";
      console.log(
        `${pass ? "ok  " : "FAIL"} ${building.name}: frameMs ${s.frameMs.toFixed(2)} (max ${FRAME_MS_MAX}${swiftshader ? ", informational under SwiftShader" : ""}), drawCalls ${s.drawCalls} (max ${DRAW_CALLS_MAX}), triangles ${s.triangles.toLocaleString("en-US")}, ${s.seconds.toFixed(1)}s, ${verdict}`
      );
      console.log(`      renderer: ${s.renderer}`);
    }
  } finally {
    await b.close();
  }
  if (failed > 0) {
    console.error(`perf-twin: ${failed} of ${buildings.length} building(s) failed.`);
    process.exit(1);
  }
  console.log("perf-twin: every built-in building is inside the frame-time and draw-call budget.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
