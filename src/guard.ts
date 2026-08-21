import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions, chunkContent } from "./chunking.js";
import {
  type GuardConfig,
  type GuardConfigInit,
  type Preset,
  modelId,
  resolveConfig,
} from "./config.js";
import { type LicenseStatus, verifyLicense } from "./license.js";
import { BinaryStage } from "./stages/binary.js";
import { HeuristicsStage } from "./stages/heuristics.js";
import { VERSION } from "./version.js";

export const LABEL_SAFE = "safe";
export const LABEL_ATTACK = "attack";

export const STAGE_HEURISTICS = "heuristics";
export const STAGE_BINARY = "binary";

export type Label = typeof LABEL_SAFE | typeof LABEL_ATTACK;
export type Stage = typeof STAGE_HEURISTICS | typeof STAGE_BINARY;

export interface GuardResult {
  risk: number;
  label: Label;
  stageReached: Stage;
  latencyMs: number;
  /** True when `label === "attack"`. */
  readonly isAttack: boolean;
}

export interface ChunkedGuardResult extends GuardResult {
  /**
   * Chunks actually scanned. Fewer than `chunksTotal` when an early hit ended
   * the scan, or when `maxChunks` capped it — compare the two to tell whether
   * the whole input was covered.
   */
  chunksScanned: number;
  chunksTotal: number;
}

export interface ProtectOptions extends Partial<ChunkOptions> {
  /**
   * Stop after this many chunks. Unlimited by default: the whole input is
   * scanned, since a cap silently reintroduces unexamined content. Set it to
   * bound worst-case work on untrusted input, and check
   * `chunksScanned < chunksTotal` to detect partial coverage.
   *
   * `maxChunks: 1` scans only the first `maxInputChars` window — the same
   * single-window behaviour as the Python package's `protect()`.
   */
  maxChunks?: number;
  /**
   * Collapse runs of whitespace to a single ASCII space and trim before
   * scanning. Overrides the `normalizeWhitespace` setting on the `Guard`
   * constructor for this call only. Inherits the constructor value when
   * omitted (default constructor value: `true`).
   */
  normalizeWhitespace?: boolean;
}

/**
 * Collapse runs of whitespace to a single ASCII space and trim.
 * Does not touch zero-width characters (U+200B, U+200C, etc.) — those are
 * not matched by \s and are caught by the heuristics stage as adversarial.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Round half-away-from-zero to `digits` places, matching Python's `round()` on positives. */
function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Two-stage prompt-injection detector.
 *
 * Note on async: Python's `Guard.protect()` is synchronous. In Node the model
 * download and ONNX session creation are unavoidably async, so `protect()`
 * returns a Promise. Everything else — thresholds, ordering, rounding — matches
 * the Python pipeline exactly.
 */
export class Guard {
  readonly config: GuardConfig;
  private readonly heuristics: HeuristicsStage | null;
  private readonly binary: BinaryStage | null;

  constructor(init: GuardConfigInit | Preset = {}) {
    this.config = resolveConfig(typeof init === "string" ? { preset: init } : init);

    if (this.config.requireLicense) {
      const status = this.licenseStatus();
      if (!status.valid) {
        throw new Error(
          `Bastion: requireLicense is set but no valid commercial license was found ` +
            `(${status.reason}). Obtain one at https://bastionsoft.com, or unset requireLicense.`,
        );
      }
    }

    this.heuristics = this.config.enableHeuristics ? new HeuristicsStage() : null;
    this.binary = this.config.enableBinary
      ? new BinaryStage(modelId(this.config, "binary"), this.config.cacheDir, this.config.hfToken)
      : null;
  }

  /** The @bastionsoft/prompt-protection package version. */
  get sdkVersion(): string {
    return VERSION;
  }

  /**
   * Identifier for the currently loaded model build (7-char commit SHA of the
   * HuggingFace snapshot under the hood). Returns null if the model hasn't been
   * loaded yet — lazy load triggers on the first `protect()` call — or if the
   * binary stage is disabled. Useful for audit logs and bug reports.
   */
  get modelVersion(): string | null {
    return this.binary === null ? null : this.binary.modelVersion;
  }

  /**
   * Offline status of the commercial license (Ed25519 signature + expiry), from
   * `config.licensePath` or the default locations. Non-blocking — read it for
   * audit/logging. The free TINY model needs no license.
   */
  licenseStatus(): LicenseStatus {
    return verifyLicense(this.config.licensePath);
  }

  /**
   * Scan one window of text through the two-stage pipeline.
   *
   * Deliberately isolated from chunking so scores stay bit-identical to the
   * Python package's `protect()` when `maxChunks: 1`.
   */
  private async _scan(prompt: string): Promise<GuardResult> {
    const start = performance.now();
    const text = (prompt ?? "").slice(0, this.config.maxInputChars);

    const heuristicScore = this.heuristics !== null ? this.heuristics.run(text) : 0.0;

    if (heuristicScore >= this.config.thresholds.heuristicShortCircuit) {
      return this.finalize(heuristicScore, STAGE_HEURISTICS, start);
    }

    let binaryRisk = 0.0;
    let binaryAvailable = false;
    if (this.binary !== null) {
      const pred = await this.binary.predict(text);
      if (pred.available) {
        binaryRisk = pred.risk;
        binaryAvailable = true;
      }
    }

    const risk = Math.max(heuristicScore, binaryRisk);
    const stage = binaryAvailable ? STAGE_BINARY : STAGE_HEURISTICS;

    return this.finalize(risk, stage, start);
  }

  /**
   * Scan prompt content for injection.
   *
   * By default the input is split into overlapping windows and every chunk is
   * scanned, stopping early once a chunk reaches `thresholds.attackAbove`.
   * Pass `{ maxChunks: 1 }` to scan only the first `maxInputChars` window —
   * the Python-parity single-window mode.
   */
  async protect(prompt: string, options: ProtectOptions = {}): Promise<ChunkedGuardResult> {
    const start = performance.now();

    const shouldNormalize = options.normalizeWhitespace ?? this.config.normalizeWhitespace;
    const input = shouldNormalize ? collapseWhitespace(prompt ?? "") : (prompt ?? "");

    if (options.maxChunks === 1) {
      const base = await this._scan(input);
      return {
        ...base,
        chunksScanned: 1,
        chunksTotal: 1,
      };
    }

    const chunks = chunkContent(input, { ...DEFAULT_CHUNK_OPTIONS, ...options });
    const limit = options.maxChunks ?? chunks.length;

    let worst: GuardResult | null = null;
    let scanned = 0;

    for (const chunk of chunks) {
      if (scanned >= limit) break;
      scanned += 1;
      const result = await this._scan(chunk);
      if (worst === null || result.risk > worst.risk) worst = result;
      if (worst.risk >= this.config.thresholds.attackAbove) break;
    }

    // `chunkContent` always yields at least one chunk, but an empty prompt
    // still has to produce a result.
    const base = worst ?? (await this._scan(input));
    return {
      ...base,
      latencyMs: roundTo(performance.now() - start, 3),
      chunksScanned: scanned,
      chunksTotal: chunks.length,
    };
  }

  private finalize(risk: number, stageReached: Stage, start: number): GuardResult {
    const label: Label = risk >= this.config.thresholds.attackAbove ? LABEL_ATTACK : LABEL_SAFE;
    const latencyMs = performance.now() - start;
    return {
      risk: roundTo(risk, 4),
      label,
      stageReached,
      latencyMs: roundTo(latencyMs, 3),
      isAttack: label === LABEL_ATTACK,
    };
  }
}
