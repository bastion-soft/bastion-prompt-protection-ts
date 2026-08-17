/**
 * OTLP channel → the customer's own collector.
 *
 * The OpenTelemetry packages are optional peer dependencies, imported lazily so
 * the core install stays lean (mirroring Python's `[otel]` extra).
 */
import type { Sink, TelemetryRecord } from "./reporter.js";

export async function makeOtelSink(endpoint: string, serviceName = "bastion-sdk"): Promise<Sink> {
  let mods;
  try {
    mods = {
      sdk: await import("@opentelemetry/sdk-trace-node"),
      exporterMod: await import("@opentelemetry/exporter-trace-otlp-http"),
      resources: await import("@opentelemetry/resources"),
    };
  } catch (err) {
    throw new Error(
      "OTel telemetry needs the optional peer dependencies: " +
        "npm i @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const { sdk, exporterMod, resources } = mods;

  const provider = new sdk.NodeTracerProvider({
    resource: resources.resourceFromAttributes({ "service.name": serviceName }),
    spanProcessors: [
      new sdk.BatchSpanProcessor(
        new exporterMod.OTLPTraceExporter({
          url: `${endpoint.replace(/\/+$/, "")}/v1/traces`,
        }),
      ),
    ],
  });
  const tracer = provider.getTracer("bastion-prompt-protection");

  return (batch: TelemetryRecord[]): void => {
    for (const record of batch) {
      const span = tracer.startSpan("bastion.guardrail");
      span.setAttribute("gen_ai.operation.name", "guardrail");
      span.setAttribute("gen_ai.provider.name", "bastion");
      if (record.model_version != null) {
        span.setAttribute("gen_ai.request.model", String(record.model_version));
      }
      for (const key of ["risk", "label", "stage", "vector", "origin", "source", "preset"]) {
        const value = record[key];
        if (value != null) span.setAttribute(`bastion.${key}`, value as string | number);
      }
      span.end();
    }
  };
}
