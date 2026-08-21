import {
  type GuardConfig,
  type GuardConfigInit,
  type Label,
  type Preset,
  type Stage,
  type WindowOptions,
  LABEL_ATTACK,
  LABEL_SAFE,
  STAGE_BINARY,
  STAGE_HEURISTICS,
  modelId,
  resolveConfig,
} from "./config.js";
import { type LicenseStatus, verifyLicense } from "./license.js";
import { BinaryStage } from "./stages/binary.js";
import { HeuristicsStage } from "./stages/heuristics.js";
import { VERSION } from "./version.js";

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
   * Windows actually scanned. Fewer than `chunksTotal` when an early hit ended
   * the scan, or when `maxChunks` capped it — compare the two to tell whether
   * the whole input was covered.
   */
  chunksScanned: number;
  /**
   * Estimated windows covering the whole input. Exact once `chunksTotalExact`
   * is true; otherwise extrapolated from observed token density.
   */
  chunksTotal: number;
  /** True when `chunksTotal` is exact rather than a density projection. */
  chunksTotalExact: boolean;
}

export interface ProtectOptions extends Partial<WindowOptions> {
  /**
   * Stop after this many windows. Unlimited by default: the whole input is
   * scanned, since a cap silently reintroduces unexamined content. Set it to
   * bound worst-case work on untrusted input, and check
   * `chunksScanned < chunksTotal` to detect partial coverage.
   *
   * `maxChunks: 1` scans only the first model window — the same single-window
   * behaviour as the Python package's `protect()`.
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
   * Scan one window of text through the binary stage.
   *
   * Heuristics run once on the full input in `protect()` before windowing.
   * Deliberately isolated from windowing so scores stay bit-identical to the
   * Python package's `protect()` when `maxChunks: 1`.
   */
  private async _scan(prompt: string): Promise<GuardResult> {
    const start = performance.now();
    const text = (prompt ?? "").slice(0, this.config.maxInputChars);

    let binaryRisk = 0.0;
    let binaryAvailable = false;
    if (this.binary !== null) {
      const pred = await this.binary.predict(text);
      if (pred.available) {
        binaryRisk = pred.risk;
        binaryAvailable = true;
      }
    }

    const stage = binaryAvailable ? STAGE_BINARY : STAGE_HEURISTICS;

    return this.finalize(binaryRisk, stage, start);
  }

  /**
   * Scan prompt content for injection.
   *
   * By default the input is split into overlapping token windows and every
   * window is scanned, stopping early once a window reaches
   * `thresholds.attackAbove`. Pass `{ maxChunks: 1 }` to scan only the first
   * model window — the Python-parity single-window mode.
   */
  async protect(prompt: string, options: ProtectOptions = {}): Promise<ChunkedGuardResult> {
    const start = performance.now();

    const shouldNormalize = options.normalizeWhitespace ?? this.config.normalizeWhitespace;
    const input = shouldNormalize ? collapseWhitespace(prompt ?? "") : (prompt ?? "");
    const bounded = input.slice(0, this.config.maxInputChars);

    if (this.heuristics !== null) {
      const heuristicScore = this.heuristics.run(input);
      if (heuristicScore >= this.config.thresholds.heuristicShortCircuit) {
        const base = this.finalize(heuristicScore, STAGE_HEURISTICS, start);
        return {
          ...base,
          chunksScanned: 0,
          chunksTotal: 0,
          chunksTotalExact: true,
        };
      }
    }

    if (options.maxChunks === 1) {
      const base = await this._scan(bounded);
      return {
        ...base,
        chunksScanned: 1,
        chunksTotal: 1,
        chunksTotalExact: true,
      };
    }

    if (this.binary === null || bounded.length === 0) {
      const base = await this._scan(bounded);
      return {
        ...base,
        chunksScanned: 0,
        chunksTotal: 0,
        chunksTotalExact: true,
      };
    }

    if (!(await this.binary.isAvailable())) {
      const base = await this._scan(bounded);
      return {
        ...base,
        chunksScanned: 0,
        chunksTotal: 0,
        chunksTotalExact: true,
      };
    }

    const windowOpts: WindowOptions = {
      overlapTokens: options.overlapTokens ?? this.config.overlapTokens,
      windowTokens: options.windowTokens,
      slabChars: options.slabChars,
    };
    const limit = options.maxChunks ?? Number.POSITIVE_INFINITY;

    let worst: GuardResult | null = null;
    let scanned = 0;
    let chunksTotal = 1;
    let chunksTotalExact = false;

    for await (const window of this.binary.encodeWindows(bounded, windowOpts)) {
      if (scanned >= limit) break;
      scanned += 1;
      chunksTotal = window.estimatedTotal;
      chunksTotalExact = window.exact;

      const pred = await this.binary.predictEncoded(window.encoding);
      if (!pred.available) {
        const base = await this._scan(bounded);
        return {
          ...base,
          chunksScanned: 0,
          chunksTotal: 0,
          chunksTotalExact: true,
        };
      }

      const result = this.finalize(pred.risk, STAGE_BINARY, performance.now());
      if (worst === null || result.risk > worst.risk) worst = result;
      if (worst.risk >= this.config.thresholds.attackAbove) break;
    }

    if (scanned === 0) {
      const base = await this._scan(bounded);
      return {
        ...base,
        chunksScanned: 0,
        chunksTotal: 0,
        chunksTotalExact: true,
      };
    }

    const base = worst ?? (await this._scan(bounded));
    return {
      ...base,
      latencyMs: roundTo(performance.now() - start, 3),
      chunksScanned: scanned,
      chunksTotal,
      chunksTotalExact,
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
