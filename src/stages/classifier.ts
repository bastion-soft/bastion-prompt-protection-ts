import { TemperatureScaler } from "../calibration.js";
import { type ModelArtifact, type OnnxModelLoaderOptions, OnnxModelLoader } from "../models/loader.js";
import { type Encoding, type TokenWindow } from "../models/tokenizer.js";
import type { WindowOptions } from "../types.js";

export interface ClassifierScore {
  risk: number;
}

export class ClassifierStage {
  private readonly loader: OnnxModelLoader;
  private scaler = new TemperatureScaler(1.0);
  private calibrationLoaded = false;

  constructor(options: OnnxModelLoaderOptions) {
    this.loader = new OnnxModelLoader(options);
  }

  /**
   * Identifier for the currently loaded model build (7-char prefix of the
   * HuggingFace snapshot commit SHA). Returns null if the model hasn't been
   * loaded yet; does not trigger loading.
   */
  get modelVersion(): string | null {
    const sha = this.loader.snapshotSha;
    return sha === null ? null : sha.slice(0, 7);
  }

  async score(text: string): Promise<ClassifierScore> {
    const artifact = await this.loader.load();
    await this.ensureCalibration(artifact);
    return this.scoreEncoded(artifact.tokenizer.encode(text));
  }

  async scoreEncoded(encoding: Encoding): Promise<ClassifierScore> {
    const artifact = await this.loader.load();
    await this.ensureCalibration(artifact);

    const { ids, attentionMask } = encoding;
    const Tensor = artifact.createTensor;
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

    return { risk: this.scaler.attackProbability(raw) };
  }

  async *windows(text: string, options: WindowOptions = {}): AsyncGenerator<TokenWindow> {
    const artifact = await this.loader.load();
    yield* artifact.tokenizer.windows(text, options);
  }

  private async ensureCalibration(artifact: ModelArtifact): Promise<void> {
    if (this.calibrationLoaded) return;
    this.scaler = await TemperatureScaler.fromModelDir(artifact.modelDir, artifact.labels);
    this.calibrationLoaded = true;
  }
}
