"use client";

import dynamic from "next/dynamic";

// The workbench reads window.location, spawns a worker and owns a WebGL
// canvas, so it never renders on the server: ssr:false is only allowed from a
// Client Component, which is why this file exists between page.tsx and it.
const TwinWorkbench = dynamic(() => import("./TwinWorkbench"), {
  ssr: false,
  loading: () => (
    <p className="sub" style={{ padding: "40px 0" }}>
      Loading the 3D twin…
    </p>
  ),
});

export default function TwinLoader() {
  return <TwinWorkbench />;
}
