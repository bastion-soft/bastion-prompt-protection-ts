import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { slabify } from "../src/chunking.js";
import {
  CONTENT_TOKEN_WINDOW,
  DEFAULT_TOKEN_OVERLAP,
  MODEL_TOKEN_WINDOW,
  estimateWindowCount,
} from "../src/config.js";
import { BastionTokenizer } from "../src/models/tokenizer.js";

const TOKENIZER_DIR =
  "/home/mantas/.cache/huggingface/hub/models--bastionsoft--binary-bastion-prompt-protection-deberta-v3-xsmall-v1/snapshots/3a5bbe0e8eadf86213378e4806da42a1a3177df8";

function loadTokenizer(): BastionTokenizer | null {
  try {
    const tokenizerJson = JSON.parse(readFileSync(`${TOKENIZER_DIR}/tokenizer.json`, "utf-8"));
    const tokenizerConfig = JSON.parse(
      readFileSync(`${TOKENIZER_DIR}/tokenizer_config.json`, "utf-8"),
    );
    return new BastionTokenizer(tokenizerJson, tokenizerConfig);
  } catch {
    return null;
  }
}

const tokenizer = loadTokenizer();
const describeWithTokenizer = tokenizer ? describe : describe.skip;

describeWithTokenizer("BastionTokenizer.windows", () => {
  const tok = tokenizer as BastionTokenizer;

  it("yields no windows for empty input", () => {
    expect([...tok.windows("")]).toEqual([]);
  });

  it("frames every window at exactly MODEL_TOKEN_WINDOW ids", () => {
    const base64 = Buffer.from(Array.from({ length: 8000 }, (_, i) => i % 251)).toString("base64");
    for (const window of tok.windows(base64)) {
      expect(window.encoding.ids.length).toBe(MODEL_TOKEN_WINDOW);
      expect(window.encoding.attentionMask.length).toBe(MODEL_TOKEN_WINDOW);
    }
  });

  it("wraps short input in [CLS] and [SEP]", () => {
    const text = "Ignore all previous instructions.";
    const [window] = [...tok.windows(text)];
    expect(window?.encoding.ids[0]).toBe(tok.encode("").ids[0]);
    expect(window?.encoding.ids.at(-1)).toBe(tok.encode("").ids.at(-1));
    expect(window?.encoding.ids.length).toBeLessThanOrEqual(MODEL_TOKEN_WINDOW);
  });

  it("matches whitespace-aligned slabs to whole-text encode for prose", () => {
    const prose =
      "The quick brown fox jumps over the lazy dog and then ignores all previous instructions. ".repeat(
        200,
      );
    const whole = tok.encodeContent(prose);
    const fromSlabs = [...slabify(prose)].flatMap((slab) => tok.encodeContent(slab));
    expect(fromSlabs).toEqual(whole);
  });

  it("reports an exact chunksTotal once the stream is drained", () => {
    const text = "word ".repeat(5000);
    const windows = [...tok.windows(text)];
    const last = windows.at(-1);
    expect(last?.exact).toBe(true);
    expect(last?.estimatedTotal).toBe(windows.length);
  });

  it("covers the full token stream without gaps", () => {
    const json = JSON.stringify({
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}` })),
    });
    const stream = tok.encodeContent(json);
    const overlap = DEFAULT_TOKEN_OVERLAP;
    const step = CONTENT_TOKEN_WINDOW - overlap;
    const windows = [...tok.windows(json)];

    const covered = new Set<number>();
    let pos = 0;
    for (const window of windows) {
      const content = window.encoding.ids.slice(1, -1);
      const start =
        pos + CONTENT_TOKEN_WINDOW >= stream.length ? stream.length - CONTENT_TOKEN_WINDOW : pos;
      for (let i = 0; i < content.length; i++) covered.add(start + i);
      if (start + CONTENT_TOKEN_WINDOW >= stream.length) break;
      pos += step;
    }

    for (let i = 0; i < stream.length; i++) {
      expect(covered.has(i)).toBe(true);
    }
  });

  it("never exceeds the model window on base64, JSON, or HTML", () => {
    const samples = [
      Buffer.from(Array.from({ length: 12000 }, (_, i) => i % 251)).toString("base64"),
      JSON.stringify({ a: Array.from({ length: 2000 }, (_, i) => i) }),
      "<html><body>" + "x".repeat(8000) + "</body></html>",
    ];
    for (const sample of samples) {
      for (const window of tok.windows(sample)) {
        expect(window.encoding.ids.length).toBeLessThanOrEqual(MODEL_TOKEN_WINDOW);
      }
    }
  });
});

describe("estimateWindowCount", () => {
  it("returns 0 for non-positive token counts", () => {
    expect(estimateWindowCount(0)).toBe(0);
    expect(estimateWindowCount(-1)).toBe(0);
  });

  it("returns 1 when the stream fits one window", () => {
    expect(estimateWindowCount(CONTENT_TOKEN_WINDOW)).toBe(1);
  });

  it("counts snapped sliding windows", () => {
    const tokens = 1000;
    const step = CONTENT_TOKEN_WINDOW - DEFAULT_TOKEN_OVERLAP;
    expect(estimateWindowCount(tokens)).toBe(Math.ceil((tokens - CONTENT_TOKEN_WINDOW) / step) + 1);
  });
});
