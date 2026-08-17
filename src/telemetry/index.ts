/**
 * Telemetry — the composable reporter pipeline that fans in-process detections
 * to a Bastion console / the customer's observability.
 *
 * Decoupled from `Guard` by design: build a reporter, hand it to an integration
 * (or wrap a guard in `ReportingGuard`). All off by default.
 */
import {
  type TelemetryConfig,
  httpEnabled,
  langsmithEnabled,
  otelEnabled,
  telemetryConfigFromEnv,
  telemetryEnabled,
} from "./config.js";
import { BackgroundReporter, MultiReporter, NoopReporter, type Reporter } from "./reporter.js";

export * from "./config.js";
export * from "./reporter.js";
export { ReportingGuard } from "./reporting.js";
export { langsmithRunPayload } from "./langsmith.js";

/**
 * Compose the reporter pipeline from config. Each configured channel becomes its
 * own independent (queued, retrying, isolated) reporter; returns a no-op when
 * nothing is configured (default ⇒ zero egress, no background timer).
 *
 * Async because the OTel and LangSmith channels import their optional peer
 * dependencies lazily.
 */
export async function buildReporter(config: TelemetryConfig | null): Promise<Reporter> {
  if (config === null || !telemetryEnabled(config)) return new NoopReporter();

  const sampleRate = config.sampleRate ?? 1.0;
  const reporters: Reporter[] = [];

  if (httpEnabled(config)) {
    const { makeHttpSink } = await import("./http.js");
    reporters.push(
      new BackgroundReporter(makeHttpSink(config.endpoint as string, config.apiKey as string), {
        sampleRate,
      }),
    );
  }
  if (otelEnabled(config)) {
    const { makeOtelSink } = await import("./otel.js");
    reporters.push(
      new BackgroundReporter(await makeOtelSink(config.otelEndpoint as string), { sampleRate }),
    );
  }
  if (langsmithEnabled(config)) {
    const { makeLangsmithSink } = await import("./langsmith.js");
    reporters.push(
      new BackgroundReporter(
        await makeLangsmithSink({
          apiKey: config.langsmithApiKey,
          project: config.langsmithProject,
        }),
        { sampleRate },
      ),
    );
  }

  if (reporters.length === 0) return new NoopReporter();
  return reporters.length === 1 ? (reporters[0] as Reporter) : new MultiReporter(reporters);
}

let cachedDefault: Promise<Reporter> | null = null;

/**
 * Cached reporter built from the environment — the fallback an integration uses
 * when no reporter is injected. No-op unless `BASTION_TELEMETRY_*` etc. are set,
 * so it preserves the zero-config-but-env-activatable UX.
 */
export function defaultReporter(): Promise<Reporter> {
  cachedDefault ??= buildReporter(telemetryConfigFromEnv());
  return cachedDefault;
}

/** Test-only: clear the `defaultReporter()` memo (Python uses `lru_cache.clear`). */
export function resetDefaultReporter(): void {
  cachedDefault = null;
}
