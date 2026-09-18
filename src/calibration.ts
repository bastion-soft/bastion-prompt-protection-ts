import { readFile } from "node:fs/promises";
import path from "node:path";

/** When labels.txt is missing, index 1 is the attack class in shipped models. */
export const DEFAULT_ATTACK_CLASS_INDEX = 1;

function softmax(logits: readonly number[]): number[] {
  const max = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}

/**
 * Single-parameter temperature scaling for calibrating classifier logits.
 *
 * Fit on a held-out validation set: minimize NLL by scaling logits by 1/T.
 * Loaded alongside model weights at inference time.
 *
 * Only the inference half is ported — the Python `fit()` is a scipy-backed
 * training-time helper that is never called at runtime.
 */
export class TemperatureScaler {
  constructor(
    readonly temperature: number = 1.0,
    private readonly attackClassIndex: number = DEFAULT_ATTACK_CLASS_INDEX,
  ) {}

  transform(logits: readonly number[]): number[] {
    return logits.map((v) => v / this.temperature);
  }

  attackProbability(logits: readonly number[]): number {
    const probs = softmax(this.transform(logits));
    if (probs.length === 0) return 0;
    const idx =
      this.attackClassIndex < probs.length ? this.attackClassIndex : DEFAULT_ATTACK_CLASS_INDEX;
    return probs[idx] ?? probs[0] ?? 0;
  }

  /**
   * Read temperature.json from the model snapshot, or fall back to T=1.0.
   *
   * Older model snapshots without a calibration file load with identity scaling
   * so the SDK remains backward-compatible.
   */
  static async fromModelDir(
    modelDir: string,
    labels: readonly string[] = [],
  ): Promise<TemperatureScaler> {
    const attackClassIndex = TemperatureScaler.resolveAttackClassIndex(labels);
    const file = path.join(modelDir, "temperature.json");
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(file, "utf-8"));
    } catch {
      return new TemperatureScaler(1.0, attackClassIndex);
    }

    const raw =
      typeof payload === "object" && payload !== null
        ? (payload as { temperature?: unknown }).temperature
        : undefined;
    const temperature = Number(raw);
    if (!Number.isFinite(temperature) || temperature <= 0) {
      // TODO(X5): library code should not write to stdout; inject a logger instead
      console.warn(
        `bastion-prompt-protection: could not load temperature.json ` +
          `(temperature must be a number > 0, got ${String(raw)}); falling back to identity scaling`,
      );
      return new TemperatureScaler(1.0, attackClassIndex);
    }
    return new TemperatureScaler(temperature, attackClassIndex);
  }

  private static resolveAttackClassIndex(labels: readonly string[]): number {
    const attackIdx = labels.findIndex(
      (label) => label.toLowerCase() === "attack" || label === "1",
    );
    if (attackIdx >= 0) return attackIdx;
    return labels.length > 1 ? DEFAULT_ATTACK_CLASS_INDEX : 0;
  }
}
