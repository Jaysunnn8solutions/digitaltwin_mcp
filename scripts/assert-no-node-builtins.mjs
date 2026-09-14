// Build guard, run as postbuild. The engine reaches its data through the pure
// lib/data/store.ts; the Node reader lib/data/load.ts (node:fs, TWIN_DATA_DIR)
// must only ever be imported by server entry points. If a future import drags
// it into a client or worker chunk, Turbopack does not fail the build: it
// ships a stub that throws in the browser. This fails the build instead, and
// names the chunks, so the mistake is caught before deploy.
//
// Where the chunks are depends on who ran the build. A local `next build`
// writes .next/static/chunks; Vercel's build of the same app emits the
// Build Output API layout instead (.vercel/output/static/_next/static/chunks),
// and there is no .next/static at all, which is what broke the first deploy
// of the 3D twin. So the guard looks in every known place and, failing that,
// searches the build directories for any "chunks" folder. A build with no
// browser chunks anywhere is a layout this guard does not know: it warns and
// passes rather than block a deploy, because the unit test in
// lib/data/store.test.ts (the fresh engine graph registers no data) already
// proves lib/data/load is not in the worker graph.
//
// Turbopack also publishes the raw worker sources (static/media/
// twin.worker.<hash>.ts and import.worker.<hash>.ts) as static assets,
// because `new URL("./x.worker.ts", import.meta.url)` is handled as an asset
// reference as well as a worker entry; the Worker itself boots the compiled
// chunk, so those copies are inert and are listed for the record, not scanned.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MARKERS = ["TWIN_DATA_DIR", "node:fs"];
const root = path.resolve(import.meta.dirname, "..");
const KNOWN = [path.join(root, ".next", "static", "chunks"), path.join(root, ".vercel", "output", "static", "_next", "static", "chunks")];
const BUILD_DIRS = [path.join(root, ".next"), path.join(root, ".vercel", "output")];
const SKIP = new Set(["node_modules", "cache", "types", "server", "diagnostics"]);

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** Every directory named "chunks" under a build directory, a few levels deep, skipping server output and caches. */
function findChunkDirs(dir, depth, out) {
  if (depth < 0 || !isDir(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (name === "chunks") out.push(p);
    else findChunkDirs(p, depth - 1, out);
  }
  return out;
}

// An optional directory argument exists so the guard itself can be exercised
// against a fixture without a build; postbuild passes nothing.
let chunkDirs;
if (process.argv[2]) {
  const given = path.resolve(process.argv[2]);
  if (!isDir(given)) {
    console.error(`assert-no-node-builtins: ${given} is missing; run this after \`next build\`.`);
    process.exit(1);
  }
  chunkDirs = [given];
} else {
  chunkDirs = KNOWN.filter(isDir);
  if (chunkDirs.length === 0) chunkDirs = BUILD_DIRS.flatMap((d) => findChunkDirs(d, 6, []));
  if (chunkDirs.length === 0) {
    const built = BUILD_DIRS.filter(isDir);
    if (built.length === 0) {
      console.error(`assert-no-node-builtins: neither ${BUILD_DIRS.map((d) => path.relative(root, d)).join(" nor ")} exists; run this after \`next build\`.`);
      process.exit(1);
    }
    const listing = built.map((d) => `${path.relative(root, d)}/: ${readdirSync(d).join(", ")}`).join("; ");
    console.warn(`assert-no-node-builtins: WARNING no browser chunk directory found (${listing}); nothing scanned. Update KNOWN in scripts/assert-no-node-builtins.mjs for this layout.`);
    process.exit(0);
  }
}

const files = chunkDirs.flatMap((d) => walk(d, []));
const offending = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const hits = MARKERS.filter((m) => text.includes(m));
  if (hits.length > 0) offending.push(`${path.relative(root, file)} (${hits.join(", ")})`);
}

if (offending.length > 0) {
  console.error(`assert-no-node-builtins: ${offending.length} browser chunk(s) reference the Node data loader:`);
  for (const line of offending) console.error(`  ${line}`);
  console.error("Import lib/data/store (not lib/data/load) from anything that runs in the browser or a worker.");
  process.exit(1);
}

console.log(`assert-no-node-builtins: ${files.length} browser chunk(s) clean (no ${MARKERS.join(", ")}) in ${chunkDirs.map((d) => path.relative(root, d)).join(", ")}.`);

// Worker source copies under static/media are not code the browser runs; name them so the output is not a surprise.
for (const dir of chunkDirs) {
  const media = path.join(path.dirname(dir), "media");
  if (!isDir(media)) continue;
  const copies = readdirSync(media).filter((name) => /\.worker\.[^.]+\.ts$/.test(name));
  if (copies.length > 0) console.log(`assert-no-node-builtins: ${copies.length} inert worker source cop${copies.length === 1 ? "y" : "ies"} under ${path.relative(root, media)} (not scanned): ${copies.join(", ")}`);
}
