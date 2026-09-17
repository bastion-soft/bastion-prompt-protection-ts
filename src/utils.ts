/**
 * Collapse runs of whitespace to a single ASCII space and trim.
 * Does not touch zero-width characters (U+200B, U+200C, etc.) — those are
 * not matched by \s and are caught by the heuristics stage as adversarial.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Round half-away-from-zero to `digits` places, matching Python's `round()` on positives. */
export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Python's `datetime.fromisoformat` treats a timestamp with no offset as naive
 * and the caller then pins it to UTC. JavaScript's `Date` parses a bare
 * date-time as *local* time, so pin it explicitly to keep the two in agreement.
 */
export function parseIsoUtc(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasZone ? value : `${value}Z`;
  return Date.parse(normalized);
}

/**
 * Canonical JSON, byte-identical to Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 *
 * MUST match the licensing minter byte-for-byte or signatures won't verify.
 * `JSON.stringify` does not sort object keys, so this is hand-rolled.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
