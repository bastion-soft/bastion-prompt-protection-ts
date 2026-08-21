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
export const MODEL_REGISTRY: Record<Preset, { binary: string }> = {
  [Preset.TINY]: {
    binary: "bastionsoft/binary-bastion-prompt-protection-deberta-v3-xsmall-v1",
  },
  [Preset.MULTILINGUAL]: {
    binary: "bastionsoft/binary-bastion-prompt-protection-mdeberta-v3-base-v1",
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
export const DEFAULT_MAX_INPUT = 65_536;

// ── Token window defaults ───────────────────────────────────────────────────────

/** The classifier reads at most this many tokens including special tokens. */
export const MODEL_TOKEN_WINDOW = 512;

/** `[CLS]` and `[SEP]` reserved by the post-processor. */
export const SPECIAL_TOKEN_BUDGET = 2;

/** Content tokens per window after special tokens are attached. */
export const CONTENT_TOKEN_WINDOW = MODEL_TOKEN_WINDOW - SPECIAL_TOKEN_BUDGET;

/** Default overlap between consecutive windows, in content tokens. */
export const DEFAULT_TOKEN_OVERLAP = 64;

/**
 * Maximum characters per tokenization slab. Keeps `@huggingface/tokenizers`
 * linear on multi-kilobyte input; whitespace-aligned cuts preserve the same
 * token stream as a single `encode()` call.
 */
export const DEFAULT_SLAB_CHARS = 512;

export type WindowOptions = {
  /** Model window including special tokens. Defaults to `MODEL_TOKEN_WINDOW`. */
  windowTokens?: number;
  /** Content tokens repeated from the previous window. Defaults to `DEFAULT_TOKEN_OVERLAP`. */
  overlapTokens?: number;
  /** Characters per tokenization slab. Defaults to `DEFAULT_SLAB_CHARS`. */
  slabChars?: number;
};

/** Estimate how many windows cover a token stream of the given length. */
export function estimateWindowCount(
  tokenCount: number,
  contentWindow = CONTENT_TOKEN_WINDOW,
  overlapTokens = DEFAULT_TOKEN_OVERLAP,
): number {
  if (tokenCount <= 0) return 0;
  if (tokenCount <= contentWindow) return 1;
  const step = Math.max(1, contentWindow - overlapTokens);
  return Math.ceil((tokenCount - contentWindow) / step) + 1;
}

// ── Output vocabulary ─────────────────────────────────────────────────────────

export const LABEL_SAFE = "safe";
export const LABEL_ATTACK = "attack";

export const STAGE_HEURISTICS = "heuristics";
export const STAGE_BINARY = "binary";

export type Label = typeof LABEL_SAFE | typeof LABEL_ATTACK;
export type Stage = typeof STAGE_HEURISTICS | typeof STAGE_BINARY;

// ── Stage sentinels ───────────────────────────────────────────────────────────

/**
 * Returned when model weights are not yet available. Sits exactly between
 * safe_below and attack_above so it routes to whichever next stage is enabled
 * without falsely classifying anything.
 */
export const NEUTRAL_RISK = 0.5;

/** User-supplied guard options. Every field is optional. */
export interface GuardConfigInit {
  preset?: Preset;
  thresholds?: Partial<Thresholds>;
  enableHeuristics?: boolean;
  enableBinary?: boolean;
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
   * ~/.bastion/license.json. `requireLicense: true` makes `Guard.create()`
   * refuse to start without a valid one. Default is non-blocking — status is
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
  thresholds: Thresholds;
  enableHeuristics: boolean;
  enableBinary: boolean;
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
    thresholds: { ...DEFAULT_THRESHOLDS, ...init.thresholds },
    enableHeuristics: init.enableHeuristics ?? true,
    enableBinary: init.enableBinary ?? true,
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
export function modelId(config: GuardConfig, stage: "binary"): string {
  if (stage === "binary" && config.model) return config.model;
  const entry = MODEL_REGISTRY[config.preset];
  if (!entry) throw new Error(`Unknown preset: ${config.preset}`);
  return entry[stage];
}
