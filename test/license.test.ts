/** Ported from tests/test_license.py, plus a cross-language canonical-JSON fixture. */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, verifyLicense } from "../src/license.js";

// A throwaway Ed25519 keypair stands in for the real signing key, the same way
// the Python suite monkeypatches the embedded public key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyB64 = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(12)
  .toString("base64");

function signLicense(body: Record<string, unknown>): Record<string, unknown> {
  const signature = cryptoSign(null, Buffer.from(canonicalJson(body), "utf-8"), privateKey);
  return { ...body, signature: signature.toString("base64") };
}

const BASE = {
  license_id: "BSN-2026-0042",
  tier: "enterprise",
  customer: { company_name: "Acme A/S" },
  valid_until: "2099-01-01T00:00:00+00:00",
};

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function writeTempLicense(license: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bastion-license-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "license.json");
  writeFileSync(file, JSON.stringify(license), "utf-8");
  return file;
}

describe("verifyLicense", () => {
  it("reports a missing file", () => {
    const status = verifyLicense(path.join(tmpdir(), "definitely-absent-license.json"));
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("no license file found");
  });

  it("rejects a license with no signature", () => {
    const status = verifyLicense(BASE, { publicKeyB64 });
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("license has no signature");
    // Metadata is still surfaced for audit logging.
    expect(status.licenseId).toBe("BSN-2026-0042");
    expect(status.company).toBe("Acme A/S");
  });

  it("accepts a correctly signed license", () => {
    const status = verifyLicense(signLicense(BASE), { publicKeyB64 });
    expect(status.valid).toBe(true);
    expect(status.reason).toBe("valid");
    expect(status.tier).toBe("enterprise");
    expect(status.expired).toBe(false);
  });

  it("rejects a tampered license", () => {
    const signed = signLicense(BASE);
    signed.tier = "free";
    const status = verifyLicense(signed, { publicKeyB64 });
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("signature verification failed");
  });

  it("rejects a license signed by the wrong key", () => {
    const other = generateKeyPairSync("ed25519");
    const otherB64 = other.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(12)
      .toString("base64");
    const status = verifyLicense(signLicense(BASE), { publicKeyB64: otherB64 });
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("signature verification failed");
  });

  it("rejects an expired but correctly signed license", () => {
    const status = verifyLicense(
      signLicense({ ...BASE, valid_until: "2020-01-01T00:00:00+00:00" }),
      { publicKeyB64 },
    );
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("license expired");
    expect(status.expired).toBe(true);
  });

  it("does not fail closed on an unparseable expiry", () => {
    const status = verifyLicense(signLicense({ ...BASE, valid_until: "not-a-date" }), {
      publicKeyB64,
    });
    expect(status.valid).toBe(true);
  });

  it("treats a naive timestamp as UTC, not local time", () => {
    // Python pins naive timestamps to UTC; JS `Date` would read them as local.
    const status = verifyLicense(signLicense({ ...BASE, valid_until: "2099-01-01T00:00:00" }), {
      publicKeyB64,
    });
    expect(status.valid).toBe(true);
  });

  it("loads a license from a file path", () => {
    const file = writeTempLicense(signLicense(BASE));
    expect(verifyLicense(file, { publicKeyB64 }).valid).toBe(true);
  });
});

describe("canonicalJson", () => {
  const cases = JSON.parse(
    readFileSync(new URL("./fixtures/canonical-json.json", import.meta.url), "utf-8"),
  ) as { obj: unknown; canonical: string }[];

  it.each(cases.map((c, i) => [i, c] as const))(
    "matches Python byte-for-byte (case %i)",
    (_i, c) => {
      expect(canonicalJson(c.obj)).toBe(c.canonical);
    },
  );
});
