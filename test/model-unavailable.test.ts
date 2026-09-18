/**
 * Unit tests for the two `onModelUnavailable` modes:
 *
 * - `"throw"`: first download failure is permanent; every subsequent call
 *   throws immediately without retrying.
 * - `"try-download-then-throw"` (default): throws on failure but retries the
 *   download after a 5-second cooldown; self-heals once a download succeeds.
 *
 * These tests mock `OnnxModelLoader#loadFromCacheOrHub` so no network or HF cache is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelUnavailableError } from "../src/errors.js";
import { OnnxModelLoader } from "../src/models/loader.js";
import type { ModelArtifact } from "../src/models/loader.js";

const FAKE_ARTIFACT: ModelArtifact = {
  session: {} as any,
  tokenizer: {} as any,
  labels: [],
  modelDir: "/cache/test-model/snapshots/abc1234def5678",
  inputNames: [],
  TensorClass: class {} as any,
};

function loader(onModelUnavailable: "throw" | "try-download-then-throw") {
  return new OnnxModelLoader({ modelId: "owner/model", onModelUnavailable });
}

describe("OnnxModelLoader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('onModelUnavailable: "throw"', () => {
    it("throws ModelUnavailableError when download fails", async () => {
      const instance = loader("throw");
      vi.spyOn(instance as any, "loadFromCacheOrHub").mockRejectedValue(
        new Error("connection refused"),
      );

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    it("carries the original error as cause", async () => {
      const instance = loader("throw");
      const cause = new Error("connection refused");
      vi.spyOn(instance as any, "loadFromCacheOrHub").mockRejectedValue(cause);

      await expect(instance.load()).rejects.toMatchObject({ cause });
    });

    it("caches the failure permanently — subsequent calls throw without retrying", async () => {
      const instance = loader("throw");
      const spy = vi
        .spyOn(instance as any, "loadFromCacheOrHub")
        .mockRejectedValue(new Error("network error"));

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(60_000);

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);
      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("resolves normally when download succeeds", async () => {
      const instance = loader("throw");
      vi.spyOn(instance as any, "loadFromCacheOrHub").mockResolvedValue(FAKE_ARTIFACT);

      await expect(instance.load()).resolves.toEqual(FAKE_ARTIFACT);
    });
  });

  describe('onModelUnavailable: "try-download-then-throw" (default)', () => {
    it("throws ModelUnavailableError when download fails", async () => {
      const instance = loader("try-download-then-throw");
      vi.spyOn(instance as any, "loadFromCacheOrHub").mockRejectedValue(
        new Error("connection refused"),
      );

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    it("throws without retrying during the 5-second cooldown", async () => {
      const instance = loader("try-download-then-throw");
      const spy = vi
        .spyOn(instance as any, "loadFromCacheOrHub")
        .mockRejectedValue(new Error("network error"));

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(4_999);

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("includes a countdown hint in the error message during cooldown", async () => {
      const instance = loader("try-download-then-throw");
      vi.spyOn(instance as any, "loadFromCacheOrHub").mockRejectedValue(new Error("network error"));

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(2_000);

      await expect(instance.load()).rejects.toMatchObject({
        message: expect.stringMatching(/retry in \d+s/),
      });
    });

    it("retries after the cooldown elapses and succeeds", async () => {
      const instance = loader("try-download-then-throw");
      const spy = vi
        .spyOn(instance as any, "loadFromCacheOrHub")
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(FAKE_ARTIFACT);

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(5_001);

      await expect(instance.load()).resolves.toEqual(FAKE_ARTIFACT);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("operates normally after self-healing — no further retries", async () => {
      const instance = loader("try-download-then-throw");
      const spy = vi
        .spyOn(instance as any, "loadFromCacheOrHub")
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(FAKE_ARTIFACT);

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(5_001);
      await instance.load();

      await instance.load();
      await instance.load();
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("collapses concurrent post-cooldown retry attempts onto one download", async () => {
      const instance = loader("try-download-then-throw");
      const spy = vi
        .spyOn(instance as any, "loadFromCacheOrHub")
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(FAKE_ARTIFACT);

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(5_001);

      await Promise.all([instance.load(), instance.load(), instance.load()]);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("throws on consecutive failures across multiple cooldown cycles", async () => {
      const instance = loader("try-download-then-throw");
      const spy = vi
        .spyOn(instance as any, "loadFromCacheOrHub")
        .mockRejectedValue(new Error("persistent network error"));

      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(5_001);
      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      vi.advanceTimersByTime(5_001);
      await expect(instance.load()).rejects.toBeInstanceOf(ModelUnavailableError);

      expect(spy).toHaveBeenCalledTimes(3);
    });
  });
});
