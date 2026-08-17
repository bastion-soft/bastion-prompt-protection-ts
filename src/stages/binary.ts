import { readFile } from "node:fs/promises";
import path from "node:path";
import { TemperatureScaler } from "../calibration.js";
import { OnnxModelLoader } from "../models/loader.js";

/**
 * Returned when model weights are not yet available. Sits exactly between
 * safe_below and attack_above so it routes to whichever next stage is enabled
 * without falsely classifying anything.
 */
export const NEUTRAL_RISK = 0.5;

export interface BinaryPrediction {
  risk: number;
  available: boolean;
}

export class BinaryStage {
  private readonly loader: OnnxModelLoader;
  // Default to identity scaling (T=1.0); replaced with the fitted value the
  // first time the model loads successfully.
  private scaler = new TemperatureScaler(1.0);
  private calibrationLoaded = false;

  constructor(
    readonly modelId: string,
    cacheDir?: string,
  ) {
    this.loader = new OnnxModelLoader(modelId, cacheDir);
  }

  isAvailable(): Promise<boolean> {
    return this.loader.isAvailable();
  }

  /**
   * Identifier for the currently loaded model build (7-char prefix of the
   * HuggingFace snapshot commit SHA). Returns null if the model hasn't been
   * loaded yet; does not trigger loading.
   */
  get modelVersion(): string | null {
    const sha = this.loader.revision;
    return sha === null ? null : sha.slice(0, 7);
  }

  async predict(text: string): Promise<BinaryPrediction> {
    if (!(await this.isAvailable())) {
      return { risk: NEUTRAL_RISK, available: false };
    }

    const artifact = await this.loader.artifact();

    // Lazy-load temperature.json on first use. Done here (not in the
    // constructor) because the snapshot directory only exists after the loader
    // has fetched the model.
    if (!this.calibrationLoaded) {
      this.scaler = await loadTemperature(artifact.modelDir);
      this.calibrationLoaded = true;
    }

    const { ids, attentionMask } = artifact.tokenizer.encode(text);

    const ort = await import("onnxruntime-node");
    const dims = [1, ids.length];
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), dims),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(attentionMask, BigInt), dims),
    };
    if (artifact.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(ids.length), dims);
    }

    const outputs = await artifact.session.run(feeds);
    const first = outputs[artifact.session.outputNames[0] as string];
    const raw = Array.from(first?.data as Float32Array, Number);

    // Apply temperature calibration to the raw logits before softmax.
    // If temperature.json was missing, the scaler is identity (T=1.0).
    const probs = softmax(this.scaler.transform(raw));
    // Convention: index 1 is the attack class.
    const attackProb = probs.length > 1 ? (probs[1] as number) : (probs[0] as number);

    return { risk: attackProb, available: true };
  }
}

/**
 * Read temperature.json from the model snapshot, or fall back to T=1.0.
 *
 * Older model snapshots without a calibration file load with identity scaling
 * so the SDK remains backward-compatible.
 */
async function loadTemperature(modelDir: string): Promise<TemperatureScaler> {
  const file = path.join(modelDir, "temperature.json");
  let payload: { temperature?: unknown };
  try {
    payload = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return new TemperatureScaler(1.0);
  }
  try {
    const temperature = Number(payload.temperature);
    if (!Number.isFinite(temperature) || temperature <= 0) {
      throw new Error(`temperature must be > 0, got ${String(payload.temperature)}`);
    }
    return new TemperatureScaler(temperature);
  } catch (err) {
    console.warn(
      `bastion-prompt-protection: could not load temperature.json ` +
        `(${err instanceof Error ? err.message : String(err)}); falling back to identity scaling`,
    );
    return new TemperatureScaler(1.0);
  }
}

export function softmax(logits: readonly number[]): number[] {
  const max = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}
