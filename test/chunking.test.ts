import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_OPTIONS, MODEL_TOKEN_WINDOW, chunkContent } from "../src/chunking.js";

describe("chunkContent", () => {
  it("splits on sentence and line boundaries", () => {
    const chunks = chunkContent("First sentence here. Second sentence here. Third one here.", {
      minLen: 10,
      maxLen: 400,
    });
    expect(chunks).toEqual(["First sentence here.", "Second sentence here.", "Third one here."]);
  });

  it("merges short pieces up to minLen so fragments are not scanned alone", () => {
    // Standalone fragments score erratically; merging keeps units meaningful.
    const chunks = chunkContent("a.\nb.\nc.\nd.\ne.\nf.", { minLen: 8, maxLen: 400 });
    expect(chunks.every((c) => c.length >= 8 || c === chunks.at(-1))).toBe(true);
    expect(chunks.join(" ")).toContain("a.");
    expect(chunks.join(" ")).toContain("f.");
  });

  it("splits a single oversized piece so a payload cannot hide inside it", () => {
    const long = "x".repeat(1000);
    const chunks = chunkContent(long, { minLen: 100, maxLen: 250 });
    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => c.length <= 250)).toBe(true);
  });

  it("preserves all content", () => {
    const text = "Alpha beta gamma. Delta epsilon.\nZeta eta theta. Iota kappa.";
    const joined = chunkContent(text, { minLen: 5, maxLen: 400 }).join(" ");
    for (const word of text.split(/\s+/)) {
      expect(joined).toContain(word.replace(/[\n]/g, ""));
    }
  });

  it("always returns at least one chunk", () => {
    expect(chunkContent("", DEFAULT_CHUNK_OPTIONS)).toEqual([""]);
    expect(chunkContent("   ", DEFAULT_CHUNK_OPTIONS)).toEqual(["   "]);
    expect(chunkContent("no boundaries at all", DEFAULT_CHUNK_OPTIONS)).toHaveLength(1);
  });

  describe("overlap", () => {
    // No punctuation, so everything goes through the maxLen hard slice — the
    // one path that cuts without regard for content.
    const unpunctuated = "alpha ".repeat(200);

    it("defaults to none, leaving chunks disjoint", () => {
      const chunks = chunkContent(unpunctuated, { minLen: 120, maxLen: 400 });
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startsWith(chunks[i - 1]!.slice(-40))).toBe(false);
      }
    });

    it("repeats the tail of the previous chunk when asked", () => {
      const chunks = chunkContent(unpunctuated, { minLen: 120, maxLen: 400, overlap: 60 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[1]!.startsWith(chunks[0]!.slice(-60))).toBe(true);
    });

    it("costs more chunks", () => {
      const none = chunkContent(unpunctuated, { minLen: 120, maxLen: 400 });
      const some = chunkContent(unpunctuated, { minLen: 120, maxLen: 400, overlap: 100 });
      expect(some.length).toBeGreaterThanOrEqual(none.length);
    });

    it("clamps below minLen so it always terminates", () => {
      // An overlap >= minLen would carry a whole chunk forward and never progress.
      const chunks = chunkContent(unpunctuated, { minLen: 120, maxLen: 400, overlap: 10_000 });
      expect(chunks.length).toBeLessThan(100);
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  it("exposes the model window so callers can reason about truncation", () => {
    expect(MODEL_TOKEN_WINDOW).toBe(512);
    expect(DEFAULT_CHUNK_OPTIONS.minLen).toBeLessThan(DEFAULT_CHUNK_OPTIONS.maxLen);
  });

  it("keeps chunks well inside the model window", () => {
    // maxLen is in characters; the window is in tokens. A chunk must never be
    // large enough to be truncated itself, or chunking would solve nothing.
    const approxCharsPerToken = 4;
    expect(DEFAULT_CHUNK_OPTIONS.maxLen).toBeLessThan(MODEL_TOKEN_WINDOW * approxCharsPerToken);
  });
});
