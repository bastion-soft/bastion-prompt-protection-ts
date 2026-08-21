import { Tokenizer } from "@huggingface/tokenizers";
import { slabify } from "../chunking.js";
import {
  CONTENT_TOKEN_WINDOW,
  DEFAULT_SLAB_CHARS,
  DEFAULT_TOKEN_OVERLAP,
  MODEL_TOKEN_WINDOW,
  SPECIAL_TOKEN_BUDGET,
  estimateWindowCount,
  type WindowOptions,
} from "../config.js";

export interface Encoding {
  ids: number[];
  attentionMask: number[];
}

export interface TokenWindow {
  encoding: Encoding;
  /** Estimated windows covering the whole input; exact once `exact` is true. */
  estimatedTotal: number;
  /** True when the estimate is exact (stream fully tokenized). */
  exact: boolean;
}

/**
 * Wraps `@huggingface/tokenizers` to match Python's `tokenizers` exactly.
 *
 * The one behavioural gap between the two libraries is truncation: Python's
 * `Tokenizer.encode()` honours the `truncation` block embedded in
 * tokenizer.json, and the JS port does not. Without the shim below, any input
 * longer than `max_length` produces a longer sequence than Python's, different
 * logits, and a silently divergent risk score.
 *
 * HF truncates the *content* to (max_length - n_special_tokens) and then lets
 * the post-processor wrap it, yielding `[CLS] + content + [SEP]` of exactly
 * max_length. Reproduced here by keeping the leading slice and re-attaching the
 * trailing special token. Verified byte-identical against Python across the
 * full parity corpus.
 */
export class BastionTokenizer {
  private readonly tokenizer: Tokenizer;
  readonly maxLength: number | null;
  private readonly clsId: number;
  private readonly sepId: number;

  constructor(tokenizerJson: unknown, tokenizerConfig: unknown) {
    this.tokenizer = new Tokenizer(tokenizerJson as object, (tokenizerConfig ?? {}) as object);
    const truncation = (tokenizerJson as { truncation?: { max_length?: number } }).truncation;
    this.maxLength =
      truncation && typeof truncation.max_length === "number" ? truncation.max_length : null;

    const special = this.tokenizer.encode("");
    const specialIds = Array.from(special.ids ?? []);
    if (specialIds.length < 2) {
      throw new Error("tokenizer.encode('') must yield at least two special token ids");
    }
    this.clsId = specialIds[0] as number;
    this.sepId = specialIds[specialIds.length - 1] as number;
  }

  encode(text: string): Encoding {
    const enc = this.tokenizer.encode(text) as {
      input_ids?: ArrayLike<number>;
      ids?: ArrayLike<number>;
      attention_mask?: ArrayLike<number>;
    };
    let ids = Array.from(enc.input_ids ?? enc.ids ?? []);
    let attentionMask = Array.from(enc.attention_mask ?? []);

    const max = this.maxLength;
    if (max !== null && ids.length > max) {
      const tail = ids[ids.length - 1] as number;
      ids = ids.slice(0, max - 1);
      ids.push(tail);
      attentionMask = attentionMask.slice(0, max);
    }

    return { ids, attentionMask };
  }

  /** Tokenize content without `[CLS]` / `[SEP]`. */
  encodeContent(text: string): number[] {
    const enc = this.tokenizer.encode(text, { add_special_tokens: false }) as {
      input_ids?: ArrayLike<number>;
      ids?: ArrayLike<number>;
    };
    return Array.from(enc.input_ids ?? enc.ids ?? []);
  }

  /**
   * Lazily yield token-exact sliding windows over `text`.
   *
   * Character slabs keep tokenization linear; overlap and window size are
   * measured in content tokens, not characters.
   */
  *windows(text: string, options: WindowOptions = {}): Generator<TokenWindow> {
    const windowTokens = options.windowTokens ?? MODEL_TOKEN_WINDOW;
    const overlapTokens = options.overlapTokens ?? DEFAULT_TOKEN_OVERLAP;
    const slabChars = options.slabChars ?? DEFAULT_SLAB_CHARS;
    const contentWindow = windowTokens - SPECIAL_TOKEN_BUDGET;
    const step = Math.max(1, contentWindow - overlapTokens);

    if (contentWindow <= 0) {
      throw new Error(`windowTokens must exceed SPECIAL_TOKEN_BUDGET (${SPECIAL_TOKEN_BUDGET})`);
    }

    const stream: number[] = [];
    let charsConsumed = 0;
    const inputLength = text.length;
    let pos = 0;

    const projectTotal = (exact: boolean): number => {
      if (exact) return estimateWindowCount(stream.length, contentWindow, overlapTokens);
      if (stream.length === 0 || charsConsumed === 0) return 1;
      const density = stream.length / charsConsumed;
      const projectedTokens = density * inputLength;
      return estimateWindowCount(projectedTokens, contentWindow, overlapTokens);
    };

    const wrap = (content: readonly number[]): Encoding => {
      const ids = [this.clsId, ...content, this.sepId];
      return { ids, attentionMask: new Array(ids.length).fill(1) };
    };

    const emitAt = (start: number, exact: boolean): TokenWindow => ({
      encoding: wrap(stream.slice(start, start + contentWindow)),
      estimatedTotal: projectTotal(exact),
      exact,
    });

    for (const slab of slabify(text, slabChars)) {
      stream.push(...this.encodeContent(slab));
      charsConsumed += slab.length;

      while (stream.length >= pos + contentWindow + step) {
        yield emitAt(pos, false);
        pos += step;
      }
    }

    if (stream.length === 0) return;

    if (stream.length <= contentWindow) {
      yield emitAt(0, true);
      return;
    }

    while (true) {
      const start = pos + contentWindow >= stream.length ? stream.length - contentWindow : pos;
      const isLast = start + contentWindow >= stream.length;
      yield emitAt(start, isLast);
      if (isLast) break;
      pos += step;
    }
  }
}

/** Resolve the content-token budget from window options. Exported for tests. */
export function resolveContentWindow(options: WindowOptions = {}): number {
  const windowTokens = options.windowTokens ?? MODEL_TOKEN_WINDOW;
  return windowTokens - SPECIAL_TOKEN_BUDGET;
}

export { CONTENT_TOKEN_WINDOW };
