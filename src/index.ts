export {
  Guard,
  LABEL_ATTACK,
  LABEL_SAFE,
  STAGE_BINARY,
  STAGE_HEURISTICS,
  type ChunkedGuardResult,
  type GuardResult,
  type Label,
  type ProtectOptions,
  type Stage,
} from "./guard.js";

export {
  DEFAULT_CHUNK_OPTIONS,
  MODEL_TOKEN_WINDOW,
  chunkContent,
  type ChunkOptions,
} from "./chunking.js";

export {
  DEFAULT_THRESHOLDS,
  MODEL_REGISTRY,
  Preset,
  modelId,
  resolveConfig,
  type GuardConfig,
  type GuardConfigInit,
  type Thresholds,
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
export { BinaryStage, NEUTRAL_RISK, softmax, type BinaryPrediction } from "./stages/binary.js";
export { OnnxModelLoader, type ModelArtifact } from "./models/loader.js";
export { BastionTokenizer, type Encoding } from "./models/tokenizer.js";

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
