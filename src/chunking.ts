/**
 * Splits content into units small enough for the detector to actually see.
 *
 * Two problems make whole-document scanning useless on large tool results:
 *
 * 1. **Truncation.** The model reads at most 512 tokens (~2,000 characters).
 *    Anything past that is never examined — an injection at offset 5,000 in a
 *    20 KB file scores bit-identically to the clean file.
 * 2. **Dilution.** Even inside the window, a short injection surrounded by
 *    benign text is scored down. The same phrase that scores 0.99 alone drops
 *    below the threshold with a few hundred characters of context around it.
 *
 * Fixed-width windows handle neither well: too small and benign fragments
 * trigger false positives, too large and the payload is diluted, and in between
 * detection depends on where the payload happens to fall relative to a boundary.
 *
 * So split on natural boundaries (line ends and sentence ends) instead, then
 * merge consecutive pieces until each unit reaches `minLen`. Injections
 * generally occupy their own sentence or line, so they land in a unit of their
 * own rather than being diluted or cut in half.
 */
export type ChunkOptions = {
  /** Merge consecutive pieces until a unit reaches at least this many chars. */
  minLen: number;
  /** Split any single piece longer than this, so one huge line can't hide a payload. */
  maxLen: number;
  /**
   * Characters of the previous chunk to repeat at the start of the next.
   *
   * Guards against a payload being cut in half. Structural boundaries make that
   * unlikely — splits land at sentence and line ends — but content with no
   * punctuation at all (minified JSON, long log lines) goes through the
   * `maxLen` hard slice, which cuts blindly.
   *
   * **Defaults to 0, and measurement supports that.** Swept over the balanced
   * indirect benchmarks at threshold 0.9: overlap 0 gives 87.5% TPR / 17.4%
   * FPR, overlap 60 gives 87.8% / 17.2% for 31% more scans, overlap 119 gives
   * 88.3% / 18.3% for 81% more scans. Per sample, overlap 60 recovered 17
   * attacks but lost 15 and added 14 false positives — near-symmetric, so the
   * apparent gain is noise. It loses detections because repeating the previous
   * chunk's tail adds benign context to a chunk holding an injection, diluting
   * exactly the signal chunking exists to isolate.
   *
   * Worth enabling only if your content is dominated by the hard-slice path.
   * Clamped below `minLen` so chunking always terminates.
   */
  overlap?: number;
};

/**
 * Defaults chosen by sweeping chunk size and threshold *jointly* over the
 * indirect-injection benchmarks (BIPIA, InjecAgent, Z-Edgar, TensorTrust),
 * balanced, n=1300. At threshold 0.9:
 *
 * ```
 * config     scans   TPR ± se      FPR ± se
 * 80/300     5769    87.5 ± 1.3    19.1 ± 1.5
 * 120/400    4576    87.5 ± 1.3    17.4 ± 1.5   <- default
 * 160/400    3944    86.5 ± 1.3    16.3 ± 1.4
 * 200/500    3387    85.8 ± 1.4    15.8 ± 1.4
 * 120/600    4468    87.5 ± 1.3    17.2 ± 1.5
 * ```
 *
 * Read this honestly: 120/400 sits on a *plateau*, not a peak. It ties 80/300
 * and 120/600 on detection exactly, and every neighbour is within one standard
 * error — the data cannot distinguish them. What it does show is that `minLen`
 * drives the false-positive rate monotonically (bigger chunks fragment less),
 * while `maxLen` barely matters at all.
 *
 * So 120/400 is "on the plateau and cheap", not "provably best". Raise `minLen`
 * to 160-200 if false positives matter more than the last point of detection;
 * that also cuts scans by 14-26%.
 *
 * The ranking is stable across thresholds 0.5/0.8/0.9/0.95 with no crossover,
 * so these parameters do not need re-tuning when the threshold moves.
 *
 * Note that content is chunked unconditionally, with no "only if it's long
 * enough" shortcut. That looks wasteful and isn't: measured on those benchmarks
 * at threshold 0.9, chunking everything scores 87.5% TPR / 17.4% FPR, while
 * chunking only text over 2,000 characters drops to 86.3% / 17.5% — worse
 * detection for no gain.
 *
 * The reason is that truncation is not the only problem chunking solves. Only
 * ~5% of those samples exceed the token window, yet chunking still gains two
 * points of detection, so most of the benefit comes from undoing *dilution*: a
 * short injection inside a longer benign passage is scored down even when the
 * model reads every word of it. Splitting isolates the payload. Gating by
 * length only addresses truncation and discards that.
 */
export const DEFAULT_CHUNK_OPTIONS: Readonly<ChunkOptions> = Object.freeze({
  minLen: 120,
  maxLen: 400,
});

/**
 * The classifier reads at most this many tokens — roughly 2,000 characters of
 * English. `Guard.protect()` never examines content beyond it.
 */
export const MODEL_TOKEN_WINDOW = 512;

/** Line ends, or sentence ends followed by whitespace. */
const BOUNDARY = /(?<=[.!?])\s+|\n+/;

export function chunkContent(
  text: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): string[] {
  const { minLen, maxLen } = options;
  // Overlap at or above minLen would carry a whole chunk forward and never
  // make progress.
  const overlap = Math.max(0, Math.min(options.overlap ?? 0, minLen - 1));

  const pieces = text
    .split(BOUNDARY)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);

  const chunks: string[] = [];
  let buffer = "";
  /** Trailing text of the previous chunk, repeated at the start of the next. */
  let carry = "";

  const remember = (chunk: string): void => {
    carry = overlap > 0 ? chunk.slice(-overlap) : "";
  };

  const flush = (): void => {
    if (!buffer) return;
    chunks.push(buffer);
    remember(buffer);
    buffer = "";
  };

  for (const piece of pieces) {
    // An oversized piece (a minified file, a long log line) is emitted on its
    // own, sliced down so a payload buried inside it still gets its own unit.
    // This is the one path that cuts without regard for content, so it is where
    // overlap actually earns its cost.
    if (piece.length >= maxLen) {
      flush();
      const step = Math.max(1, maxLen - overlap);
      for (let i = 0; i < piece.length; i += step) {
        chunks.push(piece.slice(i, i + maxLen));
        if (i + maxLen >= piece.length) break;
      }
      remember(piece);
      continue;
    }

    if (!buffer && carry) buffer = carry;
    buffer = buffer ? `${buffer} ${piece}` : piece;
    if (buffer.length >= minLen) flush();
  }
  flush();

  // Content with no boundaries at all still has to be scanned.
  return chunks.length > 0 ? chunks : [text];
}
