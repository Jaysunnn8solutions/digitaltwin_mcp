import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "pipeline/**/*.test.ts"],
    // Registers the Node data provider for every test file.
    setupFiles: ["./vitest.setup.ts"],
    env: {
      TWIN_DATA_DIR: path.resolve(import.meta.dirname, "data"),
    },
  },
});
