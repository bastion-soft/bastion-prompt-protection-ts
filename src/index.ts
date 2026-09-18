export { Guard, type GuardResult, type ProtectOptions, type WindowedGuardResult } from "./guard.js";

export {
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_SLAB_CHARS,
  DEFAULT_TOKEN_OVERLAP,
  CONTENT_TOKEN_WINDOW,
  MODEL_TOKEN_WINDOW,
} from "./constants.js";

export {
  DEFAULT_THRESHOLDS,
  Preset,
  type GuardConfigInit,
  type PublicGuardConfig as GuardConfig,
} from "./config.js";

export {
  LABEL_ATTACK,
  LABEL_SAFE,
  STAGE_CLASSIFIER,
  STAGE_HEURISTICS,
  type Label,
  type Stage,
  type Thresholds,
  type WindowOptions,
} from "./types.js";

export { PromptInjectionError, ModelUnavailableError } from "./errors.js";
export { verifyLicense, type LicenseStatus } from "./license.js";

export { VERSION } from "./version.js";
