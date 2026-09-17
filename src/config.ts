import { DEFAULT_TOKEN_OVERLAP } from "./constants.js";

export {
  CONTENT_TOKEN_WINDOW,
  DEFAULT_SLAB_CHARS,
  DEFAULT_TOKEN_OVERLAP,
  estimateWindowCount,
  LABEL_ATTACK,
  LABEL_SAFE,
  MODEL_TOKEN_WINDOW,
  NEUTRAL_RISK,
  STAGE_CLASSIFIER,
  STAGE_HEURISTICS,
  type Label,
  type Stage,
  type WindowOptions,
} from "./constants.js";

export const Preset = {
  /** Free, AGPL. DeBERTa-v3-xsmall fine-tune, 70M params, ONNX-INT8 quantized. */
  TINY: "tiny",
  /**
   * Commercial, gated on the HF Hub. mdeberta-v3-base, 280M, multilingual.
   * Requires a license + granted HF access (https://bastionsoft.com) — the
   * weights simply won't download without it. See `verifyLicense`.
   */
  MULTILINGUAL: "multilingual",
} as const;

export type Preset = (typeof Preset)[keyof typeof Preset];

/**
 * Model registry. Keys map to HuggingFace repos; the SDK downloads weights on
 * first use and caches them. Presets are just named shortcuts — you don't have
 * to use one: pass any repo id via `{ model: ... }` to point the detector at
 * your own (or a self-hosted) model.
 */
export const MODEL_REGISTRY: Record<Preset, { classifier: string }> = {
  [Preset.TINY]: {
    classifier: "bastionsoft/binary-bastion-prompt-protection-deberta-v3-xsmall-v1",
  },
  [Preset.MULTILINGUAL]: {
    classifier: "bastionsoft/binary-bastion-prompt-protection-mdeberta-v3-base-v1",
  },
};

export interface Thresholds {
  attackAbove: number;
  heuristicShortCircuit: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  attackAbove: 0.5,
  heuristicShortCircuit: 0.95,
});

/** Total input length bound before token windowing (characters, not tokens). */
export const DEFAULT_MAX_INPUT = 262_144;

/** User-supplied guard options. Every field is optional. */
export interface GuardConfigInit {
  preset?: Preset;
  thresholds?: Partial<Thresholds>;
  enableHeuristics?: boolean;
  enableClassifier?: boolean;
  /** Total input length bound before windowing (characters). Defaults to `DEFAULT_MAX_INPUT`. */
  maxInputChars?: number;
  /** Content-token overlap between consecutive windows. Defaults to `DEFAULT_TOKEN_OVERLAP`. */
  overlapTokens?: number;
  cacheDir?: string;
  /**
   * HuggingFace access token. Required only for gated repos — the
   * `multilingual` preset; the default `tiny` model is public. Also lifts the
   * tighter rate limits applied to unauthenticated requests.
   *
   * Defaults to `$HF_TOKEN`, then `$HUGGING_FACE_HUB_TOKEN` — the variables
   * Python's `huggingface_hub` reads, which `@huggingface/hub` does not.
   */
  hfToken?: string;
  /**
   * Point the detector at any HF repo id, bypassing the preset registry.
   * When set, this wins over `preset` — lets you run your own (or a
   * self-hosted) model without registering a preset.
   */
  model?: string;
  /**
   * Commercial license (optional, verified offline). Path to the signed
   * license JSON emailed on purchase; defaults to $BASTION_LICENSE or
   * ~/.bastion/license.json. `requireLicense: true` makes the `Guard`
   * constructor refuse to start without a valid one. Default is non-blocking — status is
   * exposed via `Guard.licenseStatus()` for audit/logging.
   */
  licensePath?: string;
  requireLicense?: boolean;
  /**
   * Collapse runs of whitespace to a single ASCII space and trim before
   * scanning. Reduces the effective input size when the source text contains
   * redundant whitespace (copy-paste artifacts, OCR output, web-scrape noise).
   * Defaults to `true`. Disable with `false` when exact character-level
   * fidelity matters, e.g. when reproducing Python-package scores exactly.
   */
  normalizeWhitespace?: boolean;
}

/** Fully-resolved configuration, with every default applied. */
export interface GuardConfig {
  preset: Preset;
  thresholds: Readonly<Thresholds>;
  enableHeuristics: boolean;
  enableClassifier: boolean;
  maxInputChars: number;
  overlapTokens: number;
  cacheDir?: string;
  hfToken?: string;
  model?: string;
  licensePath?: string;
  requireLicense: boolean;
  normalizeWhitespace: boolean;
}

export function resolveConfig(init: GuardConfigInit = {}): GuardConfig {
  return {
    preset: init.preset ?? Preset.TINY,
    thresholds: Object.freeze({ ...DEFAULT_THRESHOLDS, ...init.thresholds }),
    enableHeuristics: init.enableHeuristics ?? true,
    enableClassifier: init.enableClassifier ?? true,
    maxInputChars: init.maxInputChars ?? DEFAULT_MAX_INPUT,
    overlapTokens: init.overlapTokens ?? DEFAULT_TOKEN_OVERLAP,
    cacheDir: init.cacheDir,
    // Unlike Python's huggingface_hub, @huggingface/hub does not read these
    // itself, so resolve them here to keep the two behaving the same.
    hfToken: init.hfToken ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN,
    model: init.model,
    licensePath: init.licensePath,
    requireLicense: init.requireLicense ?? false,
    normalizeWhitespace: init.normalizeWhitespace ?? true,
  };
}

/** Resolve the HF repo id for a stage. An explicit `model` overrides the preset. */
export function modelId(config: GuardConfig, stage: "classifier"): string {
  if (stage === "classifier" && config.model) return config.model;
  const entry = MODEL_REGISTRY[config.preset];
  if (!entry) throw new Error(`Unknown preset: ${config.preset}`);
  return entry[stage];
}
