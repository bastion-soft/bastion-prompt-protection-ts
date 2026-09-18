import type { GuardResult } from "./types.js";

/**
 * Raised by callers that choose to fail closed on a detection.
 *
 * The core `Guard.protect()` never throws this — it returns a result. This
 * exists so integrations and application code have one shared error type.
 *
 * TODO(X6): document that Guard never throws this; result includes window fields.
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

/**
 * Thrown by `Guard.protect()` when the ONNX classifier model is not available.
 *
 * When `onModelUnavailable` is `"throw"`, this is thrown permanently after the
 * first failed download. When set to `"try-download-then-throw"` (the default),
 * each `protect()` call re-attempts the download after a 5-second cooldown; this
 * error is thrown while the model is unavailable and the cooldown has not elapsed.
 *
 * `cause` carries the original download or parse error.
 */
export class ModelUnavailableError extends Error {
  override readonly cause: Error;

  constructor(modelId: string, cause: Error, hint?: string) {
    super(
      `bastion-prompt-protection: model ${modelId} is unavailable` +
        (hint ? ` — ${hint}` : "") +
        `. Underlying cause: ${cause.message}`,
    );
    this.name = "ModelUnavailableError";
    this.cause = cause;
  }
}
