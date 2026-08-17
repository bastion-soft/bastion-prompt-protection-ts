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
  constructor(readonly temperature: number = 1.0) {}

  transform(logits: readonly number[]): number[] {
    return logits.map((v) => v / this.temperature);
  }
}
