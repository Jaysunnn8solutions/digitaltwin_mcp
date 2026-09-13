import type { Metadata } from "next";
import Link from "next/link";
import ImportWorkbench from "@/components/ImportWorkbench";

export const metadata: Metadata = {
  title: "Import a building · Distribution-center twin",
  description: "Upload a DXF, WMS location CSV, ArcGIS Indoors GeoJSON, IMDF archive or IFC model and run the distribution-center twin in it.",
};

export default function ImportPage() {
  return (
    <main>
      <p className="sub">
        <Link href="/">← Distribution-center twin</Link>
      </p>
      <h1>Run the twin in your building</h1>
      <p className="lede">
        Bring a floor plan. The twin finds the racks, aisles and dock doors, shows you how it read the drawing, and simulates a fortnight of candystore&apos;s store orders,
        supplier trucks and crew in it. Nothing you upload is stored.
      </p>
      <ImportWorkbench />
    </main>
  );
}
