import {
  type GuardConfig,
  type GuardOptions,
  type Preset,
  type PublicGuardConfig,
  resolveClassifierRepo,
  resolveConfig,
  toPublicConfig,
} from "./config.js";
import { LicenseVerifier, type LicenseStatus } from "./license.js";
import { ClassifierStage } from "./stages/classifier.js";
import { HeuristicsStage } from "./stages/heuristics.js";
import {
  LABEL_ATTACK,
  LABEL_SAFE,
  STAGE_CLASSIFIER,
  STAGE_HEURISTICS,
  type GuardResult,
  type Label,
  type ProtectOptions,
  type Stage,
  type WindowOptions,
} from "./types.js";
import { collapseWhitespace, roundTo } from "./utils.js";
import { VERSION } from "./version.js";

type StageResult = Pick<
  GuardResult,
  "risk" | "label" | "stageReached" | "latencyMs" | "isAttack"
>;

function withWindowCoverage(
  base: StageResult,
  scanned: number,
  total: number,
  exact: boolean,
): GuardResult {
  return {
    ...base,
    windowsScanned: scanned,
    windowsTotal: total,
    windowsTotalExact: exact,
  };
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
  readonly config: PublicGuardConfig;
  private readonly resolvedConfig: GuardConfig;
  private readonly license: LicenseVerifier;
  private readonly heuristics: HeuristicsStage | null;
  private readonly classifier: ClassifierStage | null;

  constructor(init: GuardOptions | Preset = {}) {
    this.resolvedConfig = resolveConfig(typeof init === "string" ? { preset: init } : init);
    this.config = toPublicConfig(this.resolvedConfig);
    this.license = new LicenseVerifier(this.resolvedConfig.licensePath);

    if (this.resolvedConfig.requireLicense) {
      const status = this.license.verify();
      if (!status.valid) {
        // TODO(X4): throw typed LicenseError, not generic Error
        throw new Error(
          `Bastion: requireLicense is set but no valid commercial license was found ` +
            `(${status.reason}). Obtain one at https://bastionsoft.com, or unset requireLicense.`,
        );
      }
    }

    this.heuristics = this.resolvedConfig.enableHeuristics ? new HeuristicsStage() : null;
    this.classifier = this.resolvedConfig.enableClassifier
      ? new ClassifierStage({
          modelId: resolveClassifierRepo(this.resolvedConfig),
          onModelUnavailable: this.resolvedConfig.onModelUnavailable,
          cacheDir: this.resolvedConfig.cacheDir,
          hfToken: this.resolvedConfig.hfToken,
        })
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
   * classifier stage is disabled. Useful for audit logs and bug reports.
   */
  get modelVersion(): string | null {
    return this.classifier === null ? null : this.classifier.modelVersion;
  }

  /**
   * Offline status of the commercial license (Ed25519 signature + expiry), from
   * `config.licensePath` or the default locations. Non-blocking — read it for
   * audit/logging. The free TINY model needs no license.
   */
  get licenseStatus(): LicenseStatus {
    return this.license.verify();
  }

  /**
   * Scan prompt content for injection.
   *
   * By default the input is split into overlapping token windows and every
   * window is scanned, stopping early once a window reaches
   * `thresholds.attackAbove`. Pass `{ maxWindows: 1 }` to scan only the first
   * sliding window.
   *
   * Throws `ModelUnavailableError` when the classifier model cannot be loaded
   * (see `onModelUnavailable` for retry vs. permanent-throw behaviour).
   * The heuristic short-circuit (`score >= thresholds.heuristicShortCircuit`)
   * runs before the model is consulted and returns an attack result without
   * needing the model.
   */
  async protect(prompt: string, options: ProtectOptions = {}): Promise<GuardResult> {
    // TODO(X9): validate ProtectOptions values at the entry point
    const start = performance.now();

    const shouldNormalize = options.normalizeWhitespace ?? this.config.normalizeWhitespace;
    const fullText = shouldNormalize ? collapseWhitespace(prompt) : prompt;
    const textForModel = fullText.slice(0, this.config.maxInputChars);

    if (this.heuristics !== null) {
      const heuristicScore = this.heuristics.score(fullText);
      if (heuristicScore >= this.config.thresholds.heuristicShortCircuit) {
        return withWindowCoverage(
          this.finalize(heuristicScore, STAGE_HEURISTICS, start),
          0,
          0,
          true,
        );
      }
    }

    if (this.classifier === null || textForModel.length === 0) {
      return withWindowCoverage(this.finalize(0, STAGE_HEURISTICS, start), 0, 0, true);
    }

    const windowOpts: WindowOptions = {
      overlapTokens: options.overlapTokens ?? this.config.overlapTokens,
      windowTokens: options.windowTokens,
      slabChars: options.slabChars,
    };
    const limit = options.maxWindows ?? Number.POSITIVE_INFINITY;

    let highestRiskResult: StageResult | null = null;
    let scanned = 0;
    let windowsTotal = 1;
    let windowsTotalExact = false;

    for await (const window of this.classifier.windows(textForModel, windowOpts)) {
      if (scanned >= limit) break;
      scanned += 1;
      windowsTotal = window.windowsTotal;
      windowsTotalExact = window.windowsTotalExact;

      const risk = await this.classifier.scoreEncoded(window.encoding);
      const result = this.finalize(risk, STAGE_CLASSIFIER, start);
      if (highestRiskResult === null || result.risk > highestRiskResult.risk) highestRiskResult = result;
      if (highestRiskResult.risk >= this.config.thresholds.attackAbove) break;
    }

    if (highestRiskResult === null) {
      const risk = await this.classifier.score(textForModel);
      return withWindowCoverage(this.finalize(risk, STAGE_CLASSIFIER, start), 0, 0, true);
    }

    return withWindowCoverage(
      {
        ...highestRiskResult,
        latencyMs: roundTo(performance.now() - start, 3),
      },
      scanned,
      windowsTotal,
      windowsTotalExact,
    );
  }

  private finalize(risk: number, stageReached: Stage, start: number): StageResult {
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
