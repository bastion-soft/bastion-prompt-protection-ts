/**
 * Known, characterised deviations from the Python implementation.
 *
 * Scoring 19,361 real benchmark prompts head-to-head against Python found
 * three inputs where the risk score differs. None changes the verdict. They are
 * pinned here so the deviation stays bounded: if a dependency bump widens one,
 * or introduces a new class of divergence, this fails.
 *
 * Deliberately NOT folded into parity.test.ts — that suite asserts exactness,
 * and these are the documented exceptions to it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Guard } from "../src/index.js";

interface DeviationCase {
  id: string;
  source: string;
  text: string;
  python_risk: number;
  ts_risk: number;
  cause: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/known-deviations.json", import.meta.url), "utf-8"),
) as { model_version: string; measured_over: number; cases: DeviationCase[] };

/**
 * These deviations were measured on darwin/arm64. ONNX Runtime's INT8 kernels
 * drift a little on other architectures (linux/arm64: max 0.0142), so the
 * score bound relaxes off the reference platform. The verdict assertion does
 * not — that must hold everywhere.
 */
const IS_REFERENCE_PLATFORM = process.platform === "darwin" && process.arch === "arm64";
const SCORE_TOLERANCE = IS_REFERENCE_PLATFORM ? 1e-3 : 0.05;

// Disable normalization: fixture scores were measured on raw text.
const guard = new Guard({ normalizeWhitespace: false });

beforeAll(async () => {
  await guard.protect("warmup");
  if (guard.modelVersion === null) {
    throw new Error(
      "Model weights did not load; these cases all exercise the ONNX stage. " +
        'Look for a "bastion-prompt-protection: model … unavailable" warning ' +
        "earlier in the log. This is an environment failure, not a parity failure.",
    );
  }
}, 600_000);

describe("known deviations from Python", () => {
  it("is measured against the model the fixture was built from", () => {
    expect(guard.modelVersion).toBe(fixture.model_version);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))(
    "%s stays within tolerance and keeps Python's verdict",
    async (_id, c) => {
      const result = await guard.protect(c.text, { maxWindows: 1 });

      // The verdict must still agree with Python — that is the hard contract.
      const pythonLabel = c.python_risk >= 0.5 ? "attack" : "safe";
      expect(result.label).toBe(pythonLabel);

      // And the divergence must not grow beyond what we measured.
      expect(Math.abs(result.risk - c.python_risk)).toBeLessThanOrEqual(SCORE_TOLERANCE);

      // Reproduce the exact value we recorded, so a change is visible.
      if (IS_REFERENCE_PLATFORM) {
        expect(result.risk).toBeCloseTo(c.ts_risk, 4);
      }
    },
  );

  it("documents a cause for every deviation", () => {
    for (const c of fixture.cases) {
      expect(c.cause.length).toBeGreaterThan(20);
    }
  });
});
