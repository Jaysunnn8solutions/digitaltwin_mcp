/**
 * Write the sample warehouse in every import format to public/samples, for
 * the web page's "try a sample" buttons and for anyone testing an importer.
 *   npm run samples
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sampleCsv, sampleDxf, sampleIfc, sampleImdf, sampleIndoors } from "../lib/layout/samples";

const dir = path.resolve(import.meta.dirname, "..", "public", "samples");
mkdirSync(dir, { recursive: true });
const write = (name: string, data: string | Uint8Array) => {
  writeFileSync(path.join(dir, name), data);
  console.log(`wrote public/samples/${name}`);
};
write("sample-dc.dxf", sampleDxf());
write("sample-dc-locations.csv", sampleCsv());
write("sample-dc-imdf.zip", sampleImdf());
for (const [name, text] of Object.entries(sampleIndoors())) write(name, text);
write("sample-dc.ifc", sampleIfc());
