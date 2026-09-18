import { DEFAULT_MAX_INPUT_CHARS, DEFAULT_TOKEN_OVERLAP } from "./constants.js";
import type { ModelUnavailableMode, Thresholds } from "./types.js";

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
export const MODEL_REGISTRY: Record<Preset, string> = {
  [Preset.TINY]: "bastionsoft/binary-bastion-prompt-protection-deberta-v3-xsmall-v1",
  [Preset.MULTILINGUAL]: "bastionsoft/binary-bastion-prompt-protection-mdeberta-v3-base-v1",
};

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  attackAbove: 0.5,
  heuristicShortCircuit: 0.95,
});

/** User-supplied guard options. Every field is optional. */
export interface GuardConfigInit {
  preset?: Preset;
  thresholds?: Partial<Thresholds>;
  enableHeuristics?: boolean;
  enableClassifier?: boolean;
  /** Total input length bound before windowing (characters). Defaults to `DEFAULT_MAX_INPUT_CHARS`. */
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
  /**
   * Controls behaviour when the ONNX classifier model cannot be loaded.
   *
   * - `"try-download-then-throw"` (default): on a failed download, `protect()`
   *   throws `ModelUnavailableError`. The loader retries the download on each
   *   subsequent call after a 5-second cooldown; once a download succeeds the
   *   guard self-heals and normal operation resumes.
   *
   * - `"throw"`: the first failed download is cached permanently. Every
   *   subsequent `protect()` call throws `ModelUnavailableError` immediately
   *   with no retry attempt.
   *
   * In both modes heuristic short-circuit (score ≥ 0.95) still fires before
   * the model is consulted, so obvious structural injections are caught even
   * while the model is unavailable. Heuristics-only fallback is never used.
   */
  onModelUnavailable?: ModelUnavailableMode;
}

/** Fully-resolved configuration, with every default applied. Includes secrets. */
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
  onModelUnavailable: ModelUnavailableMode;
}

/** Public snapshot exposed on `Guard.config` — no secrets. */
export type PublicGuardConfig = Omit<GuardConfig, "hfToken">;

export function resolveConfig(init: GuardConfigInit = {}): GuardConfig {
  return {
    preset: init.preset ?? Preset.TINY,
    thresholds: Object.freeze({ ...DEFAULT_THRESHOLDS, ...init.thresholds }),
    enableHeuristics: init.enableHeuristics ?? true,
    enableClassifier: init.enableClassifier ?? true,
    maxInputChars: init.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
    overlapTokens: init.overlapTokens ?? DEFAULT_TOKEN_OVERLAP,
    cacheDir: init.cacheDir,
    // Unlike Python's huggingface_hub, @huggingface/hub does not read these
    // itself, so resolve them here to keep the two behaving the same.
    hfToken: init.hfToken ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN,
    model: init.model,
    licensePath: init.licensePath,
    requireLicense: init.requireLicense ?? false,
    normalizeWhitespace: init.normalizeWhitespace ?? true,
    onModelUnavailable: init.onModelUnavailable ?? "try-download-then-throw",
  };
}

export function toPublicConfig(config: GuardConfig): PublicGuardConfig {
  const { hfToken: _omit, ...publicConfig } = config;
  return Object.freeze(publicConfig);
}

/** Resolve the HuggingFace repo id for the classifier. An explicit `model` overrides the preset. */
export function resolveClassifierRepo(config: Pick<GuardConfig, "preset" | "model">): string {
  if (config.model) return config.model;
  const repo = MODEL_REGISTRY[config.preset];
  if (!repo) throw new Error(`Unknown preset: ${config.preset}`);
  return repo;
}
