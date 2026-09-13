import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The committed data is read with fs at request time. Make sure it is
  // traced into every serverless function that needs it.
  outputFileTracingIncludes: {
    "/": ["./data/*.json"],
    "/mcp": ["./data/*.json"],
    "/api/**": ["./data/*.json"],
  },
};

export default nextConfig;
