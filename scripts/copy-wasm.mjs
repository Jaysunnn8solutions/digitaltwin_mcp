// Copy web-ifc's WebAssembly binary next to the site root, where the browser
// import worker loads it for IFC files. Runs before dev and build, so the
// served copy always matches the installed web-ifc version.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const from = path.join(root, "node_modules", "web-ifc", "web-ifc.wasm");
const to = path.join(root, "public", "web-ifc.wasm");
mkdirSync(path.dirname(to), { recursive: true });
copyFileSync(from, to);
console.log("copied web-ifc.wasm to public/");
