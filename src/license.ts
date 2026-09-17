/**
 * Offline commercial-license verification.
 *
 * A Bastion commercial license is an Ed25519-signed JSON document (emailed on
 * purchase, alongside a human-readable PDF). Verification is fully offline: the
 * public key ships in this module and the signature proves the license is
 * authentic and untampered — no network call, so it works in air-gapped and
 * container deployments.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalJson, parseIsoUtc } from "./utils.js";

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

/**
 * Offline Ed25519 license verification.
 *
 * `source` may be the license object, a path to the license JSON, or undefined
 * to auto-discover it ($BASTION_LICENSE, then ~/.bastion/license.json).
 */
export class LicenseVerifier {
  constructor(
    private readonly source?: Record<string, unknown> | string,
    private readonly publicKeyB64: string = PUBLIC_KEY_B64,
  ) {}

  verify(): LicenseStatus {
    const data = this.loadSource();
    if (data === null) return this.status(false, "no license file found", null);

    const signatureB64 = data.signature;
    if (typeof signatureB64 !== "string" || signatureB64.length === 0) {
      return this.status(false, "license has no signature", data);
    }

    try {
      const publicKey = createPublicKey({
        key: Buffer.concat([
          ED25519_SPKI_PREFIX,
          Buffer.from(this.publicKeyB64, "base64"),
        ]),
        format: "der",
        type: "spki",
      });
      const { signature: _omit, ...body } = data;
      const message = Buffer.from(canonicalJson(body), "utf-8");
      const ok = cryptoVerify(null, message, publicKey, Buffer.from(signatureB64, "base64"));
      if (!ok) return this.status(false, "signature verification failed", data);
    } catch {
      return this.status(false, "signature verification failed", data);
    }

    const validUntil = data.valid_until;
    if (typeof validUntil === "string" && validUntil.length > 0) {
      const expiry = parseIsoUtc(validUntil);
      // An unparseable date must not fail a signature-valid license closed.
      if (!Number.isNaN(expiry) && Date.now() > expiry) {
        return this.status(false, "license expired", data, true);
      }
    }

    return this.status(true, "valid", data);
  }

  private loadSource(): Record<string, unknown> | null {
    if (this.source !== undefined && typeof this.source === "object") return this.source;
    const candidates = this.source ? [this.source] : this.defaultPaths();
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      try {
        return JSON.parse(readFileSync(candidate, "utf-8"));
      } catch {
        continue;
      }
    }
    return null;
  }

  private defaultPaths(): string[] {
    const paths: string[] = [];
    if (process.env.BASTION_LICENSE) paths.push(process.env.BASTION_LICENSE);
    paths.push(path.join(homedir(), ".bastion", "license.json"));
    return paths;
  }

  private status(
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
}

/** Convenience wrapper around {@link LicenseVerifier}. */
export function verifyLicense(
  source?: Record<string, unknown> | string,
  options: { publicKeyB64?: string } = {},
): LicenseStatus {
  return new LicenseVerifier(source, options.publicKeyB64).verify();
}
