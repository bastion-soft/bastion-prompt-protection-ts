/**
 * Composition helpers — wiring a reporter to detection *without* coupling it
 * into `Guard`.
 *
 * `Guard` stays a pure detector. Reporting is layered on by composition: hold a
 * reporter and call `reporter.report(makeRecord(...))`, or wrap a guard in
 * `ReportingGuard`.
 */
import type { Guard, GuardResult } from "../guard.js";
import { type ReportContext, type Reporter, makeRecord } from "./reporter.js";

/**
 * Wrap a `Guard` so each `protect` also reports — by composition.
 *
 * ```ts
 * const guard = new Guard();
 * const reporter = buildReporter(telemetryConfigFromEnv());
 * const safe = new ReportingGuard(guard, reporter);
 * await safe.protect("…"); // detects, then fire-and-forget reports
 * ```
 */
export class ReportingGuard {
  constructor(
    private readonly guard: Guard,
    private readonly reporter: Reporter,
    private readonly context: ReportContext = {},
  ) {}

  async protect(prompt: string): Promise<GuardResult> {
    const result = await this.guard.protect(prompt);
    const context =
      this.context.content === undefined || this.context.content === null
        ? { ...this.context, content: prompt }
        : this.context;
    try {
      this.reporter.report(makeRecord(result, context, this.guard));
    } catch {
      // Telemetry must never break detection.
    }
    return result;
  }

  get sdkVersion(): string {
    return this.guard.sdkVersion;
  }

  get modelVersion(): string | null {
    return this.guard.modelVersion;
  }

  get config(): Guard["config"] {
    return this.guard.config;
  }

  licenseStatus(): ReturnType<Guard["licenseStatus"]> {
    return this.guard.licenseStatus();
  }
}
