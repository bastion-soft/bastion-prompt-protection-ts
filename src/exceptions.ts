import type { GuardResult } from "./guard.js";

/**
 * Raised by callers that choose to fail closed on a detection.
 *
 * The core `Guard.protect()` never throws this — it returns a result. This
 * exists so integrations and application code have one shared error type.
 */
export class PromptInjectionError extends Error {
  readonly result: GuardResult;

  constructor(result: GuardResult) {
    super(
      `Prompt injection detected (risk=${result.risk.toFixed(3)}, stage=${result.stageReached}).`,
    );
    this.name = "PromptInjectionError";
    this.result = result;
  }
}
