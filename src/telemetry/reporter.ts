/**
 * Telemetry reporter.
 *
 * One pluggable reporter that every integration feeds — not N "X→console"
 * integrations. The reliability rules are non-negotiable: async/background,
 * batched, fire-and-forget, bounded queue with drop-on-overflow, retry+backoff,
 * flush on shutdown, optional sampling that always keeps flagged/blocked.
 * **It never adds latency to, or raises into, the request path.**
 *
 * Python backs this with a daemon thread and a blocking `queue.Queue`. Node has
 * no threads here, so the same contract is met with an array-backed bounded
 * queue and an `unref()`'d interval timer — unref'd so a configured reporter
 * never keeps a short-lived process alive.
 */

// Where a detection was caught — mirrors the gateway ScanContext.
export const VECTOR_DIRECT = "direct";
export const VECTOR_INDIRECT = "indirect";
export const ORIGIN_USER_PROMPT = "user_prompt";
export const ORIGIN_RAG_DOCUMENT = "rag_document";
export const ORIGIN_TOOL_RESULT = "tool_result";
export const ORIGIN_AGENT_STEP = "agent_step";

/** Provenance for one detection, supplied by the integration that caught it. */
export interface ReportContext {
  vector?: string;
  origin?: string;
  /** input | output (output-side screening) */
  direction?: string;
  /** integration tag: litellm/langchain/llamaindex/… */
  source?: string | null;
  requestId?: string | null;
  clientId?: string | null;
  /** screened text; the gateway applies its snippet policy */
  content?: string | null;
}

export type TelemetryRecord = Record<string, unknown>;

/** Delivers a batch; rejects on failure. */
export type Sink = (batch: TelemetryRecord[]) => Promise<void> | void;

export interface Reporter {
  report(record: TelemetryRecord): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Default — telemetry off. Zero work, zero egress. */
export class NoopReporter implements Reporter {
  report(): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export interface BackgroundReporterOptions {
  sampleRate?: number;
  maxQueue?: number;
  batchSize?: number;
  /** seconds, matching the Python default of 1.0 */
  flushInterval?: number;
  maxRetries?: number;
}

/**
 * Bounded queue + background timer. Drops on overflow, retries with backoff,
 * flushes on shutdown, swallows every error. `report` is non-blocking and never
 * throws.
 */
export class BackgroundReporter implements Reporter {
  private readonly queue: TelemetryRecord[] = [];
  private readonly sampleRate: number;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  private draining: Promise<void> = Promise.resolve();

  dropped = 0;
  sent = 0;
  failed = 0;

  constructor(
    private readonly sink: Sink,
    options: BackgroundReporterOptions = {},
  ) {
    this.sampleRate = Math.max(0, Math.min(1, options.sampleRate ?? 1.0));
    this.maxQueue = options.maxQueue ?? 10_000;
    this.batchSize = options.batchSize ?? 50;
    this.maxRetries = options.maxRetries ?? 3;

    const intervalMs = (options.flushInterval ?? 1.0) * 1000;
    this.timer = setInterval(() => void this.drain(), intervalMs);
    // Never hold the event loop open just because telemetry is configured.
    this.timer.unref?.();
  }

  report(record: TelemetryRecord): void {
    try {
      if (this.stopped) return;
      // Sampling: always keep non-safe (flagged/blocked); sample the rest.
      if (this.sampleRate < 1.0 && record.label === "safe" && Math.random() > this.sampleRate) {
        return;
      }
      if (this.queue.length >= this.maxQueue) {
        this.dropped += 1;
        return;
      }
      this.queue.push(record);
    } catch {
      // The request path must never see a telemetry error.
    }
  }

  private drain(): Promise<void> {
    // Serialise drains so batches can't interleave.
    this.draining = this.draining.then(async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        await this.flushBatch(batch);
      }
    });
    return this.draining;
  }

  private async flushBatch(batch: TelemetryRecord[]): Promise<void> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        await this.sink(batch);
        this.sent += batch.length;
        return;
      } catch {
        if (attempt === this.maxRetries - 1) break;
        const backoff = Math.min(0.5 * 2 ** attempt, 5.0) * (1 + Math.random() * 0.2);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, backoff * 1000);
          t.unref?.();
        });
      }
    }
    this.failed += batch.length;
    console.warn(
      `bastion-prompt-protection: reporter dropped ${batch.length} events after retries`,
    );
  }

  async flush(): Promise<void> {
    await this.drain();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.drain();
  }
}

/**
 * A pipeline of reporters — fans each record to every child (HTTP, OTel,
 * LangSmith, …). Children are independent: each has its own queue/retry/drop, so
 * one slow or failing channel can't affect the others. Never throws.
 */
export class MultiReporter implements Reporter {
  constructor(private readonly reporters: Reporter[]) {}

  report(record: TelemetryRecord): void {
    for (const r of this.reporters) {
      try {
        r.report(record);
      } catch {
        // A channel can never break the request path.
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.reporters.map((r) => r.flush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.reporters.map((r) => r.shutdown()));
  }
}

/**
 * Build the wire record from a detection + its provenance + the guard's
 * metadata. Pure helper — `guard` is only read for version/preset, so neither
 * Guard nor the integrations depend on the reporter to produce a record.
 */
export function makeRecord(
  result: {
    risk: number;
    label: string;
    stageReached: string;
    latencyMs: number;
  },
  context: ReportContext,
  guard: {
    modelVersion?: string | null;
    sdkVersion?: string;
    config?: { preset?: string };
  },
): TelemetryRecord {
  const record: TelemetryRecord = {
    risk: result.risk,
    label: result.label,
    stage: result.stageReached,
    vector: context.vector ?? VECTOR_DIRECT,
    origin: context.origin ?? ORIGIN_USER_PROMPT,
    direction: context.direction ?? "input",
    source: context.source ?? null,
    request_id: context.requestId ?? null,
    client_id: context.clientId ?? null,
    model_version: guard.modelVersion ?? null,
    sdk_version: guard.sdkVersion ?? null,
    preset: guard.config?.preset ?? null,
    latency_ms: result.latencyMs,
  };
  if (context.content !== undefined && context.content !== null) {
    record.prompt = context.content;
  }
  return record;
}
