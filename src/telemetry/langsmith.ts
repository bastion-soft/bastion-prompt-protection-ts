/**
 * LangSmith channel. The `langsmith` package is an optional peer dependency,
 * imported lazily (mirroring Python's `[langsmith]` extra).
 */
import type { Sink, TelemetryRecord } from "./reporter.js";

/** Pure record → `createRun` payload mapper. Exported so it can be unit-tested. */
export function langsmithRunPayload(
  record: TelemetryRecord,
  project?: string,
): Record<string, unknown> {
  const { prompt, ...outputs } = record;
  return {
    name: "bastion.guardrail",
    run_type: "tool",
    inputs: prompt === undefined ? {} : { prompt },
    outputs,
    ...(project ? { project_name: project } : {}),
  };
}

/** The single method this channel needs, so a fake client can be injected in tests. */
export interface LangsmithClientLike {
  createRun(payload: Record<string, unknown>): Promise<unknown>;
}

export async function makeLangsmithSink(options: {
  client?: LangsmithClientLike;
  apiKey?: string;
  project?: string;
}): Promise<Sink> {
  let client: LangsmithClientLike;
  if (options.client) {
    client = options.client;
  } else {
    try {
      const { Client } = await import("langsmith");
      client = new Client(
        options.apiKey ? { apiKey: options.apiKey } : {},
      ) as unknown as LangsmithClientLike;
    } catch (err) {
      throw new Error(
        "LangSmith telemetry needs the optional peer dependency: npm i langsmith " +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return async (batch: TelemetryRecord[]): Promise<void> => {
    for (const record of batch) {
      await client.createRun(langsmithRunPayload(record, options.project));
    }
  };
}
