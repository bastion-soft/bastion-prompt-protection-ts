import { TemperatureScaler } from "../calibration.js";
import { type ModelArtifact, type OnnxModelLoaderOptions, OnnxModelLoader } from "../models/loader.js";
import { type TokenEncoding, type TokenWindow } from "../models/tokenizer.js";
import type { WindowOptions } from "../types.js";

export class ClassifierStage {
  private readonly loader: OnnxModelLoader;
  private scaler = new TemperatureScaler(1.0);
  private calibrationPromise: Promise<void> | null = null;

  constructor(options: OnnxModelLoaderOptions) {
    this.loader = new OnnxModelLoader(options);
  }

  /**
   * Identifier for the currently loaded model build (7-char prefix of the
   * HuggingFace snapshot commit SHA). Returns null if the model hasn't been
   * loaded yet; does not trigger loading.
   */
  get modelVersion(): string | null {
    const revision = this.loader.snapshotRevision;
    return revision === null ? null : revision.slice(0, 7);
  }

  async score(text: string): Promise<number> {
    const artifact = await this.loader.load();
    await this.ensureCalibration(artifact);
    return this.scoreEncoded(artifact.tokenizer.encode(text));
  }

  async scoreEncoded(encoding: TokenEncoding): Promise<number> {
    const artifact = await this.loader.load();
    await this.ensureCalibration(artifact);

    const { ids, attentionMask } = encoding;
    const Tensor = artifact.TensorClass;
    const dims = [1, ids.length];
    const feeds: Record<string, InstanceType<typeof Tensor>> = {
      input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), dims),
      attention_mask: new Tensor("int64", BigInt64Array.from(attentionMask, BigInt), dims),
    };
    if (artifact.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new Tensor("int64", new BigInt64Array(ids.length), dims);
    }

    const outputs = await artifact.session.run(feeds);
    const first = outputs[artifact.session.outputNames[0] as string];
    const raw = Array.from(first?.data as Float32Array, Number);

    return this.scaler.attackProbability(raw);
  }

  async *windows(text: string, options: WindowOptions = {}): AsyncGenerator<TokenWindow> {
    const artifact = await this.loader.load();
    yield* artifact.tokenizer.windows(text, options);
  }

  private ensureCalibration(artifact: ModelArtifact): Promise<void> {
    this.calibrationPromise ??= TemperatureScaler.fromModelDir(
      artifact.modelDir,
      artifact.labels,
    ).then((scaler) => {
      this.scaler = scaler;
    }).catch((err) => {
      this.calibrationPromise = null;
      throw err;
    });
    return this.calibrationPromise;
  }
}
