import type {
  AnalysisRun,
  AutomationRuleExecution,
  AutomationSweep,
  GenerationAttempt,
  Invitation,
  NewsPollRun,
  NewsRejectedCandidate,
  OAuthState,
  PlatformSyncRun,
  ReviewWidget,
  YelpActivityOccurrence,
  YelpListingSnapshot,
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

/**
 * The in-memory row behind a generation attempt.
 *
 * `GenerationAttempt` (the domain entity) deliberately has no `claimToken`
 * field — see its doc comment: it is never readable once issued, only ever
 * returned once by `claim`. The demo store still has to hold it somewhere to
 * run the same compare-and-set `complete`/`fail` enforce, so this is the one
 * place it lives, kept out of anything the repository returns.
 */
export interface DemoGenerationAttempt extends GenerationAttempt {
  claimToken: string;
}


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
  /**
   * Provisioning request key → the organization it created.
   *
   * Beside the records for the same reason `stateHashes` is: the key is
   * idempotency plumbing, not a fact about an organization that any screen
   * renders, and putting it on the domain object would carry it into anything
   * that ever serialises one. The database keeps it as a column with a partial
   * unique index — the index *is* the lock there — but nothing reads it back
   * except the replay arm, which is why `provision_request_key` is also
   * excluded from the seed generator's column list.
   */
  provisionRequestKeys: Map<string, string>;
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
  /**
   * Sweep and rule-execution history.
   *
   * Runtime-only for the same reason sync, analysis, and poll runs are: a
   * seeded sweep would claim the demo tenant had already run automation it
   * never ran. Empty until Task 7 makes the demo adapter write to them.
   */
  automationSweeps: AutomationSweep[];
  automationRuleExecutions: AutomationRuleExecution[];
  /**
   * Response generation's claim/complete/fail lifecycle.
   *
   * Runtime-only for the same reason sync, analysis, and sweep history are: a
   * seeded attempt would claim the demo tenant had already spent provider
   * budget generating a response it never generated.
   */
  generationAttempts: DemoGenerationAttempt[];
  /**
   * Yelp listing observations, and the changes between them.
   *
   * Runtime-only for the same reason every other history table here is: a
   * seeded snapshot would claim Lia had already checked a real Yelp listing,
   * and a seeded occurrence would put fabricated review activity — the exact
   * thing this feature must never invent — in front of anybody opening demo
   * mode. Both fill in only when a check actually runs.
   */
  yelpListingSnapshots: YelpListingSnapshot[];
  yelpListingSnapshotSequence: number;
  yelpActivityOccurrences: YelpActivityOccurrence[];
  yelpActivityOccurrenceSequence: number;
  /**
   * Website review widgets.
   *
   * Runtime-only, and for a different reason from every other table in here.
   * The others are event history that would claim work Lia never did; a seeded
   * widget would be worse than a claim — it would be a live public embed id,
   * shipped in the repository, resolving to a real review for anybody who
   * pasted it into a page. That is the same reasoning that keeps fixture
   * credentials out of the seed, applied to something that is not a credential
   * but is just as much a published artefact.
   */
  reviewWidgets: ReviewWidget[];
}

function freshRuntimeStore(): RuntimeStore {
  return {
    oauthStates: [],
    stateHashes: new Map(),
    provisionRequestKeys: new Map(),
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
    automationSweeps: [],
    automationRuleExecutions: [],
    generationAttempts: [],
    yelpListingSnapshots: [],
    yelpListingSnapshotSequence: 0,
    yelpActivityOccurrences: [],
    yelpActivityOccurrenceSequence: 0,
    reviewWidgets: [],
  };
}

/**
 * The store lives on `globalThis`, not in a module-scoped `let`.
 *
 * This module's doc comment has always claimed the store is "process-wide so
 * mutations survive between requests in dev". With a module-scoped variable
 * that was only true *within one Next.js module graph* — and Next compiles
 * pages, server actions, and route handlers into separate graphs, each with
 * its own copy of every module. Two consequences, both of which look exactly
 * like a feature bug:
 *
 * - a record written by a server action is invisible to a route handler in the
 *   same process; and
 * - the same is true after a hot reload, which re-evaluates the module and
 *   silently resets everybody's data to the seed.
 *
 * Found while building the website review widget, which is the first feature
 * with a *public route handler* reading rows the app writes: a widget saved on
 * `/integrations/review-widget` rendered as "no longer available" at
 * `/embed/review-widget/…`, in the same process, seconds later. The cron
 * routes have the same shape and have simply never had a reader on the other
 * side to notice.
 *
 * The `Symbol.for` key is the standard Next.js singleton pattern (the one the
 * Prisma client uses for the same reason). It changes nothing for tests:
 * `resetDemoStore()` still replaces both halves, and vitest runs each file in
 * its own worker.
 */
const STORE_KEY = Symbol.for("lia.demo.store");

interface DemoStoreHolder {
  state: SeedDataset;
  runtime: RuntimeStore;
}

function holder(): DemoStoreHolder {
  const globals = globalThis as typeof globalThis & {
    [STORE_KEY]?: DemoStoreHolder;
  };
  globals[STORE_KEY] ??= { state: clone(SEED_DATASET), runtime: freshRuntimeStore() };
  return globals[STORE_KEY];
}

export function demoStore(): SeedDataset {
  return holder().state;
}

export function demoRuntimeStore(): RuntimeStore {
  return holder().runtime;
}

/** Back to the pristine seed. Tests call this between cases. */
export function resetDemoStore(): void {
  const current = holder();
  current.state = clone(SEED_DATASET);
  current.runtime = freshRuntimeStore();
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
