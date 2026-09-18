export const LABEL_SAFE = "safe";
export const LABEL_ATTACK = "attack";

export const STAGE_HEURISTICS = "heuristics";
export const STAGE_CLASSIFIER = "classifier";

export type Label = typeof LABEL_SAFE | typeof LABEL_ATTACK;
export type Stage = typeof STAGE_HEURISTICS | typeof STAGE_CLASSIFIER;

export type ModelUnavailableMode = "throw" | "try-download-then-throw";

export interface Thresholds {
  attackAbove: number;
  heuristicShortCircuit: number;
}

export type WindowOptions = {
  /** Model window including special tokens. Defaults to `MODEL_TOKEN_WINDOW`. */
  windowTokens?: number;
  /** Content tokens repeated from the previous window. Defaults to `DEFAULT_TOKEN_OVERLAP`. */
  overlapTokens?: number;
  /** Characters per tokenization slab. Defaults to `DEFAULT_SLAB_CHARS`. */
  slabChars?: number;
};

export interface GuardResult {
  risk: number;
  label: Label;
  stageReached: Stage;
  latencyMs: number;
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
