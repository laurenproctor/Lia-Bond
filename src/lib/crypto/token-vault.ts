import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Credential encryption.
 *
 * OAuth refresh tokens are long-lived bearer credentials for someone else's
 * business listings. Storing them in the clear would mean a single read of one
 * table is enough to act as every connected restaurant group, indefinitely. So
 * they are encrypted before they reach the database, and the key lives in the
 * environment rather than in Postgres — a database dump on its own decrypts
 * nothing.
 *
 * AES-256-GCM, from Node's standard library. Authenticated encryption is the
 * requirement, not a preference: without the GCM tag, ciphertext could be
 * altered in storage and would decrypt to something attacker-influenced rather
 * than failing. No cryptography is invented here — this module only assembles
 * primitives and defines the envelope format.
 *
 * `server-only` is the first import: a client component that reaches for this
 * file fails the build instead of shipping key handling to a browser.
 */

/** Format version. Bump when the envelope layout changes, never silently. */
const ENVELOPE_VERSION = "v1";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96 bits is the GCM-recommended nonce size; longer nonces get re-hashed. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface VaultKey {
  /** Identifies which key encrypted a value, so keys can be rotated later. */
  id: string;
  material: Buffer;
}

/**
 * A sealed credential.
 *
 * Serialised as one string rather than four columns. The parts are all public —
 * only the key is secret — and keeping them together makes it impossible to
 * store a ciphertext whose IV or tag went missing, which is the failure mode
 * that turns "encrypted at rest" into "unrecoverable at rest".
 *
 *   v1.<keyId>.<iv:b64url>.<tag:b64url>.<ciphertext:b64url>
 */
export type SealedCredential = string;

export class CredentialVaultError extends Error {
  readonly code:
    | "not_configured"
    | "invalid_key"
    | "empty_input"
    | "malformed_payload"
    | "decryption_failed";

  constructor(code: CredentialVaultError["code"], message: string) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * Read a key from its configured encoding.
 *
 * Accepts base64, base64url, or hex, because an operator generating a key with
 * `openssl rand` and one using `node -e` will reach for different encodings and
 * neither should have to read this file to find out which one we wanted. What
 * is not negotiable is the decoded length.
 */
export function parseVaultKey(raw: string, keyId = "default"): VaultKey {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CredentialVaultError("invalid_key", "The encryption key is empty.");
  }

  const candidates = [
    /^[0-9a-fA-F]+$/.test(trimmed) ? Buffer.from(trimmed, "hex") : null,
    Buffer.from(trimmed, "base64url"),
    Buffer.from(trimmed, "base64"),
  ];

  const material = candidates.find((buffer) => buffer?.length === KEY_BYTES);
  if (!material) {
    throw new CredentialVaultError(
      "invalid_key",
      `The encryption key must decode to ${KEY_BYTES} bytes. Generate one with: openssl rand -base64 32`,
    );
  }

  return { id: keyId, material };
}

/** A fresh key, for `.env.local` and for tests. Never checked in. */
export function generateVaultKeyMaterial(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * Encrypt a credential.
 *
 * Empty input is rejected rather than encrypted. A sealed empty string is
 * indistinguishable downstream from a sealed real token, and the difference
 * between "we have no refresh token" and "we have one" drives whether Lia
 * offers to re-authorize — so it must not be expressible as valid ciphertext.
 */
export function seal(key: VaultKey, plaintext: string): SealedCredential {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new CredentialVaultError(
      "empty_input",
      "Refusing to encrypt an empty credential.",
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.material, iv);

  // The version and key id are authenticated but not encrypted: a downgrade to
  // an older envelope format has to fail the tag check, not just parse.
  const aad = Buffer.from(`${ENVELOPE_VERSION}.${key.id}`, "utf8");
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    key.id,
    b64url(iv),
    b64url(tag),
    b64url(ciphertext),
  ].join(".");
}

interface ParsedEnvelope {
  version: string;
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function parseEnvelope(value: string): ParsedEnvelope {
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialVaultError("empty_input", "There is no credential to decrypt.");
  }

  const parts = value.split(".");
  if (parts.length !== 5) {
    throw new CredentialVaultError(
      "malformed_payload",
      "The stored credential is not a recognised envelope.",
    );
  }

  const [version, keyId, ivPart, tagPart, ciphertextPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== ENVELOPE_VERSION) {
    throw new CredentialVaultError(
      "malformed_payload",
      `Unsupported credential envelope version "${version}".`,
    );
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new CredentialVaultError(
      "malformed_payload",
      "The stored credential envelope is the wrong shape.",
    );
  }

  return { version, keyId, iv, tag, ciphertext };
}

/** Which key sealed this value. Lets a caller pick from a keyring on rotation. */
export function sealedKeyId(value: SealedCredential): string {
  return parseEnvelope(value).keyId;
}

/**
 * Decrypt a credential.
 *
 * Every failure — wrong key, flipped bit, truncated envelope — surfaces as a
 * `CredentialVaultError` with no plaintext, no ciphertext, and no key material
 * in the message. Callers translate that into "re-authorize this connection",
 * which is the only honest remediation.
 */
export function open(key: VaultKey, value: SealedCredential): string {
  const envelope = parseEnvelope(value);

  // Constant-time, though the key id is not secret: it keeps the comparison
  // habit uniform so a genuinely secret comparison is never written with `===`.
  const expected = Buffer.from(key.id, "utf8");
  const actual = Buffer.from(envelope.keyId, "utf8");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new CredentialVaultError(
      "decryption_failed",
      "This credential was sealed with a different key.",
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.material, envelope.iv);
    decipher.setAAD(Buffer.from(`${envelope.version}.${envelope.keyId}`, "utf8"));
    decipher.setAuthTag(envelope.tag);

    const plaintext = Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]).toString("utf8");

    return plaintext;
  } catch {
    // Deliberately swallowing the driver message: OpenSSL's text distinguishes
    // a bad tag from a bad key, and that distinction is an oracle.
    throw new CredentialVaultError(
      "decryption_failed",
      "This credential could not be decrypted. It must be re-authorized.",
    );
  }
}

/** Convenience wrapper so a caller holds one object rather than a key. */
export interface CredentialVault {
  keyId: string;
  seal(plaintext: string): SealedCredential;
  open(value: SealedCredential): string;
}

export function createVault(key: VaultKey): CredentialVault {
  return {
    keyId: key.id,
    seal: (plaintext) => seal(key, plaintext),
    open: (value) => open(key, value),
  };
}
