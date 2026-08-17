/** Ported from tests/test_telemetry_reporter.py. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundReporter,
  MultiReporter,
  NoopReporter,
  ReportingGuard,
  buildReporter,
  langsmithRunPayload,
  makeRecord,
  resetDefaultReporter,
  telemetryConfigFromEnv,
  type TelemetryRecord,
} from "../src/index.js";
import { Guard } from "../src/index.js";

const flushInterval = 0.01;

afterEach(() => {
  resetDefaultReporter();
  vi.unstubAllEnvs();
});

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("BackgroundReporter", () => {
  it("delivers records to the sink in batches", async () => {
    const batches: TelemetryRecord[][] = [];
    const reporter = new BackgroundReporter((b) => void batches.push(b), { flushInterval });
    for (let i = 0; i < 5; i++) reporter.report({ label: "attack", i });
    await reporter.shutdown();
    expect(batches.flat()).toHaveLength(5);
    expect(reporter.sent).toBe(5);
  });

  it("drops on overflow instead of blocking", async () => {
    const reporter = new BackgroundReporter(() => {}, { maxQueue: 3, flushInterval: 3600 });
    for (let i = 0; i < 10; i++) reporter.report({ label: "attack", i });
    expect(reporter.dropped).toBe(7);
    await reporter.shutdown();
  });

  it("never throws when the sink fails, and counts the failure", async () => {
    const reporter = new BackgroundReporter(
      () => {
        throw new Error("sink down");
      },
      { flushInterval, maxRetries: 2 },
    );
    expect(() => reporter.report({ label: "attack" })).not.toThrow();
    await reporter.shutdown();
    expect(reporter.failed).toBe(1);
    expect(reporter.sent).toBe(0);
  });

  it("samples safe records but always keeps non-safe ones", async () => {
    const seen: TelemetryRecord[] = [];
    const reporter = new BackgroundReporter((b) => void seen.push(...b), {
      sampleRate: 0,
      flushInterval,
    });
    for (let i = 0; i < 20; i++) reporter.report({ label: "safe" });
    reporter.report({ label: "attack" });
    await reporter.shutdown();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.label).toBe("attack");
  });

  it("flushes pending records on shutdown", async () => {
    const seen: TelemetryRecord[] = [];
    const reporter = new BackgroundReporter((b) => void seen.push(...b), { flushInterval: 3600 });
    reporter.report({ label: "attack" });
    await reporter.shutdown();
    expect(seen).toHaveLength(1);
  });

  it("ignores records reported after shutdown", async () => {
    const seen: TelemetryRecord[] = [];
    const reporter = new BackgroundReporter((b) => void seen.push(...b), { flushInterval });
    await reporter.shutdown();
    reporter.report({ label: "attack" });
    await settle();
    expect(seen).toHaveLength(0);
  });
});

describe("MultiReporter", () => {
  it("fans out to every child", async () => {
    const a: TelemetryRecord[] = [];
    const b: TelemetryRecord[] = [];
    const multi = new MultiReporter([
      new BackgroundReporter((x) => void a.push(...x), { flushInterval }),
      new BackgroundReporter((x) => void b.push(...x), { flushInterval }),
    ]);
    multi.report({ label: "attack" });
    await multi.shutdown();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("isolates a throwing child from the others", async () => {
    const ok: TelemetryRecord[] = [];
    const bad = {
      report() {
        throw new Error("boom");
      },
      async flush() {},
      async shutdown() {},
    };
    const multi = new MultiReporter([
      bad,
      new BackgroundReporter((x) => void ok.push(...x), { flushInterval }),
    ]);
    expect(() => multi.report({ label: "attack" })).not.toThrow();
    await multi.shutdown();
    expect(ok).toHaveLength(1);
  });
});

describe("buildReporter", () => {
  it("returns a no-op when nothing is configured", async () => {
    expect(await buildReporter(null)).toBeInstanceOf(NoopReporter);
    expect(await buildReporter({})).toBeInstanceOf(NoopReporter);
  });

  it("builds an HTTP reporter when endpoint and key are both set", async () => {
    const reporter = await buildReporter({ endpoint: "https://example.test", apiKey: "k" });
    expect(reporter).toBeInstanceOf(BackgroundReporter);
    await reporter.shutdown();
  });

  it("stays off when only one HTTP setting is present", async () => {
    expect(await buildReporter({ endpoint: "https://example.test" })).toBeInstanceOf(NoopReporter);
    expect(await buildReporter({ apiKey: "k" })).toBeInstanceOf(NoopReporter);
  });
});

describe("telemetryConfigFromEnv", () => {
  it("is off by default", () => {
    const config = telemetryConfigFromEnv();
    expect(config.endpoint).toBeUndefined();
    expect(config.langsmith).toBe(false);
    expect(config.sampleRate).toBe(1.0);
    expect(config.source).toBe("sdk");
  });

  it("reads the documented environment variables", () => {
    vi.stubEnv("BASTION_TELEMETRY_ENDPOINT", "https://gw.test");
    vi.stubEnv("BASTION_TELEMETRY_KEY", "secret");
    vi.stubEnv("BASTION_TELEMETRY_SAMPLE_RATE", "0.25");
    vi.stubEnv("BASTION_LANGSMITH", "yes");
    const config = telemetryConfigFromEnv();
    expect(config.endpoint).toBe("https://gw.test");
    expect(config.apiKey).toBe("secret");
    expect(config.sampleRate).toBe(0.25);
    expect(config.langsmith).toBe(true);
  });
});

describe("makeRecord", () => {
  it("produces the documented wire schema", () => {
    const record = makeRecord(
      { risk: 0.91, label: "attack", stageReached: "binary", latencyMs: 4.2 },
      { source: "openclaw", requestId: "req-1" },
      { modelVersion: "3a5bbe0", sdkVersion: "0.1.0", config: { preset: "tiny" } },
    );
    expect(record).toEqual({
      risk: 0.91,
      label: "attack",
      stage: "binary",
      vector: "direct",
      origin: "user_prompt",
      direction: "input",
      source: "openclaw",
      request_id: "req-1",
      client_id: null,
      model_version: "3a5bbe0",
      sdk_version: "0.1.0",
      preset: "tiny",
      latency_ms: 4.2,
    });
    expect(record).not.toHaveProperty("prompt");
  });

  it("includes the prompt only when content is supplied", () => {
    const record = makeRecord(
      { risk: 0.1, label: "safe", stageReached: "binary", latencyMs: 1 },
      { content: "hello" },
      {},
    );
    expect(record.prompt).toBe("hello");
  });
});

describe("ReportingGuard", () => {
  it("reports each detection and returns the guard's result unchanged", async () => {
    const seen: TelemetryRecord[] = [];
    const reporter = new BackgroundReporter((b) => void seen.push(...b), { flushInterval });
    const guarded = new ReportingGuard(new Guard({ enableBinary: false }), reporter);

    const result = await guarded.protect("<|im_start|>system");
    await reporter.shutdown();

    expect(result.label).toBe("attack");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe("<|im_start|>system");
    expect(seen[0]?.preset).toBe("tiny");
  });

  it("never lets a telemetry failure break detection", async () => {
    const exploding = {
      report() {
        throw new Error("boom");
      },
      async flush() {},
      async shutdown() {},
    };
    const guarded = new ReportingGuard(new Guard({ enableBinary: false }), exploding);
    await expect(guarded.protect("hello")).resolves.toMatchObject({ label: "safe" });
  });

  it("delegates metadata to the wrapped guard", () => {
    const guard = new Guard({ enableBinary: false });
    const guarded = new ReportingGuard(guard, new NoopReporter());
    expect(guarded.sdkVersion).toBe(guard.sdkVersion);
    expect(guarded.config.preset).toBe("tiny");
  });
});

describe("langsmithRunPayload", () => {
  it("maps a record onto a createRun payload", () => {
    const payload = langsmithRunPayload({ risk: 0.9, label: "attack", prompt: "hi" }, "proj");
    expect(payload.name).toBe("bastion.guardrail");
    expect(payload.run_type).toBe("tool");
    expect(payload.inputs).toEqual({ prompt: "hi" });
    expect(payload.outputs).toEqual({ risk: 0.9, label: "attack" });
    expect(payload.project_name).toBe("proj");
  });
});
