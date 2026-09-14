// Runs in every test file's worker before the test module is imported, so the
// suites that never import lib/data/load themselves (simulation.test.ts,
// import.test.ts) still find the committed data through the store. The data
// directory comes from TWIN_DATA_DIR, set in vitest.config.mts.
import "./lib/data/load";
