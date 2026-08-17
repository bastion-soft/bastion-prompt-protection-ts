import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "node",
  // Native binding + large tokenizer/hub libs stay external; they are real
  // dependencies, not things to inline into the bundle.
  external: ["onnxruntime-node", "@huggingface/hub", "@huggingface/tokenizers"],
});
