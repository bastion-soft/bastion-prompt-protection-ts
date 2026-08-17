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

/** User-supplied guard options. Every field is optional. */
export interface GuardConfigInit {
  preset?: Preset;
  thresholds?: Partial<Thresholds>;
  enableHeuristics?: boolean;
  enableBinary?: boolean;
  maxInputChars?: number;
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
}

/** Fully-resolved configuration, with every default applied. */
export interface GuardConfig {
  preset: Preset;
  thresholds: Thresholds;
  enableHeuristics: boolean;
  enableBinary: boolean;
  maxInputChars: number;
  cacheDir?: string;
  hfToken?: string;
  model?: string;
  licensePath?: string;
  requireLicense: boolean;
}

export function resolveConfig(init: GuardConfigInit = {}): GuardConfig {
  return {
    preset: init.preset ?? Preset.TINY,
    thresholds: { ...DEFAULT_THRESHOLDS, ...init.thresholds },
    enableHeuristics: init.enableHeuristics ?? true,
    enableBinary: init.enableBinary ?? true,
    maxInputChars: init.maxInputChars ?? 8000,
    cacheDir: init.cacheDir,
    // Unlike Python's huggingface_hub, @huggingface/hub does not read these
    // itself, so resolve them here to keep the two behaving the same.
    hfToken: init.hfToken ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN,
    model: init.model,
    licensePath: init.licensePath,
    requireLicense: init.requireLicense ?? false,
  };
}

/** Resolve the HF repo id for a stage. An explicit `model` overrides the preset. */
export function modelId(config: GuardConfig, stage: "binary"): string {
  if (stage === "binary" && config.model) return config.model;
  const entry = MODEL_REGISTRY[config.preset];
  if (!entry) throw new Error(`Unknown preset: ${config.preset}`);
  return entry[stage];
}
