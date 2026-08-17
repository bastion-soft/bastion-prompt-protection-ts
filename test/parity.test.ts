/**
 * Golden-fixture parity against the Python implementation.
 *
 * The fixture is produced by running the real Python `Guard()` over a shared
 * 113-case corpus (see the repo README). It is the only oracle for the ONNX
 * path — the Python package has no unit test covering the binary stage — so
 * this suite pins tokenizer + ONNX inference + temperature scaling together.
 *
 * Downloads ~98 MB of model weights on a cold cache; excluded from `npm test`
 * and run via `npm run test:parity`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Guard } from "../src/index.js";

interface ParityCase {
  id: string;
  group: string;
  text: string;
  heuristic_score: number;
  risk: number;
  label: string;
  stage_reached: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf-8"),
) as {
  meta: { model_version: string; model_id: string; sdk_version: string };
  cases: ParityCase[];
};

/**
 * The fixture was generated on darwin/arm64, and ONNX Runtime's INT8 kernels
 * are only bit-reproducible on the architecture they were measured on. Scores
 * drift slightly elsewhere; labels do not.
 */
const IS_REFERENCE_PLATFORM = process.platform === "darwin" && process.arch === "arm64";
const CROSS_PLATFORM_TOLERANCE = IS_REFERENCE_PLATFORM ? 1e-4 : 0.05;

const guard = new Guard();

beforeAll(async () => {
  await guard.protect("warmup");

  // Fail once, clearly, if the weights never loaded. Without this the guard
  // silently degrades to heuristics-only — by design — and every case below
  // fails on its own terms, burying the real cause under a hundred assertion
  // errors about labels and stages.
  if (guard.modelVersion === null) {
    throw new Error(
      "Model weights did not load, so there is nothing to compare against. " +
        "The guard degraded to heuristics-only. Look earlier in the log for a " +
        '"bastion-prompt-protection: model … unavailable" warning with the ' +
        "underlying cause (network, HuggingFace rate limit, corrupt cache). " +
        "This is an environment failure, not a parity failure.",
    );
  }
}, 600_000);

describe("parity with the Python implementation", () => {
  it("loads the same model snapshot the fixture was generated from", () => {
    expect(guard.modelVersion).toBe(fixture.meta.model_version);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const result = await guard.protect(c.text);
    // The verdict is what callers act on, and it must match everywhere.
    expect(result.label).toBe(c.label);
    expect(result.stageReached).toBe(c.stage_reached);
    // Scores are held to a tolerance off the reference platform — see below.
    expect(Math.abs(result.risk - c.risk)).toBeLessThan(CROSS_PLATFORM_TOLERANCE);
  });

  it(`reproduces every score${IS_REFERENCE_PLATFORM ? " with zero drift" : " within tolerance"}`, async () => {
    let maxDiff = 0;
    for (const c of fixture.cases) {
      const result = await guard.protect(c.text);
      maxDiff = Math.max(maxDiff, Math.abs(result.risk - c.risk));
    }

    if (IS_REFERENCE_PLATFORM) {
      // The fixture was generated from Python here, so scores must be exact.
      expect(maxDiff).toBe(0);
    } else {
      // INT8 kernels take different code paths per architecture, so exact
      // equality is not portable. Measured on linux/arm64: 75/113 bit-exact,
      // max diff 0.0142, zero label flips. Verdict agreement is the guarantee;
      // this bound catches a real regression without failing on that drift.
      expect(maxDiff).toBeLessThan(CROSS_PLATFORM_TOLERANCE);
    }
  });
});
