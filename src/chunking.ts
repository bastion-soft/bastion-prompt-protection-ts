/**
 * Splits content into fixed-width windows the detector can actually read.
 *
 * The classifier is truncated at `MODEL_TOKEN_WINDOW` tokens. A conservative
 * character budget for that window is `DEFAULT_CHUNK_OPTIONS.maxLen` (1024),
 * so a token shorter than four characters still fits. Text that fits in one
 * window is scanned as-is (after trim). Longer text is covered by a sliding
 * window: every slice is exactly `maxLen` characters, consecutive slices
 * overlap by at least `MIN_OVERLAP`, and the last slice is aligned to the
 * end so it is never short.
 *
 * Example: length 600, window 500 → `[0, 500)` and `[100, 600)`.
 */
export type ChunkOptions = {
  /** Window length in characters. Defaults to 1024. */
  maxLen?: number;
  /**
   * Characters repeated from the previous window. Defaults to `MIN_OVERLAP`.
   * Raised to `MIN_OVERLAP` and clamped below `maxLen` so the slide terminates.
   */
  overlap?: number;
};

export const MIN_OVERLAP = 50;

/**
 * The classifier reads at most this many tokens. The default character window
 * is half of a 4-chars-per-token estimate, so short tokens still fit.
 */
export const MODEL_TOKEN_WINDOW = 512;

export const DEFAULT_CHUNK_OPTIONS: Readonly<Required<ChunkOptions>> = Object.freeze({
  maxLen: 1024,
  overlap: MIN_OVERLAP,
});

export function chunkContent(
  text: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): string[] {
  const maxLen = Math.max(1, options.maxLen ?? DEFAULT_CHUNK_OPTIONS.maxLen);
  const overlap = Math.min(
    maxLen - 1,
    Math.max(MIN_OVERLAP, options.overlap ?? DEFAULT_CHUNK_OPTIONS.overlap),
  );
  const step = maxLen - overlap;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [""];
  if (trimmed.length <= maxLen) return [trimmed];

  const chunks: string[] = [];
  let pos = 0;

  while (true) {
    const start = pos + maxLen >= trimmed.length ? trimmed.length - maxLen : pos;
    const chunk = trimmed.slice(start, start + maxLen);
    if (chunk.trim().length > 0) chunks.push(chunk);
    if (start + maxLen >= trimmed.length) break;
    pos += step;
  }

  return chunks;
}
