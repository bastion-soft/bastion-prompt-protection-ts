import { Tokenizer } from "@huggingface/tokenizers";

export interface Encoding {
  ids: number[];
  attentionMask: number[];
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

  constructor(tokenizerJson: unknown, tokenizerConfig: unknown) {
    this.tokenizer = new Tokenizer(tokenizerJson as object, (tokenizerConfig ?? {}) as object);
    const truncation = (tokenizerJson as { truncation?: { max_length?: number } }).truncation;
    this.maxLength =
      truncation && typeof truncation.max_length === "number" ? truncation.max_length : null;
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
}
