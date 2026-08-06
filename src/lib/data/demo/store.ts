import type {
  AnalysisRun,
  Invitation,
  NewsPollRun,
  NewsRejectedCandidate,
  OAuthState,
  PlatformSyncRun,
} from "@/domain";
import type { SealedCredentialRecord } from "@/lib/data/types";
import type { SeedDataset } from "@/lib/seed/dataset";
import { SEED_DATASET } from "@/lib/seed/dataset";

/**
 * Mutable in-memory copy of the seed dataset.
 *
 * Demo mode has to support the seven mutations, otherwise "the app runs without
 * a database" would mean "the app is read-only", and the audit trail would
 * never be exercised. So the store is a deep clone that lives for the life of
 * the process; restarting the dev server resets it to the seed.
 *
 * The clone matters: mutating `SEED_DATASET` directly would corrupt the fixture
 * that tests and the SQL generator both read.
 */

function clone(dataset: SeedDataset): SeedDataset {
  return structuredClone(dataset);
}

let state: SeedDataset = clone(SEED_DATASET);

/**
 * Runtime-only tables.
 *
 * OAuth handshakes and sealed credentials are not seeded and never will be:
 * shipping a fixture credential, even a fake one, is how a fake credential ends
 * up somewhere real. They exist only for records created during this process's
 * lifetime, and they are wiped by `resetDemoStore()` alongside everything else.
 *
 * Credentials are keyed by connection id and hold ciphertext, exactly as the
 * `platform_connection_secrets` table does — the demo adapter runs the real
 * encryption path rather than storing plaintext, so a broken vault fails in
 * development instead of in production.
 */
interface RuntimeStore {
  oauthStates: OAuthState[];
  /**
   * State-id → state hash.
   *
   * Held beside the records rather than on them, which is what the database
   * does too: `state_hash` is a lookup key, and putting it on the domain object
   * would carry it into anything that ever serialises an `OAuthState`.
   */
  stateHashes: Map<string, string>;
  credentials: Map<string, SealedCredentialRecord>;
  /**
   * Synchronisation history.
   *
   * Runtime-only for the same reason credentials are: a seeded sync run would
   * claim the demo tenant had imported reviews from a Google account that does
   * not exist. Runs appear here only when a sync is actually performed.
   */
  syncRuns: PlatformSyncRun[];
  /** Monotonic counter, so two runs in the same millisecond get distinct ids. */
  syncRunSequence: number;
  /**
   * Analysis history.
   *
   * Runtime-only for the same reason as sync runs: a seeded analysis run would
   * claim the demo tenant had spent money on a model it never called. The
   * seeded `mentionAnalyses` are hand-written fixtures and carry no run id.
   */
  analysisRuns: AnalysisRun[];
  analysisRunSequence: number;
  /**
   * Invitations.
   *
   * Runtime-only, like credentials and sync runs. A seeded invitation would be
   * a standing offer of membership in the demo tenant, and its token hash would
   * be a fixture — which is exactly how a fixture credential ends up somewhere
   * real.
   */
  invitations: Invitation[];
  /** Invitation id → token hash, held beside the records as the database does. */
  invitationTokenHashes: Map<string, string>;
  invitationSequence: number;
  /**
   * News poll history and the rejections each poll produced.
   *
   * Runtime-only for the same reason sync and analysis runs are: a seeded
   * poll run would claim Lia had already spent provider budget it never
   * spent. `monitoringQueries` itself is standing configuration, not event
   * history, so it lives in `SeedDataset` instead — see the doc comment
   * there.
   */
  newsPollRuns: NewsPollRun[];
  newsPollRunSequence: number;
  newsRejectedCandidates: NewsRejectedCandidate[];
  newsRejectedCandidateSequence: number;
}

function freshRuntimeStore(): RuntimeStore {
  return {
    oauthStates: [],
    stateHashes: new Map(),
    credentials: new Map(),
    syncRuns: [],
    syncRunSequence: 0,
    analysisRuns: [],
    analysisRunSequence: 0,
    invitations: [],
    invitationTokenHashes: new Map(),
    invitationSequence: 0,
    newsPollRuns: [],
    newsPollRunSequence: 0,
    newsRejectedCandidates: [],
    newsRejectedCandidateSequence: 0,
  };
}

let runtime: RuntimeStore = freshRuntimeStore();

export function demoStore(): SeedDataset {
  return state;
}

export function demoRuntimeStore(): RuntimeStore {
  return runtime;
}

/** Back to the pristine seed. Tests call this between cases. */
export function resetDemoStore(): void {
  state = clone(SEED_DATASET);
  runtime = freshRuntimeStore();
}

/** Rows in one organization. The only way this module exposes a table. */
export function scoped<T extends { organizationId: string }>(
  rows: T[],
  organizationId: string,
): T[] {
  return rows.filter((row) => row.organizationId === organizationId);
}

/** Replace a row in place, preserving order. Returns the updated row. */
export function replaceRow<T extends { id: string }>(rows: T[], updated: T): T {
  const index = rows.findIndex((row) => row.id === updated.id);
  if (index === -1) {
    rows.push(updated);
  } else {
    rows[index] = updated;
  }
  return updated;
}
