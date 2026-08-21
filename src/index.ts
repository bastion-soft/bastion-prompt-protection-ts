export { Guard, type ChunkedGuardResult, type GuardResult, type ProtectOptions } from "./guard.js";

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
  SPECIAL_TOKEN_BUDGET,
  STAGE_BINARY,
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

export { PromptInjectionError } from "./exceptions.js";
export { TemperatureScaler } from "./calibration.js";
export { canonicalJson, verifyLicense, type LicenseStatus } from "./license.js";

export {
  HeuristicsStage,
  RULES,
  structuralScore,
  type HeuristicRule,
} from "./stages/heuristics.js";
export { BinaryStage, softmax, type BinaryPrediction } from "./stages/binary.js";
export { OnnxModelLoader, type ModelArtifact } from "./models/loader.js";
export {
  BastionTokenizer,
  resolveContentWindow,
  type Encoding,
  type TokenWindow,
} from "./models/tokenizer.js";

export {
  BackgroundReporter,
  MultiReporter,
  NoopReporter,
  ReportingGuard,
  buildReporter,
  defaultReporter,
  langsmithRunPayload,
  makeRecord,
  resetDefaultReporter,
  telemetryConfigFromEnv,
  type Reporter,
  type ReportContext,
  type TelemetryConfig,
  type TelemetryRecord,
} from "./telemetry/index.js";

export { VERSION } from "./version.js";
