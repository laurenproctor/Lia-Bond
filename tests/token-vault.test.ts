import { describe, expect, it } from "vitest";
import {
  CredentialVaultError,
  createVault,
  generateVaultKeyMaterial,
  open,
  parseVaultKey,
  seal,
  sealedKeyId,
} from "@/lib/crypto/token-vault";

/**
 * Credential encryption.
 *
 * The cases that matter are the failures. A vault that encrypts and decrypts
 * correctly but accepts tampered ciphertext is not encryption, it is
 * obfuscation — so most of what is asserted here is what the vault refuses.
 */

const KEY_A = parseVaultKey(generateVaultKeyMaterial(), "key-a");
const KEY_B = parseVaultKey(generateVaultKeyMaterial(), "key-a");

describe("key parsing", () => {
  it("accepts base64, base64url, and hex encodings of 32 bytes", () => {
    const bytes = Buffer.from(generateVaultKeyMaterial(), "base64");

    const fromBase64 = parseVaultKey(bytes.toString("base64"));
    const fromBase64Url = parseVaultKey(bytes.toString("base64url"));
    const fromHex = parseVaultKey(bytes.toString("hex"));

    expect(fromBase64.material.equals(bytes)).toBe(true);
    expect(fromBase64Url.material.equals(bytes)).toBe(true);
    expect(fromHex.material.equals(bytes)).toBe(true);
  });

  it("rejects a key that is not 32 bytes", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(() => parseVaultKey(short)).toThrowError(CredentialVaultError);
  });

  it("rejects an empty key", () => {
    expect(() => parseVaultKey("   ")).toThrowError(CredentialVaultError);
  });
});

describe("round trip", () => {
  it("returns exactly what was sealed", () => {
    // Shaped like an OAuth token — slashes, dots, underscores, hyphens — but
    // deliberately not prefixed like a real Google one, so a secret scanner has
    // nothing to flag.
    const secret = "fake-refresh//token_value.with-every.symbol_class";
    expect(open(KEY_A, seal(KEY_A, secret))).toBe(secret);
  });

  it("produces different ciphertext for the same input", () => {
    // A fresh nonce per seal. Deterministic ciphertext would leak that two
    // connections hold the same token.
    const first = seal(KEY_A, "same-token");
    const second = seal(KEY_A, "same-token");

    expect(first).not.toBe(second);
    expect(open(KEY_A, first)).toBe(open(KEY_A, second));
  });

  it("survives unicode and long values", () => {
    const secret = `${"ya29.".repeat(50)}café–token`;
    expect(open(KEY_A, seal(KEY_A, secret))).toBe(secret);
  });

  it("records which key sealed the value", () => {
    expect(sealedKeyId(seal(KEY_A, "token"))).toBe("key-a");
  });
});

describe("rejections", () => {
  it("refuses to encrypt an empty credential", () => {
    // A sealed empty string is indistinguishable downstream from a sealed real
    // token, and that difference decides whether Lia offers to reauthorize.
    expect(() => seal(KEY_A, "")).toThrowError(
      expect.objectContaining({ code: "empty_input" }),
    );
  });

  it("rejects tampered ciphertext", () => {
    const sealed = seal(KEY_A, "token-value");
    const parts = sealed.split(".");
    const ciphertext = Buffer.from(parts[4] as string, "base64url");
    ciphertext[0] = (ciphertext[0]! ^ 0xff) & 0xff;
    parts[4] = ciphertext.toString("base64url");

    expect(() => open(KEY_A, parts.join("."))).toThrowError(
      expect.objectContaining({ code: "decryption_failed" }),
    );
  });

  it("rejects a tampered authentication tag", () => {
    const parts = seal(KEY_A, "token-value").split(".");
    const tag = Buffer.from(parts[3] as string, "base64url");
    tag[0] = (tag[0]! ^ 0xff) & 0xff;
    parts[3] = tag.toString("base64url");

    expect(() => open(KEY_A, parts.join("."))).toThrowError(CredentialVaultError);
  });

  it("rejects a swapped initialization vector", () => {
    const first = seal(KEY_A, "token-one").split(".");
    const second = seal(KEY_A, "token-two").split(".");
    second[2] = first[2] as string;

    expect(() => open(KEY_A, second.join("."))).toThrowError(CredentialVaultError);
  });

  it("rejects the wrong key", () => {
    // Same key id, different material — so this fails on the GCM tag rather
    // than on the cheap id comparison, which is the case that actually matters.
    const sealed = seal(KEY_A, "token-value");
    expect(() => open(KEY_B, sealed)).toThrowError(
      expect.objectContaining({ code: "decryption_failed" }),
    );
  });

  it("rejects a value sealed under a different key id", () => {
    const other = parseVaultKey(KEY_A.material.toString("base64"), "key-b");
    expect(() => open(other, seal(KEY_A, "token"))).toThrowError(
      CredentialVaultError,
    );
  });

  it("rejects a downgraded envelope version", () => {
    const parts = seal(KEY_A, "token-value").split(".");
    parts[0] = "v0";
    expect(() => open(KEY_A, parts.join("."))).toThrowError(
      expect.objectContaining({ code: "malformed_payload" }),
    );
  });

  it.each([
    ["", "empty_input"],
    ["not-an-envelope", "malformed_payload"],
    ["v1.default.short", "malformed_payload"],
    ["v1.default.aa.bb.cc.dd.ee", "malformed_payload"],
    ["v1.default.aa.bb.cc", "malformed_payload"],
  ])("rejects the malformed payload %j", (payload, code) => {
    expect(() => open(KEY_A, payload)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("never puts key material or plaintext in an error message", () => {
    const secret = "super-secret-refresh-token";
    const sealed = seal(KEY_A, secret);

    try {
      open(KEY_B, sealed);
      throw new Error("expected a decryption failure");
    } catch (error) {
      const text = String(error);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(KEY_A.material.toString("base64"));
      expect(text).not.toContain(KEY_B.material.toString("base64"));
    }
  });
});

describe("vault wrapper", () => {
  it("exposes seal and open bound to one key", () => {
    const vault = createVault(KEY_A);
    expect(vault.keyId).toBe("key-a");
    expect(vault.open(vault.seal("value"))).toBe("value");
  });
});
