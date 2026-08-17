import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The parity, known-deviations and protect-chunked suites each construct a
    // Guard, so in parallel they race to warm the same cold model cache and all
    // but one fail. Run files one at a time; the suite is fast either way.
    fileParallelism: false,
    // The first run downloads ~98 MB of model weights.
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
