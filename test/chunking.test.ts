import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_OPTIONS, MODEL_TOKEN_WINDOW, chunkContent } from "../src/chunking.js";

describe("chunkContent", () => {
  it("returns one empty chunk for empty or whitespace-only input", () => {
    expect(chunkContent("")).toEqual([""]);
    expect(chunkContent("   ")).toEqual([""]);
    expect(chunkContent("\n\t  \n")).toEqual([""]);
  });

  it("returns exactly one trimmed chunk when the trimmed text fits in the window", () => {
    expect(chunkContent("  hello  ", { maxLen: 500 })).toEqual(["hello"]);
    expect(chunkContent("hello  world", { maxLen: 500 })).toEqual(["hello  world"]);
    expect(chunkContent("a".repeat(500), { maxLen: 500 })).toEqual(["a".repeat(500)]);
  });

  it("does not otherwise modify a short trimmed chunk", () => {
    const text = "hello\n\nworld.  yes!";
    expect(chunkContent(`  ${text}  `, { maxLen: 500 })).toEqual([text]);
  });

  it("snaps the last window to the end so no window is shorter than maxLen", () => {
    const text = "x".repeat(600);
    const chunks = chunkContent(text, { maxLen: 500, overlap: 50 });

    expect(chunks).toEqual([text.slice(0, 500), text.slice(100, 600)]);
    expect(chunks.every((chunk) => chunk.length === 500)).toBe(true);
  });

  it("covers the start and end of long input", () => {
    const text = "abcdefghijklmnopqrstuvwxyz".repeat(40);
    const chunks = chunkContent(text, { maxLen: 500, overlap: 50 });

    expect(chunks[0]).toBe(text.slice(0, 500));
    expect(chunks.at(-1)).toBe(text.slice(text.length - 500));
  });

  it("keeps at least the configured overlap between consecutive windows", () => {
    const text = Array.from({ length: 1600 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
    const chunks = chunkContent(text, { maxLen: 500, overlap: 80 });

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]).toContain(chunks[i - 1]!.slice(-80));
    }
  });

  it("uses a fixed stride and snaps the last window, even when that nearly duplicates the previous", () => {
    const text = "a".repeat(2000);
    const chunks = chunkContent(text, { maxLen: 1024, overlap: 50 });

    expect(chunks).toEqual([
      text.slice(0, 1024),
      text.slice(974, 1998),
      text.slice(976, 2000),
    ]);
  });

  it("skips windows that are only whitespace", () => {
    const text = `${"a".repeat(50)}${" ".repeat(150)}${"b".repeat(50)}`;
    const chunks = chunkContent(text, { maxLen: 100, overlap: 50 });

    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("a"))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("b"))).toBe(true);
  });

  it("clamps overlap up to MIN_OVERLAP", () => {
    const text = "x".repeat(2000);
    expect(chunkContent(text, { maxLen: 500, overlap: 10 })).toEqual([
      text.slice(0, 500),
      text.slice(450, 950),
      text.slice(900, 1400),
      text.slice(1350, 1850),
      text.slice(1500, 2000),
    ]);
  });

  it("clamps overlap below the window so it always terminates", () => {
    const text = "x".repeat(300);
    const chunks = chunkContent(text, { maxLen: 100, overlap: 10_000 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(300);
    expect(chunks.every((chunk) => chunk.length === 100)).toBe(true);
  });

  it("defaults to a 1024-character window and MIN_OVERLAP", () => {
    expect(DEFAULT_CHUNK_OPTIONS.maxLen).toBe(1024);
    expect(DEFAULT_CHUNK_OPTIONS.overlap).toBe(50);
    expect(MODEL_TOKEN_WINDOW).toBe(512);

    const fits = "a".repeat(1024);
    expect(chunkContent(fits)).toEqual([fits]);

    const over = "a".repeat(1025);
    const chunks = chunkContent(over);
    expect(chunks).toEqual([over.slice(0, 1024), over.slice(1)]);
  });
});
