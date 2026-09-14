import type { Metadata } from "next";
import "./twin.css";
import TwinLoader from "@/components/twin/TwinLoader";

export const metadata: Metadata = {
  title: "3D twin · Distribution-center twin",
  description: "Watch the distribution-center twin run: supplier trucks, putaway, pick tours, packing and store trucks, simulated in your browser and played back in 3D.",
};

// A Server Component with no request-time APIs, so /twin prerenders as a
// static shell; everything interactive lives behind the client-only loader.
export default function TwinPage() {
  return (
    <main className="twin-main">
      <TwinLoader />
    </main>
  );
}
