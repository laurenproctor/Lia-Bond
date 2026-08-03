import "server-only";

import type { PlatformCredentials } from "@/integrations/connector";
import { integrationError } from "@/integrations/errors";
import {
  createVault,
  parseVaultKey,
  type CredentialVault,
} from "@/lib/crypto/token-vault";
import type {
  LiaDataSource,
  OrganizationScope,
  SealedCredentialRecord,
} from "@/lib/data/types";
import { requireTokenEncryptionKey } from "@/lib/env";

/**
 * The credential boundary.
 *
 * This is the only module in the application that turns ciphertext into a
 * usable OAuth token. Everything above it holds `SealedCredentialRecord`
 * (opaque envelopes) or nothing at all; everything below it holds bytes.
 *
 * The rules it exists to enforce:
 *
 * 1. Plaintext credentials never leave a `CredentialSession`, which is
 *    constructed here and handed to a connector for the duration of one call.
 * 2. Nothing here logs, throws, or returns a token. Failures are described by
 *    what the user must do, never by what the value looked like.
 * 3. A connection whose credentials will not decrypt is reported as needing
 *    reauthorization, because that is genuinely the only fix — a lost key is
 *    not recoverable by retrying.
 */

let cachedVault: CredentialVault | null = null;

/**
 * The vault for this process.
 *
 * Cached because deriving it is pure and the key does not change at runtime,
 * and read lazily so a deployment with no Google integration still boots.
 */
export function getVault(): CredentialVault {
  if (cachedVault) return cachedVault;

  const { raw, keyId } = requireTokenEncryptionKey();
  cachedVault = createVault(parseVaultKey(raw, keyId));
  return cachedVault;
}

/** Test seam. Production never calls this — nothing outside tests imports it. */
export function __setVaultForTesting(vault: CredentialVault | null): void {
  cachedVault = vault;
}

/** Encrypt credentials for storage. */
export function sealCredentials(
  credentials: PlatformCredentials,
  vault: CredentialVault = getVault(),
): SealedCredentialRecord {
  return {
    accessTokenSealed: vault.seal(credentials.accessToken),
    // Null is a real state: Google withholds the refresh token on silent
    // re-consent. Sealing an empty string instead would make "we have no
    // refresh token" indistinguishable from "we have one" downstream.
    refreshTokenSealed: credentials.refreshToken
      ? vault.seal(credentials.refreshToken)
      : null,
    scopes: credentials.scopes,
    accessTokenExpiresAt: credentials.expiresAt,
    encryptionKeyId: vault.keyId,
    encryptionVersion: "v1",
    rotatedAt: new Date().toISOString(),
  };
}

/** Decrypt stored credentials. Only ever called from within this module's helpers. */
export function openCredentials(
  record: SealedCredentialRecord,
  vault: CredentialVault = getVault(),
): PlatformCredentials {
  if (!record.accessTokenSealed) {
    throw integrationError("authorization_revoked");
  }

  try {
    return {
      accessToken: vault.open(record.accessTokenSealed),
      refreshToken: record.refreshTokenSealed
        ? vault.open(record.refreshTokenSealed)
        : null,
      expiresAt: record.accessTokenExpiresAt,
      scopes: record.scopes,
      tokenType: "Bearer",
    };
  } catch {
    // A rotated-away key, a corrupted envelope, a tampered ciphertext: all
    // unrecoverable, and all fixed by the same action. The underlying error is
    // deliberately not attached — it would distinguish "wrong key" from "bad
    // tag", which is an oracle.
    throw integrationError("authorization_revoked", {
      message:
        "Lia can no longer read the stored Google credentials. Reauthorize to reconnect this account.",
    });
  }
}

/**
 * Merge freshly issued credentials with what is already stored.
 *
 * This exists for one Google behaviour that would otherwise break every
 * reconnection: Google issues a refresh token on first consent and **withholds
 * it** on subsequent approvals of the same grant. Taking the new response at
 * face value would replace a working refresh token with null, and the
 * connection would die silently the next time its access token expired —
 * hours later, with no obvious cause.
 *
 * So the incoming refresh token wins only when there is one.
 */
export function mergeCredentials(
  incoming: PlatformCredentials,
  existing: PlatformCredentials | null,
): PlatformCredentials {
  return {
    ...incoming,
    refreshToken: incoming.refreshToken ?? existing?.refreshToken ?? null,
    scopes: incoming.scopes.length > 0 ? incoming.scopes : (existing?.scopes ?? []),
  };
}

export interface LoadedCredentials {
  credentials: PlatformCredentials;
  record: SealedCredentialRecord;
}

/**
 * Read and decrypt a connection's credentials.
 *
 * Returns null when nothing is stored — a disconnected connection, or one that
 * never completed a handshake — so callers can distinguish "not connected"
 * from "connected but broken".
 */
export async function loadCredentials(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  connectionId: string,
): Promise<LoadedCredentials | null> {
  const record = await dataSource.platformCredentials.load(scope, connectionId);
  if (!record || !record.accessTokenSealed) return null;

  return { credentials: openCredentials(record), record };
}

export async function saveCredentials(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  connectionId: string,
  credentials: PlatformCredentials,
): Promise<void> {
  await dataSource.platformCredentials.save(
    scope,
    connectionId,
    sealCredentials(credentials),
  );
}

/**
 * A credential session for one connector call.
 *
 * The write-back closure is the important part: when a connector refreshes an
 * access token mid-call, the new one is persisted immediately. Without it, every
 * request would refresh again — burning Google quota, and risking dropping a
 * rotated refresh token that the old one can no longer replace.
 */
export function credentialSession(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  connectionId: string,
  credentials: PlatformCredentials,
) {
  return {
    credentials,
    async onRefreshed(next: PlatformCredentials): Promise<void> {
      await saveCredentials(dataSource, scope, connectionId, next);
    },
  };
}
