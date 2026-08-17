import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The parity suite downloads ~98 MB of model weights on a cold cache.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
