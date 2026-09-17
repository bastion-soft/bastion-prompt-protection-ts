import {
  type GuardConfig,
  type GuardConfigInit,
  type Label,
  type Preset,
  type Stage,
  type WindowOptions,
  LABEL_ATTACK,
  LABEL_SAFE,
  STAGE_CLASSIFIER,
  STAGE_HEURISTICS,
  modelId,
  resolveConfig,
} from "./config.js";
import type { Guardable } from "./guardable.js";
import { LicenseVerifier } from "./license.js";
import { ClassifierStage } from "./stages/classifier.js";
import { HeuristicsStage } from "./stages/heuristics.js";
import { collapseWhitespace, roundTo } from "./utils.js";
import { VERSION } from "./version.js";

export interface GuardResult {
  risk: number;
  label: Label;
  stageReached: Stage;
  latencyMs: number;
  /** True when `label === "attack"`. */
  readonly isAttack: boolean;
}

export interface WindowedGuardResult extends GuardResult {
  /**
   * Windows actually scanned. Fewer than `windowsTotal` when an early hit ended
   * the scan, or when `maxWindows` capped it — compare the two to tell whether
   * the whole input was covered.
   */
  windowsScanned: number;
  /**
   * Estimated windows covering the whole input. Exact once `windowsTotalExact`
   * is true; otherwise extrapolated from observed token density.
   */
  windowsTotal: number;
  /** True when `windowsTotal` is exact rather than a density projection. */
  windowsTotalExact: boolean;
}

export interface ProtectOptions extends Partial<WindowOptions> {
  /**
   * Stop after this many windows. Unlimited by default: the whole input is
   * scanned, since a cap silently reintroduces unexamined content. Set it to
   * bound worst-case work on untrusted input, and check
   * `windowsScanned < windowsTotal` to detect partial coverage.
   *
   * `maxWindows: 1` scans only the first model window — the same single-window
   * behaviour as the Python package's `protect()`.
   */
  maxWindows?: number;
  /**
   * Collapse runs of whitespace to a single ASCII space and trim before
   * scanning. Overrides the `normalizeWhitespace` setting on the `Guard`
   * constructor for this call only. Inherits the constructor value when
   * omitted (default constructor value: `true`).
   */
  normalizeWhitespace?: boolean;
}

/**
 * Two-stage prompt-injection detector.
 *
 * Note on async: Python's `Guard.protect()` is synchronous. In Node the model
 * download and ONNX session creation are unavoidably async, so `protect()`
 * returns a Promise. Everything else — thresholds, ordering, rounding — matches
 * the Python pipeline exactly.
 */
export class Guard implements Guardable {
  readonly config: GuardConfig;
  private readonly heuristics: HeuristicsStage | null;
  private readonly classifier: ClassifierStage | null;

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
    this.classifier = this.config.enableClassifier
      ? new ClassifierStage(
          modelId(this.config, "classifier"),
          this.config.cacheDir,
          this.config.hfToken,
        )
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
  licenseStatus() {
    return new LicenseVerifier(this.config.licensePath).verify();
  }

  /**
   * Scan one window of text through the classifier stage.
   *
   * Heuristics run once on the full input in `protect()` before windowing.
   * Deliberately isolated from windowing so scores stay bit-identical to the
   * Python package's `protect()` when `maxWindows: 1`.
   */
  private async scanWindow(prompt: string): Promise<GuardResult> {
    const start = performance.now();
    const text = prompt.slice(0, this.config.maxInputChars);

    let classifierRisk = 0.0;
    let classifierAvailable = false;
    if (this.classifier !== null) {
      const pred = await this.classifier.predict(text);
      if (pred.available) {
        classifierRisk = pred.risk;
        classifierAvailable = true;
      }
    }

    const stage = classifierAvailable ? STAGE_CLASSIFIER : STAGE_HEURISTICS;

    return this.finalize(classifierRisk, stage, start);
  }

  /**
   * Scan prompt content for injection.
   *
   * By default the input is split into overlapping token windows and every
   * window is scanned, stopping early once a window reaches
   * `thresholds.attackAbove`. Pass `{ maxWindows: 1 }` to scan only the first
   * model window — the Python-parity single-window mode.
   */
  async protect(prompt: string, options: ProtectOptions = {}): Promise<WindowedGuardResult> {
    const start = performance.now();

    const shouldNormalize = options.normalizeWhitespace ?? this.config.normalizeWhitespace;
    const input = shouldNormalize ? collapseWhitespace(prompt) : prompt;
    const bounded = input.slice(0, this.config.maxInputChars);

    if (this.heuristics !== null) {
      const heuristicScore = this.heuristics.run(input);
      if (heuristicScore >= this.config.thresholds.heuristicShortCircuit) {
        const base = this.finalize(heuristicScore, STAGE_HEURISTICS, start);
        return {
          ...base,
          windowsScanned: 0,
          windowsTotal: 0,
          windowsTotalExact: true,
        };
      }
    }

    if (options.maxWindows === 1) {
      const base = await this.scanWindow(bounded);
      return {
        ...base,
        windowsScanned: 1,
        windowsTotal: 1,
        windowsTotalExact: true,
      };
    }

    if (this.classifier === null || bounded.length === 0) {
      const base = await this.scanWindow(bounded);
      return {
        ...base,
        windowsScanned: 0,
        windowsTotal: 0,
        windowsTotalExact: true,
      };
    }

    if (!(await this.classifier.isAvailable())) {
      const base = await this.scanWindow(bounded);
      return {
        ...base,
        windowsScanned: 0,
        windowsTotal: 0,
        windowsTotalExact: true,
      };
    }

    const windowOpts: WindowOptions = {
      overlapTokens: options.overlapTokens ?? this.config.overlapTokens,
      windowTokens: options.windowTokens,
      slabChars: options.slabChars,
    };
    const limit = options.maxWindows ?? Number.POSITIVE_INFINITY;

    let worst: GuardResult | null = null;
    let scanned = 0;
    let windowsTotal = 1;
    let windowsTotalExact = false;

    for await (const window of this.classifier.encodeWindows(bounded, windowOpts)) {
      if (scanned >= limit) break;
      scanned += 1;
      windowsTotal = window.estimatedTotal;
      windowsTotalExact = window.exact;

      const pred = await this.classifier.predictEncoded(window.encoding);
      if (!pred.available) {
        const base = await this.scanWindow(bounded);
        return {
          ...base,
          windowsScanned: 0,
          windowsTotal: 0,
          windowsTotalExact: true,
        };
      }

      const result = this.finalize(pred.risk, STAGE_CLASSIFIER, start);
      if (worst === null || result.risk > worst.risk) worst = result;
      if (worst.risk >= this.config.thresholds.attackAbove) break;
    }

    if (scanned === 0) {
      const base = await this.scanWindow(bounded);
      return {
        ...base,
        windowsScanned: 0,
        windowsTotal: 0,
        windowsTotalExact: true,
      };
    }

    const base = worst ?? (await this.scanWindow(bounded));
    return {
      ...base,
      latencyMs: roundTo(performance.now() - start, 3),
      windowsScanned: scanned,
      windowsTotal,
      windowsTotalExact,
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
