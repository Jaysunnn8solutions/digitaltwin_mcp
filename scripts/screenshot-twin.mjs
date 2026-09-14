// Visual verification of the /twin page: one PNG per camera preset and
// building, rendered by a headless Chromium (Edge on the Windows dev box)
// under SwiftShader so no GPU is needed. This is not a golden-image diff:
// SwiftShader output drifts between machines and versions, so a reviewer
// eyeballs the PNGs against docs/twin-visual-checklist.md. The script only
// checks that every PNG exists and is over MIN_BYTES; a blank, black or
// half-loaded frame is mostly one flat colour and compresses far smaller.
//
//   npm run build && npm run start -- --port 3100     # in another terminal
//   node scripts/screenshot-twin.mjs --url http://localhost:3100
//
// Options: --url <server> (default http://localhost:3000), --out <dir>
// (default <tmp>/digitaltwin-shots), --only <name,...> (a subset such as
// dc-east-dock,dc-east-sample-yard), --t <minute> (default 2010, Tuesday
// 09:30, the first morning with pick tours: day 0's orders are released at
// 17:00 for day 1), --days, --week, --seed, --theme light|dark (default
// light, emulated so the OS setting does not change the shots), --size WxH
// (viewport, default 1600x1000), --chrome (keep the page chrome: top bar,
// HUD, side panel, timeline, so the capture shows the layout), --gpu (skip
// SwiftShader on a machine with a GPU), --timeout <real ms>. BROWSER_BIN
// overrides the browser.
//
// The page does the rest. With shot=1 in the hash it auto-runs, seeks to t,
// applies the preset, renders one deterministic frame (DPR 1, day/night and
// shadows off, chrome hidden unless chrome=1 is also set), stops its
// animation loop and sets document.title to "twin:ready". The script drives
// the browser over the DevTools protocol (a raw WebSocket; Node 22+ has one
// built in): one browser, a fresh tab per shot, wait for that title,
// Page.captureScreenshot. Chromium's own --screenshot / --virtual-time-budget
// cannot be used: virtual time runs out the moment the main thread idles,
// which is while the engine is still running in the worker, so it captures
// the loading frame.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PRESETS = ["overview", "dock", "pick", "reserve", "yard"];
// The CSV sample imports public/samples/sample-dc-locations.csv through the
// import worker before it runs, exactly like the page's building picker.
const BUILDINGS = [
  { name: "dc-west", dc: "dc-west", src: null },
  { name: "dc-east", dc: "dc-east", src: null },
  { name: "dc-east-sample", dc: "dc-east", src: "sample" },
];
const MIN_BYTES = 30 * 1024;
const DEFAULT_SIZE = "1600x1000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const POLL_MS = 250;

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const inline = argv[i].indexOf("=");
  return inline >= 0 ? argv[i].slice(inline + 1) : (argv[i + 1] ?? fallback);
}
const url = String(arg("url", "http://localhost:3000")).replace(/\/+$/, "");
const outDir = path.resolve(String(arg("out", path.join(os.tmpdir(), "digitaltwin-shots"))));
const only = arg("only", null);
const week = Number(arg("week", 36));
const days = Number(arg("days", 2));
const seed = Number(arg("seed", 1));
const t = Number(arg("t", 2010));
const theme = String(arg("theme", "light")) === "dark" ? "dark" : "light";
const timeoutMs = Number(arg("timeout", 120_000));
const gpu = argv.includes("--gpu");
const chrome = argv.includes("--chrome");
const sizeArg = String(arg("size", DEFAULT_SIZE));
const sizeMatch = /^(\d{3,4})x(\d{3,4})$/.exec(sizeArg);
if (!sizeMatch) {
  console.error(`screenshot-twin: --size wants WxH in pixels such as 1422x701, not "${sizeArg}".`);
  process.exit(1);
}
const WIDTH = Number(sizeMatch[1]);
const HEIGHT = Number(sizeMatch[2]);
// Default-size, frame-only files keep their plain names so an existing review set stays comparable;
// a layout capture or another viewport says so in the name.
const suffix = `${chrome ? "-chrome" : ""}${sizeArg === DEFAULT_SIZE ? "" : `-${sizeArg}`}`;

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

function shotUrl(b, preset) {
  const hash = [`dc=${b.dc}`, `week=${week}`, `days=${days}`, `seed=${seed}`, `t=${t}`, `cam=${preset}`, ...(b.src ? [`src=${b.src}`] : []), "shot=1", ...(chrome ? ["chrome=1"] : [])];
  return `${url}/twin#${hash.join("&")}`;
}

// ---------------------------------------------------------------------------
// DevTools protocol over the built-in WebSocket: numbered requests, matched
// replies; events are not needed, the page's title is polled instead.
// ---------------------------------------------------------------------------

// A request the browser never answers (seen on the dev box: browser and tab
// up, renderers running, no reply, no close) would otherwise wait forever,
// past every --timeout, since only the title poll has a deadline. A bounded
// wait per request and per handshake turns that into a failed shot instead.
const REPLY_MS = 30_000;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    const handshake = setTimeout(() => {
      ws.close();
      reject(new Error(`no DevTools handshake from ${wsUrl} in ${REPLY_MS} ms`));
    }, REPLY_MS);
    ws.addEventListener("open", () => {
      clearTimeout(handshake);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`no reply to ${method} in ${REPLY_MS} ms`));
            }, REPLY_MS);
            pending.set(id, { res, rej, timer });
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
      clearTimeout(p.timer);
      if (msg.error) p.rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.res(msg.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(handshake);
      reject(new Error(`could not connect to ${wsUrl}`));
    });
    ws.addEventListener("close", () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.rej(new Error("DevTools connection closed"));
      }
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
  const profile = mkdtempSync(path.join(os.tmpdir(), "twin-shot-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    ...(gpu ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
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
    stderr: () => stderr,
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

/** A fresh tab with an exact viewport and an emulated colour scheme, navigated to the page. */
async function openPage(b, pageUrl) {
  const { targetId } = await b.browser.send("Target.createTarget", { url: "about:blank" });
  const page = await connect(`${b.wsBase}/devtools/page/${targetId}`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
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

async function shoot(b, building, preset) {
  const file = path.join(outDir, `${building.name}-${preset}${suffix}.png`);
  rmSync(file, { force: true });
  const started = Date.now();
  let bytes = 0;
  let why = "";
  const tab = await openPage(b, shotUrl(building, preset));
  try {
    await waitForTitle(tab.page, "twin:ready", started + timeoutMs);
    const shot = await tab.page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    bytes = statSync(file).size;
    if (bytes < MIN_BYTES) why = `${(bytes / 1024).toFixed(1)} KB is under ${MIN_BYTES / 1024} KB, a blank frame`;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  } finally {
    await tab.close();
  }
  const ok = bytes >= MIN_BYTES;
  console.log(`${ok ? "ok  " : "FAIL"} ${file}  ${(bytes / 1024).toFixed(1)} KB  ${((Date.now() - started) / 1000).toFixed(1)}s${ok ? "" : `  ${why}`}`);
  return ok;
}

async function main() {
  const bin = browserBin();
  if (bin !== "google-chrome" && !existsSync(bin)) {
    console.error(`screenshot-twin: browser not found at ${bin}; set BROWSER_BIN to a Chromium binary.`);
    process.exit(1);
  }
  const wanted = only ? new Set(String(only).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const shots = [];
  for (const b of BUILDINGS) for (const preset of PRESETS) if (!wanted || wanted.has(`${b.name}-${preset}`)) shots.push([b, preset]);
  if (shots.length === 0) {
    console.error(`screenshot-twin: --only matched nothing; names are <building>-<preset> with buildings ${BUILDINGS.map((b) => b.name).join(", ")} and presets ${PRESETS.join(", ")}.`);
    process.exit(1);
  }
  await checkServer("screenshot-twin");
  mkdirSync(outDir, { recursive: true });
  console.log(`screenshot-twin: ${shots.length} shot(s) of ${url}/twin at t=${t} (week ${week}, ${days} days, seed ${seed}, ${theme} theme, ${WIDTH}×${HEIGHT}, ${chrome ? "with chrome" : "frame only"}, ${gpu ? "GPU" : "SwiftShader"}) with ${bin}`);
  console.log(`screenshot-twin: writing to ${outDir}`);
  const b = await launch(bin);
  let failed = 0;
  try {
    // Sequential: SwiftShader is CPU-bound, and one tab at a time keeps each frame's timing its own.
    for (const [building, preset] of shots) if (!(await shoot(b, building, preset))) failed++;
  } finally {
    await b.close();
  }
  if (failed > 0) {
    const tail = b.stderr().trim().split("\n").filter((l) => !l.includes("fallback_task_provider")).slice(-6);
    if (tail.length) console.log(tail.map((l) => `      ${l}`).join("\n"));
    console.error(`screenshot-twin: ${failed} of ${shots.length} screenshot(s) missing or under ${MIN_BYTES / 1024} KB. Is the server at ${url} built with the /twin page?`);
    process.exit(1);
  }
  console.log(`screenshot-twin: ${shots.length} PNG(s) over ${MIN_BYTES / 1024} KB in ${outDir}; check them against docs/twin-visual-checklist.md.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
