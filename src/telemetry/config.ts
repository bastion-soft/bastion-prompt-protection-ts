/**
 * Telemetry config surface — ALL DEFAULT OFF.
 *
 * With no configuration nothing is emitted: pure in-process detection, zero
 * egress. Each channel (native HTTP → gateway, OTLP → collector, LangSmith) is
 * enabled independently; the reporter pipeline fans to whichever are configured.
 */

export interface TelemetryConfig {
  // Native HTTP channel → Bastion gateway console
  endpoint?: string;
  apiKey?: string;
  // OTLP channel → customer's own collector
  otelEndpoint?: string;
  // LangSmith channel
  langsmith?: boolean;
  langsmithApiKey?: string;
  langsmithProject?: string;
  // shared
  sampleRate?: number;
  clientId?: string;
  source?: string;
  environment?: string;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function telemetryConfigFromEnv(): TelemetryConfig {
  return {
    endpoint: process.env.BASTION_TELEMETRY_ENDPOINT,
    apiKey: process.env.BASTION_TELEMETRY_KEY,
    otelEndpoint: process.env.BASTION_OTEL_ENDPOINT,
    langsmith: envBool("BASTION_LANGSMITH"),
    langsmithApiKey: process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY,
    langsmithProject: process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT,
    sampleRate: envFloat("BASTION_TELEMETRY_SAMPLE_RATE", 1.0),
    clientId: process.env.BASTION_CLIENT_ID,
    source: process.env.BASTION_SOURCE ?? "sdk",
    environment: process.env.BASTION_ENVIRONMENT,
  };
}

export const httpEnabled = (c: TelemetryConfig): boolean => Boolean(c.endpoint && c.apiKey);
export const otelEnabled = (c: TelemetryConfig): boolean => Boolean(c.otelEndpoint);
export const langsmithEnabled = (c: TelemetryConfig): boolean => Boolean(c.langsmith);
export const telemetryEnabled = (c: TelemetryConfig): boolean =>
  httpEnabled(c) || otelEnabled(c) || langsmithEnabled(c);
