import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches package.json", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;
    expect(VERSION).toBe(packageVersion);
  });
});
