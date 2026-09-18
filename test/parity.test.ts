/**
 * Golden-fixture parity against the Python implementation.
 *
 * The fixture is produced by running the real Python `Guard()` over a shared
 * 113-case corpus (see the repo README). It is the only oracle for the ONNX
 * path — the Python package has no unit test covering the classifier stage — so
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

/**
 * Empty input skips the classifier in TS; the Python fixture scored 0.3521 via
 * truncated `encode()` under `max_windows=1`.
 */
const SLIDING_WINDOW_DEVIATIONS: Record<string, { risk: number; label: string }> = {
  "edge-000": { risk: 0, label: "safe" },
};

/** First sliding window vs truncated encode: scores drift slightly, labels agree. */
const RELAXED_SCORE_TOLERANCE_CASES = new Set(["long-005", "long-006"]);
const RELAXED_SCORE_TOLERANCE = 0.1;

// Disable normalization so the raw fixture text reaches the model unchanged.
// maxInputChars is pinned to 8000 here because parity.json was generated with
// that limit — not because 8000 is the SDK default (262144).
const guard = new Guard({ normalizeWhitespace: false, maxInputChars: 8000 });

beforeAll(async () => {
  await guard.protect("warmup");

  // Fail once, clearly, if the weights never loaded. Without this, warmup may
  // throw ModelUnavailableError and every case below fails opaquely.
  if (guard.modelVersion === null) {
    throw new Error(
      "Model weights did not load, so there is nothing to compare against. " +
        "Warmup likely threw ModelUnavailableError — check the log for " +
        '"bastion-prompt-protection: model … unavailable" and the underlying ' +
        "cause (network, HuggingFace rate limit, corrupt cache). " +
        "This is an environment failure, not a parity failure.",
    );
  }
}, 600_000);

describe("parity with the Python implementation", () => {
  it("loads the same model snapshot the fixture was generated from", () => {
    expect(guard.modelVersion).toBe(fixture.meta.model_version);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const result = await guard.protect(c.text, { maxWindows: 1 });

    const deviation = SLIDING_WINDOW_DEVIATIONS[c.id];
    if (deviation !== undefined) {
      expect(result.risk).toBeCloseTo(deviation.risk, 4);
      expect(result.label).toBe(deviation.label);
      return;
    }

    const scoreTolerance = RELAXED_SCORE_TOLERANCE_CASES.has(c.id)
      ? RELAXED_SCORE_TOLERANCE
      : CROSS_PLATFORM_TOLERANCE;
    expect(Math.abs(result.risk - c.risk)).toBeLessThan(scoreTolerance);
    expect(result.stageReached).toBe(c.stage_reached === "binary" ? "classifier" : c.stage_reached);

    // The verdict must match — except where it cannot. An input scoring within
    // the drift band of the threshold has no platform-stable label: `long-002`
    // scores 0.4761 on darwin/arm64 and 0.5022 on linux/x64, either side of
    // 0.5. That is the tolerance doing its job, not a disagreement about the
    // input, so only assert the label where it is actually determinable.
    const threshold = guard.config.thresholds.attackAbove;
    const onTheFence =
      !IS_REFERENCE_PLATFORM && Math.abs(c.risk - threshold) < CROSS_PLATFORM_TOLERANCE;

    if (!onTheFence) {
      expect(result.label).toBe(c.label);
    }
  });

  it(`reproduces every score${IS_REFERENCE_PLATFORM ? " with zero drift" : " within tolerance"}`, async () => {
    let maxDiff = 0;
    for (const c of fixture.cases) {
      const result = await guard.protect(c.text, { maxWindows: 1 });
      const deviation = SLIDING_WINDOW_DEVIATIONS[c.id];
      if (deviation !== undefined) {
        maxDiff = Math.max(maxDiff, Math.abs(result.risk - deviation.risk));
        continue;
      }
      const diff = Math.abs(result.risk - c.risk);
      if (RELAXED_SCORE_TOLERANCE_CASES.has(c.id)) {
        expect(diff).toBeLessThan(RELAXED_SCORE_TOLERANCE);
        continue;
      }
      maxDiff = Math.max(maxDiff, diff);
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
