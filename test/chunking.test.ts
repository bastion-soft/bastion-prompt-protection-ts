import { describe, expect, it } from "vitest";
import { DEFAULT_SLAB_CHARS } from "../src/config.js";
import { slabify } from "../src/chunking.js";

function collect(text: string, slabChars?: number): string[] {
  return [...slabify(text, slabChars)];
}

describe("slabify", () => {
  it("returns no slabs for empty input", () => {
    expect(collect("")).toEqual([]);
  });

  it("tiles the input losslessly", () => {
    const text = "hello world ".repeat(100);
    expect(collect(text).join("")).toBe(text);
  });

  it("never exceeds the slab limit", () => {
    const text = "a".repeat(5000);
    for (const slab of collect(text, 512)) {
      expect(slab.length).toBeLessThanOrEqual(512);
    }
  });

  it("prefers breaking on whitespace when possible", () => {
    const text = `${"word ".repeat(120)}tail`;
    const slabs = collect(text, 256);
    expect(slabs.join("")).toBe(text);
    for (const slab of slabs.slice(0, -1)) {
      expect(/\s/u.test(slab.at(-1) ?? "")).toBe(true);
    }
  });

  it("hard-cuts whitespace-free runs", () => {
    const text = "A".repeat(1000);
    const slabs = collect(text, 512);
    expect(slabs).toEqual(["A".repeat(512), "A".repeat(488)]);
    expect(slabs.join("")).toBe(text);
  });

  it("defaults to DEFAULT_SLAB_CHARS", () => {
    const text = "x".repeat(DEFAULT_SLAB_CHARS + 10);
    const slabs = collect(text);
    expect(slabs[0]?.length).toBe(DEFAULT_SLAB_CHARS);
  });
});
