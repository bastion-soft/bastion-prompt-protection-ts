export {
  Guard,
  type GuardResult,
  type ProtectOptions,
  type WindowedGuardResult,
} from "./guard.js";
export type { Guardable } from "./guardable.js";

export {
  CONTENT_TOKEN_WINDOW,
  DEFAULT_MAX_INPUT,
  DEFAULT_THRESHOLDS,
  DEFAULT_TOKEN_OVERLAP,
  DEFAULT_SLAB_CHARS,
  LABEL_ATTACK,
  LABEL_SAFE,
  MODEL_REGISTRY,
  MODEL_TOKEN_WINDOW,
  NEUTRAL_RISK,
  Preset,
  STAGE_CLASSIFIER,
  STAGE_HEURISTICS,
  estimateWindowCount,
  modelId,
  resolveConfig,
  type GuardConfig,
  type GuardConfigInit,
  type Label,
  type Stage,
  type Thresholds,
  type WindowOptions,
} from "./config.js";

export { PromptInjectionError } from "./errors.js";
export { verifyLicense, type LicenseStatus } from "./license.js";

export {
  HeuristicsStage,
  RULES,
  type HeuristicRule,
} from "./stages/heuristics.js";
export { ClassifierStage, type ClassifierPrediction } from "./stages/classifier.js";

export { VERSION } from "./version.js";
