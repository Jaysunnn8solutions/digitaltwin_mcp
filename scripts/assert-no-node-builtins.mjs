// Build guard, run as postbuild. The engine reaches its data through the pure
// lib/data/store.ts; the Node reader lib/data/load.ts (node:fs, TWIN_DATA_DIR)
// must only ever be imported by server entry points. If a future import drags
// it into a client or worker chunk, Turbopack does not fail the build: it
// ships a stub that throws in the browser. This fails the build instead, and
// names the chunks, so the mistake is caught before deploy.
//
// Only .next/static/chunks/*.js is scanned. Turbopack also publishes the raw
// worker sources (.next/static/media/twin.worker.<hash>.ts and
// import.worker.<hash>.ts) as static assets, because `new URL("./x.worker.ts",
// import.meta.url)` is handled as an asset reference as well as a worker
// entry; the Worker itself boots the compiled chunk, so those copies are
// inert and are listed below for the record rather than scanned.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MARKERS = ["TWIN_DATA_DIR", "node:fs"];
const root = path.resolve(import.meta.dirname, "..");
// An optional directory argument exists so the guard itself can be exercised
// against a fixture without a build; postbuild passes nothing.
const chunks = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, ".next", "static", "chunks");

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

if (!existsSync(chunks) || !statSync(chunks).isDirectory()) {
  console.error(`assert-no-node-builtins: ${chunks} is missing; run this after \`next build\`.`);
  process.exit(1);
}

const files = walk(chunks, []);
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

console.log(`assert-no-node-builtins: ${files.length} browser chunk(s) clean (no ${MARKERS.join(", ")}).`);

// Worker source copies under static/media are not code the browser runs; name them so the output is not a surprise.
const media = path.join(path.dirname(chunks), "media");
if (existsSync(media) && statSync(media).isDirectory()) {
  const copies = readdirSync(media).filter((name) => /\.worker\.[^.]+\.ts$/.test(name));
  if (copies.length > 0) console.log(`assert-no-node-builtins: ${copies.length} inert worker source cop${copies.length === 1 ? "y" : "ies"} under static/media (not scanned): ${copies.join(", ")}`);
}
