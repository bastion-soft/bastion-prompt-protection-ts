/**
 * Offline commercial-license verification.
 *
 * A Bastion commercial license is an Ed25519-signed JSON document (emailed on
 * purchase, alongside a human-readable PDF). Verification is fully offline: the
 * public key ships in this module and the signature proves the license is
 * authentic and untampered — no network call, so it works in air-gapped and
 * container deployments.
 *
 * This is an *assurance / audit* layer, not DRM. Model access itself is gated at
 * download time (the commercial weights are gated on the HF Hub). Use this to
 * record and prove license validity in your own logs, or set
 * `requireLicense: true` if your compliance wants the process to refuse to start
 * without a valid license.
 *
 * Unlike the Python package this needs no optional dependency — Node's built-in
 * `node:crypto` provides Ed25519, so the `[license]` extra has no counterpart.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Bastion Soft Ed25519 public verification key — safe to publish; pairs with the
 * Secret-Manager-held signing key used by the licensing backend. Base64 of the
 * raw 32-byte key. If we ever rotate the signing key, this constant changes in a
 * new SDK release.
 */
const PUBLIC_KEY_B64 = "BSMpA1IBRWo671jTEp6ZZ96vrjRANPgvOM1g4PwAUkk=";

/** DER SPKI prefix for a raw Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface LicenseStatus {
  valid: boolean;
  reason: string;
  licenseId: string | null;
  tier: string | null;
  company: string | null;
  validUntil: string | null;
  expired: boolean;
}

function defaultPaths(): string[] {
  const paths: string[] = [];
  if (process.env.BASTION_LICENSE) paths.push(process.env.BASTION_LICENSE);
  paths.push(path.join(homedir(), ".bastion", "license.json"));
  return paths;
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

function loadSource(
  source: Record<string, unknown> | string | undefined,
): Record<string, unknown> | null {
  if (source !== undefined && typeof source === "object") return source;
  const candidates = source ? [source] : defaultPaths();
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    try {
      return JSON.parse(readFileSync(candidate, "utf-8"));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Python's `datetime.fromisoformat` treats a timestamp with no offset as naive
 * and the caller then pins it to UTC. JavaScript's `Date` parses a bare
 * date-time as *local* time, so pin it explicitly to keep the two in agreement.
 */
function parseIsoUtc(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasZone ? value : `${value}Z`;
  return Date.parse(normalized);
}

function status(
  valid: boolean,
  reason: string,
  data: Record<string, unknown> | null,
  expired = false,
): LicenseStatus {
  const customer = (data?.customer ?? null) as { company_name?: string } | null;
  return {
    valid,
    reason,
    licenseId: (data?.license_id as string) ?? null,
    tier: (data?.tier as string) ?? null,
    company: customer?.company_name ?? null,
    validUntil: (data?.valid_until as string) ?? null,
    expired,
  };
}

/**
 * Verify a signed license offline.
 *
 * `source` may be the license object, a path to the license JSON, or undefined
 * to auto-discover it ($BASTION_LICENSE, then ~/.bastion/license.json).
 * Checks the Ed25519 signature first, then the `valid_until` expiry.
 */
export function verifyLicense(
  source?: Record<string, unknown> | string,
  options: { publicKeyB64?: string } = {},
): LicenseStatus {
  const data = loadSource(source);
  if (data === null) return status(false, "no license file found", null);

  const signatureB64 = data.signature;
  if (typeof signatureB64 !== "string" || signatureB64.length === 0) {
    return status(false, "license has no signature", data);
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(options.publicKeyB64 ?? PUBLIC_KEY_B64, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    const { signature: _omit, ...body } = data;
    const message = Buffer.from(canonicalJson(body), "utf-8");
    const ok = cryptoVerify(null, message, publicKey, Buffer.from(signatureB64, "base64"));
    if (!ok) return status(false, "signature verification failed", data);
  } catch {
    return status(false, "signature verification failed", data);
  }

  const validUntil = data.valid_until;
  if (typeof validUntil === "string" && validUntil.length > 0) {
    const expiry = parseIsoUtc(validUntil);
    // An unparseable date must not fail a signature-valid license closed.
    if (!Number.isNaN(expiry) && Date.now() > expiry) {
      return status(false, "license expired", data, true);
    }
  }

  return status(true, "valid", data);
}
