/**
 * Splits input into contiguous character slabs for bounded tokenization.
 *
 * Slabs are non-overlapping and lossless: `[...slabify(text)].join("") === text`.
 * Each slab is at most `slabChars` characters. When possible the cut lands on
 * whitespace so the concatenated token stream matches a single `encode()` call.
 * Whitespace-free runs (base64, minified JSON, HTML) are hard-cut at the limit.
 */
import { DEFAULT_SLAB_CHARS } from "./constants.js";

export function* slabify(text: string, slabChars: number = DEFAULT_SLAB_CHARS): Generator<string> {
  const limit = Math.max(1, slabChars);
  if (text.length === 0) return;

  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + limit, text.length);
    if (end < text.length) {
      let wsCut = -1;
      for (let i = end; i > pos; i--) {
        if (/\s/u.test(text[i - 1] ?? "")) {
          wsCut = i;
          break;
        }
      }
      if (wsCut > pos) end = wsCut;
    }
    yield text.slice(pos, end);
    pos = end;
  }
}
