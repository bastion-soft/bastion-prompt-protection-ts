/**
 * Native batched HTTP ingest channel.
 *
 * Posts the rich audit record to the gateway's `POST /v1/events:batch`
 * (ingest-scoped key). Uses global `fetch` — no dependency. The sink rejects on
 * failure so `BackgroundReporter` retries with backoff.
 */
import type { Sink, TelemetryRecord } from "./reporter.js";

export function makeHttpSink(endpoint: string, apiKey: string, timeoutMs = 5000): Sink {
  const url = `${endpoint.replace(/\/+$/, "")}/v1/events:batch`;

  return async (batch: TelemetryRecord[]): Promise<void> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300) {
      throw new Error(`ingest failed: HTTP ${response.status}`);
    }
  };
}
