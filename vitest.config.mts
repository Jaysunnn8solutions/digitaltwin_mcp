import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "pipeline/**/*.test.ts"],
    env: {
      TWIN_DATA_DIR: path.resolve(import.meta.dirname, "data"),
    },
  },
});
