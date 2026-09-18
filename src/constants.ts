/** The classifier reads at most this many tokens including special tokens. */
export const MODEL_TOKEN_WINDOW = 512;

/** `[CLS]` and `[SEP]` reserved by the post-processor. */
export const SPECIAL_TOKEN_BUDGET = 2;

/** Content tokens per window after special tokens are attached. */
export const CONTENT_TOKEN_WINDOW = MODEL_TOKEN_WINDOW - SPECIAL_TOKEN_BUDGET;

/** Default overlap between consecutive windows, in content tokens. */
export const DEFAULT_TOKEN_OVERLAP = 64;

/**
 * Maximum characters per tokenization slab. Keeps `@huggingface/tokenizers`
 * linear on multi-kilobyte input; whitespace-aligned cuts preserve the same
 * token stream as a single `encode()` call.
 */
export const DEFAULT_SLAB_CHARS = 512;

/** Total input length bound before token windowing (characters, not tokens). */
export const DEFAULT_MAX_INPUT_CHARS = 262_144;

/** Estimate how many windows cover a token stream of the given length. */
export function estimateWindowCount(
  tokenCount: number,
  contentWindow = CONTENT_TOKEN_WINDOW,
  overlapTokens = DEFAULT_TOKEN_OVERLAP,
): number {
  if (tokenCount <= 0) return 0;
  if (tokenCount <= contentWindow) return 1;
  const step = Math.max(1, contentWindow - overlapTokens);
  return Math.ceil((tokenCount - contentWindow) / step) + 1;
}
