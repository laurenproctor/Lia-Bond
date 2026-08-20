import { z } from "zod";

/**
 * Environment configuration.
 *
 * Parsed once, validated with Zod, and read through helpers rather than
 * scattering `process.env` lookups. Nothing here has a default that would let a
 * misconfigured deployment silently fall back to demo data in production — see
 * `assertProductionConfig`.
 *
 * Two kinds of validation happen, and the split is deliberate:
 *
 * - **Shape, at startup.** Anything present must be well-formed. A redirect URI
 *   that is not a URL, an integration mode that is not a known word, an
 *   encryption key of the wrong length: all rejected before the process serves
 *   a request.
 * - **Presence, at first use.** Requiring `GOOGLE_CLIENT_ID` at import time
 *   would break `next build`, which prerenders with `NODE_ENV=production` and
 *   no secrets, and it would stop the app running at all for anyone who has not
 *   set up a Google Cloud project. So the Google helpers below throw a clear,
 *   server-side configuration error at the moment someone tries to connect.
 */

/**
 * Which Google implementation is in play.
 *
 * `mock` returns a deterministic fixture connector for local work and tests. It
 * is refused outright when `NODE_ENV=production` — a production deployment that
 * quietly served fake Google accounts would be worse than one that failed.
 */
const googleIntegrationModeSchema = z.enum(["live", "mock"]);
export type GoogleIntegrationMode = z.infer<typeof googleIntegrationModeSchema>;

/**
 * Which analyser is in play.
 *
 * Same posture as the Google mode, and refused in production for the same
 * reason: a deployment quietly serving fabricated risk assessments would be
 * worse than one that failed to boot. A fake "low risk" on a food-safety
 * complaint is not a cosmetic problem.
 */
const aiModeSchema = z.enum(["live", "mock"]);
export type AiMode = z.infer<typeof aiModeSchema>;

/**
 * How outbound mail leaves this process.
 *
 * `log` writes the message to the server log and delivers nothing. It exists so
 * the help form can be exercised locally without a Resend account, and — like
 * every other mock in this file — it is refused in production. The UI is told
 * which mode ran and says "recorded, not sent" rather than claiming a delivery
 * that did not happen.
 */
const emailModeSchema = z.enum(["live", "log"]);
export type EmailMode = z.infer<typeof emailModeSchema>;

/**
 * Which news monitor is in play.
 *
 * Same posture as Google and the analyser, and for the same reason: a
 * deployment quietly serving fabricated news articles would be worse than one
 * that plainly says news is not configured.
 */
const newsModeSchema = z.enum(["live", "mock"]);
export type NewsMode = z.infer<typeof newsModeSchema>;

/**
 * Which Yelp provider is in play.
 *
 * Same two words as everywhere else, refused in production for the same
 * reason — but the fabrication this one guards against is worth naming, because
 * it does not look like fabrication. The mock hands out a review count and a
 * rating, and those two numbers are the *entire* evidence base for "review
 * activity detected". A production deployment quietly serving mock counters
 * would not show a customer a fake review; it would tell them a real review had
 * appeared on their real listing and ask them to go and find it. There is
 * nothing on the screen at that point that could give the lie away.
 */
const yelpModeSchema = z.enum(["live", "mock"]);
export type YelpMode = z.infer<typeof yelpModeSchema>;

/**
 * Which mode the rules engine runs in.
 *
 * Execution changes what the product does to customer data without a person
 * in the loop; absence of configuration must mean absence of the behavior.
 * Unlike the other mode enums in this file there is no `mock`/`unconfigured`
 * split to worry about — the three words here are `off`, `dry_run` (evaluate
 * and log what would happen, act on nothing), and `apply` (act). Anything
 * else, including a plausible-looking typo like `dry-run`, fails the startup
 * parse rather than being coerced into something safe-sounding.
 */
const rulesExecutionModeSchema = z.enum(["off", "dry_run", "apply"]);
export type RulesExecutionMode = z.infer<typeof rulesExecutionModeSchema>;

/**
 * Which Reddit implementation is in play.
 *
 * Same two words as everywhere else, refused in production for the same
 * reason: fabricated public discussion about a restaurant is worse than an
 * honest "Reddit is not configured".
 */
const redditModeSchema = z.enum(["live", "mock"]);
export type RedditMode = z.infer<typeof redditModeSchema>;

/**
 * How far Reddit is turned on for this deployment.
 *
 * Separate from the mode, because "the connector works" and "we are permitted
 * to use it" are different facts about Reddit in a way they are not about
 * Google or GNews. Reddit grants commercial API access by contract, so a
 * deployment can hold a valid OAuth client and still have no right to call
 * anything — and the right to *read* and the right to *post on a customer's
 * behalf* are negotiated separately.
 *
 * `off` calls nothing. `read_only` discovers, refreshes, and analyses. Only
 * `read_write` may ever reach `POST /api/comment`, and only then behind a
 * named human approval. Absence means `off`, following `RULES_EXECUTION_MODE`
 * rather than the mode enums: this decides whether Lia touches a live public
 * forum, so absence of configuration must mean absence of the behavior.
 */
const redditRolloutStageSchema = z.enum(["off", "read_only", "read_write"]);
export type RedditRolloutStage = z.infer<typeof redditRolloutStageSchema>;

/**
 * Whether the signed terms permit running a model over Reddit content.
 *
 * Its own switch rather than something implied by `read_write`, because the
 * two are genuinely separable: an agreement can allow display to a customer's
 * team and withhold AI inference, and Lia must be able to ship monitoring
 * under those terms without also shipping drafting. Fails closed — anything
 * other than the recorded word means no inference.
 */
const redditAiInferenceSchema = z.enum(["permitted", "not_permitted"]);

/**
 * Reddit's requested user-agent shape:
 * `<platform>:<app id>:<version> (by /u/<username>)`.
 *
 * Validated rather than trusted because a generic, shared, or absent agent is
 * throttled far harder than an identified one — so a malformed value does not
 * fail, it degrades, and it degrades as a 429 in production rather than as a
 * startup error anybody would notice.
 */
const REDDIT_USER_AGENT_PATTERN =
  /^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*:\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)? \(by \/u\/[A-Za-z0-9_-]{3,20}\)$/;

/**
 * The Gate 0 marker: `YYYY-MM-DD:<reference>`.
 *
 * Dated rather than free text for two reasons. It cannot be satisfied by
 * typing "approved", which is the failure mode a bare boolean invites; and the
 * retention schedule needs a date to count from, so the one value that records
 * "Reddit agreed" also records when.
 *
 * Not a secret, and not a security boundary — an operator who wants to lie to
 * this variable can. It is here so that turning Reddit on is a deliberate act
 * that names the agreement permitting it, rather than a side effect of pasting
 * in a client id.
 */
const REDDIT_APPROVAL_REF_PATTERN = /^\d{4}-\d{2}-\d{2}:[A-Za-z0-9][A-Za-z0-9._-]*$/;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Set both public Supabase values to switch the app onto the database. */
    NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
    /** Server-only. Bypasses row-level security; never expose to the browser. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    /** Explicit override, mostly for tests: "demo" or "supabase". */
    LIA_DATA_SOURCE: z.enum(["demo", "supabase"]).optional(),

    /** Public origin, used to build absolute OAuth redirect URIs. */
    APP_URL: z.url().optional(),

    /* Google Business Profile OAuth. Server-only, every one of them. */
    GOOGLE_CLIENT_ID: z.string().min(10).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
    /**
     * Must match a redirect URI registered on the Google OAuth client exactly.
     * Comes from configuration, never from a request parameter.
     */
    GOOGLE_OAUTH_REDIRECT_URI: z.url().optional(),
    GOOGLE_INTEGRATION_MODE: googleIntegrationModeSchema.optional(),

    /* Analysis. Server-only. */
    ANTHROPIC_API_KEY: z.string().min(10).optional(),
    LIA_AI_MODE: aiModeSchema.optional(),
    /**
     * Mentions analysed per run.
     *
     * Coerced because every environment variable is a string, and bounded
     * because one click should have a predictable cost — a first run after a
     * large backfill would otherwise be thousands of model calls in one
     * request.
     */
    LIA_ANALYSIS_BATCH_SIZE: z.coerce.number().int().min(1).max(500).optional(),

    /* Outbound mail. Server-only. */
    RESEND_API_KEY: z.string().min(10).optional(),
    LIA_EMAIL_MODE: emailModeSchema.optional(),
    /** Where help requests land. */
    SUPPORT_INBOX_EMAIL: z.email().optional(),
    /**
     * Envelope sender. Accepts a bare address or "Name <address>", which is why
     * it is not `z.email()`. Must sit on a domain verified with Resend.
     */
    SUPPORT_FROM_EMAIL: z.string().min(5).optional(),
    /**
     * Envelope sender for invitations. Same shape as `SUPPORT_FROM_EMAIL` — a
     * bare address or "Name <address>" — and deliberately a separate variable
     * rather than a reuse of it.
     *
     * The support sender defaults to Resend's shared identity, which only ever
     * delivers to the address that owns the Resend account. That is harmless
     * for help requests, which are addressed to us; it is silent total failure
     * for an invitation, which is addressed to a stranger. Unset means Lia
     * does not claim to have emailed anything — see `inviteFromAddress`.
     */
    INVITE_FROM_EMAIL: z.string().min(5).optional(),
    /* News monitoring. Server-only. */
    GNEWS_API_KEY: z.string().min(1).optional(),
    LIA_NEWS_MODE: newsModeSchema.optional(),
    /** Shared secret the scheduler presents so the poll route cannot be hit by anyone else. */
    CRON_SECRET: z.string().min(16).optional(),

    /* Yelp Assisted. Server-only, and the key is Lia's rather than a tenant's. */
    YELP_API_KEY: z.string().min(1).optional(),
    LIA_YELP_MODE: yelpModeSchema.optional(),
    /**
     * Listing checks one scheduled sweep may make.
     *
     * Yelp meters per API key and the key is shared by every tenant, so this is
     * a Lia-level resource enforced above the tenant loop — the same position
     * D85 put the news budget in, for the same reason: one organization with
     * forty connected listings can otherwise exhaust the day for everyone.
     * Coerced because every environment variable is a string, and required
     * positive so a misconfigured "0" fails at startup rather than silently
     * disabling every check.
     */
    YELP_MAX_CHECKS_PER_SWEEP: z.coerce.number().int().positive().optional(),

    /* Rules execution. Server-only. No default here: see `resolveRulesExecutionMode`. */
    RULES_EXECUTION_MODE: rulesExecutionModeSchema.optional(),
    /** Comma-separated org ids permitted to run rules while this rolls out. */
    RULES_EXECUTION_ORG_ALLOWLIST: z.string().optional(),
    /**
     * Cost bounds for one rules sweep, each independently overridable.
     * Coerced because every environment variable is a string, and required to
     * be a positive integer so a misconfigured "0" or "-5" fails at startup
     * instead of quietly disabling or inverting a limit.
     */
    RULES_MAX_MENTIONS_PER_SWEEP: z.coerce.number().int().positive().optional(),
    RULES_MAX_ACTIONS_PER_SWEEP: z.coerce.number().int().positive().optional(),
    RULES_MAX_RULES_PER_MENTION: z.coerce.number().int().positive().optional(),
    RULES_EXECUTION_BUDGET_MS: z.coerce.number().int().positive().optional(),

    /* Reddit monitoring. Server-only, every one of them. */
    REDDIT_CLIENT_ID: z.string().min(10).optional(),
    REDDIT_CLIENT_SECRET: z.string().min(10).optional(),
    /** Must match the single redirect URI registered on the Reddit app exactly. */
    REDDIT_OAUTH_REDIRECT_URI: z.url().optional(),
    REDDIT_USER_AGENT: z
      .string()
      .regex(
        REDDIT_USER_AGENT_PATTERN,
        "Use Reddit's shape: <platform>:<app id>:<version> (by /u/<username>)",
      )
      .optional(),
    LIA_REDDIT_MODE: redditModeSchema.optional(),
    /** No default here: see `resolveRedditDeployment`. Absence means `off`. */
    REDDIT_ROLLOUT_STAGE: redditRolloutStageSchema.optional(),
    /** Comma-separated org ids permitted to use Reddit while this rolls out. */
    REDDIT_ORG_ALLOWLIST: z.string().optional(),
    REDDIT_ACCESS_APPROVAL_REF: z
      .string()
      .regex(
        REDDIT_APPROVAL_REF_PATTERN,
        "Use YYYY-MM-DD:<reference> naming the recorded approval",
      )
      .optional(),
    REDDIT_AI_INFERENCE: redditAiInferenceSchema.optional(),

    /** 32 bytes, base64 / base64url / hex. Encrypts stored OAuth credentials. */
    TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
    /** Names the active key so ciphertext stays readable across a rotation. */
    TOKEN_ENCRYPTION_KEY_ID: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, - and _")
      .optional(),
  })
  .refine(
    (value) =>
      !(value.GOOGLE_INTEGRATION_MODE === "mock" && value.NODE_ENV === "production"),
    {
      message: "GOOGLE_INTEGRATION_MODE=mock is refused in production",
      path: ["GOOGLE_INTEGRATION_MODE"],
    },
  )
  .refine(
    (value) => !(value.LIA_AI_MODE === "mock" && value.NODE_ENV === "production"),
    {
      message: "LIA_AI_MODE=mock is refused in production",
      path: ["LIA_AI_MODE"],
    },
  )
  .refine(
    (value) => !(value.LIA_EMAIL_MODE === "log" && value.NODE_ENV === "production"),
    {
      message: "LIA_EMAIL_MODE=log is refused in production",
      path: ["LIA_EMAIL_MODE"],
    },
  )
  .refine(
    (value) => !(value.LIA_NEWS_MODE === "mock" && value.NODE_ENV === "production"),
    {
      message: "LIA_NEWS_MODE=mock is refused in production",
      path: ["LIA_NEWS_MODE"],
    },
  )
  .refine(
    (value) => !(value.LIA_YELP_MODE === "mock" && value.NODE_ENV === "production"),
    {
      message: "LIA_YELP_MODE=mock is refused in production",
      path: ["LIA_YELP_MODE"],
    },
  )
  .refine(
    (value) => !(value.LIA_REDDIT_MODE === "mock" && value.NODE_ENV === "production"),
    {
      message: "LIA_REDDIT_MODE=mock is refused in production",
      path: ["LIA_REDDIT_MODE"],
    },
  );

export type Env = z.infer<typeof envSchema>;

function readEnv(): Env {
  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || undefined,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || undefined,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    LIA_DATA_SOURCE: process.env.LIA_DATA_SOURCE || undefined,
    APP_URL: process.env.APP_URL || undefined,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || undefined,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI || undefined,
    GOOGLE_INTEGRATION_MODE: process.env.GOOGLE_INTEGRATION_MODE || undefined,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY || undefined,
    TOKEN_ENCRYPTION_KEY_ID: process.env.TOKEN_ENCRYPTION_KEY_ID || undefined,
    RESEND_API_KEY: process.env.RESEND_API_KEY || undefined,
    LIA_EMAIL_MODE: process.env.LIA_EMAIL_MODE || undefined,
    SUPPORT_INBOX_EMAIL: process.env.SUPPORT_INBOX_EMAIL || undefined,
    SUPPORT_FROM_EMAIL: process.env.SUPPORT_FROM_EMAIL || undefined,
    INVITE_FROM_EMAIL: process.env.INVITE_FROM_EMAIL || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    LIA_AI_MODE: process.env.LIA_AI_MODE || undefined,
    LIA_ANALYSIS_BATCH_SIZE: process.env.LIA_ANALYSIS_BATCH_SIZE || undefined,
    GNEWS_API_KEY: process.env.GNEWS_API_KEY || undefined,
    YELP_API_KEY: process.env.YELP_API_KEY || undefined,
    LIA_YELP_MODE: process.env.LIA_YELP_MODE || undefined,
    YELP_MAX_CHECKS_PER_SWEEP: process.env.YELP_MAX_CHECKS_PER_SWEEP || undefined,
    LIA_NEWS_MODE: process.env.LIA_NEWS_MODE || undefined,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || undefined,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || undefined,
    REDDIT_OAUTH_REDIRECT_URI: process.env.REDDIT_OAUTH_REDIRECT_URI || undefined,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT || undefined,
    LIA_REDDIT_MODE: process.env.LIA_REDDIT_MODE || undefined,
    REDDIT_ROLLOUT_STAGE: process.env.REDDIT_ROLLOUT_STAGE || undefined,
    REDDIT_ORG_ALLOWLIST: process.env.REDDIT_ORG_ALLOWLIST || undefined,
    REDDIT_ACCESS_APPROVAL_REF: process.env.REDDIT_ACCESS_APPROVAL_REF || undefined,
    REDDIT_AI_INFERENCE: process.env.REDDIT_AI_INFERENCE || undefined,
    CRON_SECRET: process.env.CRON_SECRET || undefined,
    RULES_EXECUTION_MODE: process.env.RULES_EXECUTION_MODE || undefined,
    RULES_EXECUTION_ORG_ALLOWLIST:
      process.env.RULES_EXECUTION_ORG_ALLOWLIST || undefined,
    RULES_MAX_MENTIONS_PER_SWEEP:
      process.env.RULES_MAX_MENTIONS_PER_SWEEP || undefined,
    RULES_MAX_ACTIONS_PER_SWEEP:
      process.env.RULES_MAX_ACTIONS_PER_SWEEP || undefined,
    RULES_MAX_RULES_PER_MENTION:
      process.env.RULES_MAX_RULES_PER_MENTION || undefined,
    RULES_EXECUTION_BUDGET_MS: process.env.RULES_EXECUTION_BUDGET_MS || undefined,
  });

  if (!parsed.success) {
    // Names and messages only. Never echo values — several of these are secrets.
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${fields}`);
  }

  return parsed.data;
}

export const env: Env = readEnv();

export function isSupabaseConfigured(): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export type DataSourceKind = "demo" | "supabase";

/**
 * Which adapter this process should use.
 *
 * An explicit `LIA_DATA_SOURCE` wins so tests and previews can pin a mode;
 * otherwise the presence of Supabase credentials decides.
 */
export function resolveDataSourceKind(): DataSourceKind {
  if (env.LIA_DATA_SOURCE) return env.LIA_DATA_SOURCE;
  return isSupabaseConfigured() ? "supabase" : "demo";
}

/**
 * True when demo data is being served because nothing else was configured,
 * rather than because someone asked for it.
 *
 * Throwing here would break `next build`, which prerenders with
 * NODE_ENV=production and no database. So instead of failing the build, the
 * shell renders a visible "Demo data" badge whenever this is true — the risk
 * worth guarding against is mistaking demo records for real ones, and a badge
 * addresses that without pretending the app is broken.
 */
export function isUnintentionalDemoMode(): boolean {
  return (
    resolveDataSourceKind() === "demo" &&
    env.LIA_DATA_SOURCE !== "demo" &&
    !isSupabaseConfigured()
  );
}

/* -------------------------------------------------------------------------- */
/* Google Business Profile                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raised when a server-side integration is used before it is configured.
 *
 * Separate from `DataError` on purpose: this is an operator problem, not a user
 * problem, and the UI has to say so rather than showing "try again shortly".
 */
export class ConfigurationError extends Error {
  /** Environment variable names — never values. Safe to log. */
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "ConfigurationError";
    this.missing = missing;
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The mode the Google connector should run in.
 *
 * Explicit configuration wins. Otherwise a fully configured OAuth client means
 * live, and anything else means unconfigured — the mock is never chosen for
 * you, so a developer cannot mistake fixture data for a working connection.
 */
export function resolveGoogleIntegrationMode(): GoogleIntegrationMode | "unconfigured" {
  if (env.GOOGLE_INTEGRATION_MODE === "mock") {
    // Belt and braces: the schema already refuses this combination, but this is
    // the branch that would serve fake data, so it re-checks rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "GOOGLE_INTEGRATION_MODE=mock cannot be used in production.",
        ["GOOGLE_INTEGRATION_MODE"],
      );
    }
    return "mock";
  }

  if (env.GOOGLE_INTEGRATION_MODE === "live") return "live";
  return isGoogleOAuthConfigured() ? "live" : "unconfigured";
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

/** The OAuth client, or a configuration error naming what is missing. */
export function requireGoogleOAuthConfig(): GoogleOAuthConfig {
  const missing = [
    !env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
    !env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
    !env.GOOGLE_OAUTH_REDIRECT_URI && "GOOGLE_OAUTH_REDIRECT_URI",
  ].filter((name): name is string => typeof name === "string");

  if (missing.length > 0 || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ConfigurationError(
      "Google Business Profile is not configured on this server.",
      missing,
    );
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
  };
}

/**
 * The credential encryption key.
 *
 * Required whenever a real OAuth flow runs. Mock mode still encrypts — the mock
 * connector produces fake tokens, and running the same storage path in
 * development is what catches a broken vault before production does — so a key
 * is needed there too. Tests supply their own.
 */
export function requireTokenEncryptionKey(): { raw: string; keyId: string } {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new ConfigurationError(
      "Credential encryption is not configured on this server.",
      ["TOKEN_ENCRYPTION_KEY"],
    );
  }

  return {
    raw: env.TOKEN_ENCRYPTION_KEY,
    keyId: env.TOKEN_ENCRYPTION_KEY_ID ?? "default",
  };
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

/** Default mentions per run. Overridable, so a large backlog can be drained. */
export const DEFAULT_ANALYSIS_BATCH_SIZE = 50;

export function analysisBatchSize(): number {
  return env.LIA_ANALYSIS_BATCH_SIZE ?? DEFAULT_ANALYSIS_BATCH_SIZE;
}

export function isAiConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Which analyser this process should use.
 *
 * Explicit configuration wins. Otherwise a key means live and anything else
 * means unconfigured — the mock is never chosen for you, so a developer cannot
 * mistake a fabricated risk assessment for a real one.
 */
export function resolveAiMode(): AiMode | "unconfigured" {
  if (env.LIA_AI_MODE === "mock") {
    // Belt and braces: the schema already refuses this combination, but this
    // is the branch that would serve fabricated risk levels, so it re-checks
    // rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "LIA_AI_MODE=mock cannot be used in production.",
        ["LIA_AI_MODE"],
      );
    }
    return "mock";
  }

  if (env.LIA_AI_MODE === "live") return "live";
  return isAiConfigured() ? "live" : "unconfigured";
}

/** The analysis API key, or a configuration error naming what is missing. */
export function requireAnthropicApiKey(): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ConfigurationError(
      "Mention analysis is not configured on this server.",
      ["ANTHROPIC_API_KEY"],
    );
  }

  return env.ANTHROPIC_API_KEY;
}

/* -------------------------------------------------------------------------- */
/* Outbound mail                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where a help request or a contact message goes when nothing else is
 * configured.
 *
 * A default rather than a required variable on purpose: the help form is the
 * one path in the app where failing closed would mean a person with a problem
 * has no way to report it.
 *
 * Delivery to this address needs a sender on a domain verified with Resend —
 * see `DEFAULT_SUPPORT_FROM`. Resend's shared identity only ever delivers to
 * the address that owns the Resend account, so an inbox on lia.bond and a
 * sender on `resend.dev` is a combination that silently reaches nobody.
 */
export const DEFAULT_SUPPORT_INBOX = "lauren@lia.bond";

/**
 * Resend's shared sending identity.
 *
 * Usable with no DNS setup at all, but it only delivers to the address that
 * owns the Resend account — so a CC to anyone else is dropped by Resend, not by
 * Lia. Set `SUPPORT_FROM_EMAIL` to an address on a verified domain to lift that.
 */
export const DEFAULT_SUPPORT_FROM = "Lia support <onboarding@resend.dev>";

export function isEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

/**
 * Which sender this process should use.
 *
 * Same posture as the Google and analysis modes: explicit configuration wins, a
 * key means live, and the no-delivery mode is never chosen for you — so nobody
 * mistakes a logged message for a sent one.
 */
export function resolveEmailMode(): EmailMode | "unconfigured" {
  if (env.LIA_EMAIL_MODE === "log") {
    // The schema already refuses this in production; this is the branch that
    // would silently swallow mail, so it re-checks rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "LIA_EMAIL_MODE=log cannot be used in production.",
        ["LIA_EMAIL_MODE"],
      );
    }
    return "log";
  }

  if (env.LIA_EMAIL_MODE === "live") return "live";
  return isEmailConfigured() ? "live" : "unconfigured";
}

/** The Resend key, or a configuration error naming what is missing. */
export function requireResendApiKey(): string {
  if (!env.RESEND_API_KEY) {
    throw new ConfigurationError("Email is not configured on this server.", [
      "RESEND_API_KEY",
    ]);
  }

  return env.RESEND_API_KEY;
}

/** The address help requests are delivered to. */
export function supportInboxAddress(): string {
  return env.SUPPORT_INBOX_EMAIL ?? DEFAULT_SUPPORT_INBOX;
}

/** The address help requests are sent from. */
export function supportFromAddress(): string {
  return env.SUPPORT_FROM_EMAIL ?? DEFAULT_SUPPORT_FROM;
}

/**
 * The address invitations are sent from, or null when none is configured.
 *
 * Null rather than a fallback to `supportFromAddress()`, and that is the whole
 * point of this helper. The support default is `onboarding@resend.dev`, which
 * Resend delivers only to the account owner — so falling back would mean every
 * invitation to an actual restaurant manager was accepted by the provider,
 * reported as sent, and delivered to nobody. D55 exists because a silently
 * undelivered invitation looks like a bug in Lia rather than a missing
 * environment variable.
 *
 * Callers treat null as "do not send", not as an error: the invitation is
 * still created and the inviter still gets the link to pass on by hand.
 */
export function inviteFromAddress(): string | null {
  return env.INVITE_FROM_EMAIL ?? null;
}

/**
 * Whether this deployment can actually put an invitation in someone's inbox.
 *
 * For screens that promise something *before* a send is attempted, so the
 * promise matches what will happen. Log mode counts as false: it delivers
 * nothing, and a screen that says "we'll email them" over a run that only
 * writes to stdout is exactly the false claim this is here to prevent.
 */
export function canEmailInvitations(): boolean {
  return inviteFromAddress() !== null && resolveEmailMode() === "live";
}

/**
 * Absolute origin for this deployment.
 *
 * Used to build the OAuth redirect URI when one is not pinned explicitly, and
 * to send users back into the app after the callback.
 */
export function appOrigin(): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, "");
  return "http://localhost:3000";
}

/* -------------------------------------------------------------------------- */
/* News monitoring                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which news monitor this process should use.
 *
 * `unconfigured` rather than a silent fallback, for the same reason as Google
 * and the analyser: a deployment quietly serving fabricated news articles is
 * worse than one that plainly says news is not set up.
 */
export function resolveNewsMode(): NewsMode | "unconfigured" {
  if (env.LIA_NEWS_MODE === "mock") {
    // Belt and braces: the schema already refuses this combination, but this
    // is the branch that would serve fabricated articles, so it re-checks
    // rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "LIA_NEWS_MODE=mock cannot be used in production.",
        ["LIA_NEWS_MODE"],
      );
    }
    return "mock";
  }

  if (env.LIA_NEWS_MODE === "live" && env.GNEWS_API_KEY) return "live";
  return "unconfigured";
}

/* -------------------------------------------------------------------------- */
/* Yelp Assisted                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which Yelp provider this process should use.
 *
 * The news rule rather than the Google one: a key alone does not imply live.
 * Google's mode can be inferred from a configured OAuth client because
 * possessing that client *is* the grant. A Yelp API key is not: the Places
 * plan a key belongs to decides which endpoints answer, and an operator can
 * hold a valid key whose plan does not cover business matching at all. Making
 * `live` an explicit statement means turning Yelp on is a decision somebody
 * took rather than a side effect of pasting in a credential.
 */
export function resolveYelpMode(): YelpMode | "unconfigured" {
  if (env.LIA_YELP_MODE === "mock") {
    // Belt and braces: the schema already refuses this combination, but this
    // is the branch that would serve fabricated review counts on a real
    // restaurant's listing, so it re-checks rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "LIA_YELP_MODE=mock cannot be used in production.",
        ["LIA_YELP_MODE"],
      );
    }
    return "mock";
  }

  if (env.LIA_YELP_MODE === "live" && env.YELP_API_KEY) return "live";
  return "unconfigured";
}

/**
 * The Yelp API key, or a configuration error naming what is missing.
 *
 * Read at call time rather than at module load, and returned rather than held,
 * so the only place a key exists in memory is inside the request that uses it.
 * `next build` prerenders with `NODE_ENV=production` and no secrets, so
 * requiring this at import would break the build for everybody.
 */
export function requireYelpApiKey(): string {
  if (!env.YELP_API_KEY) {
    throw new ConfigurationError("Yelp is not configured on this server.", [
      "YELP_API_KEY",
    ]);
  }

  return env.YELP_API_KEY;
}

/**
 * Listing checks one scheduled sweep may make.
 *
 * Conservative by default. Yelp's Places allowance is a daily figure against a
 * key shared by every tenant, and a sweep that spent it all in one pass would
 * leave the interactive path — somebody sitting in the connect flow waiting for
 * candidates — with nothing. The remaining headroom is deliberately not
 * modelled here: this bounds the *scheduled* half, and interactive searches are
 * what the leftover exists for.
 */
export const DEFAULT_YELP_MAX_CHECKS_PER_SWEEP = 50;

export function yelpMaxChecksPerSweep(): number {
  return env.YELP_MAX_CHECKS_PER_SWEEP ?? DEFAULT_YELP_MAX_CHECKS_PER_SWEEP;
}

/* -------------------------------------------------------------------------- */
/* Reddit monitoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which Reddit connector this process should use.
 *
 * The news rule rather than the Google one: `live` must be set explicitly
 * *and* the OAuth client must be complete. Credentials alone do not imply
 * live, because an operator can hold Reddit credentials for weeks while the
 * commercial agreement is still in review — the one integration here where
 * having the secret and being allowed to use it are separate events.
 */
export function resolveRedditMode(): RedditMode | "unconfigured" {
  if (env.LIA_REDDIT_MODE === "mock") {
    // Belt and braces: the schema already refuses this combination, but this
    // is the branch that would serve fabricated public discussion about a real
    // restaurant, so it re-checks rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "LIA_REDDIT_MODE=mock cannot be used in production.",
        ["LIA_REDDIT_MODE"],
      );
    }
    return "mock";
  }

  if (env.LIA_REDDIT_MODE === "live" && isRedditOAuthConfigured()) return "live";
  return "unconfigured";
}

export function isRedditOAuthConfigured(): boolean {
  return Boolean(
    env.REDDIT_CLIENT_ID &&
      env.REDDIT_CLIENT_SECRET &&
      env.REDDIT_OAUTH_REDIRECT_URI &&
      env.REDDIT_USER_AGENT,
  );
}

/**
 * Why a requested rollout stage was not granted.
 *
 * Named rather than boolean because the operator's next action is different
 * for each: paste a credential, generate an encryption key, or go and finish a
 * conversation with Reddit that may take weeks.
 */
export type RedditDeploymentBlocker =
  | "deployment_not_configured"
  | "credential_encryption_missing"
  | "approval_not_recorded";

export interface RedditDeployment {
  /** What the operator asked for. */
  readonly requestedStage: RedditRolloutStage;
  /** What this deployment may actually do, after every prerequisite is checked. */
  readonly effectiveStage: RedditRolloutStage;
  readonly mode: RedditMode | "unconfigured";
  /** Empty when `effectiveStage` equals `requestedStage`. */
  readonly blockers: readonly RedditDeploymentBlocker[];
  /** Whether the recorded terms permit running a model over Reddit content. */
  readonly aiInferencePermitted: boolean;
  /** The Gate 0 marker, or null in mock mode where none is required. */
  readonly approvalRef: string | null;
}

/**
 * What this deployment is permitted to do with Reddit.
 *
 * Resolved rather than thrown, and downgraded rather than refused, because
 * this has to be answerable during `next build` — which prerenders with
 * `NODE_ENV=production` and no secrets — and because the integrations screen
 * has to explain the gap. An operator whose approval marker is missing needs
 * to read that sentence, not a stack trace.
 *
 * An unmet prerequisite falls all the way to `off`, never part-way to
 * `read_only`. Reddit's agreement governs reading as much as posting, so
 * degrading an unapproved `read_write` deployment to `read_only` would keep
 * making the calls Reddit has not agreed to and stop only the ones it has.
 */
export function resolveRedditDeployment(): RedditDeployment {
  const requestedStage = env.REDDIT_ROLLOUT_STAGE ?? "off";
  const mode = resolveRedditMode();
  // Reported whatever the stage, because they are facts about the agreement
  // rather than about the rollout. Folding them into the `off` branch would
  // make an unconfigured deployment claim the contract forbids inference, when
  // what it actually knows is that nobody has turned Reddit on. Callers
  // intersect these with `effectiveStage`; that is the capability model's job,
  // not this function's.
  const contract = {
    aiInferencePermitted:
      mode === "mock" || env.REDDIT_AI_INFERENCE === "permitted",
    approvalRef: env.REDDIT_ACCESS_APPROVAL_REF ?? null,
  };

  // Somebody who has not asked for Reddit is not handed a list of things they
  // failed to configure.
  if (requestedStage === "off") {
    return { requestedStage, effectiveStage: "off", mode, blockers: [], ...contract };
  }

  const blockers: RedditDeploymentBlocker[] = [];
  if (mode === "unconfigured") blockers.push("deployment_not_configured");
  // Required in mock mode too: the mock seals its fake tokens through the same
  // vault, and running the real encryption path locally is what catches a
  // broken one before production does.
  if (!env.TOKEN_ENCRYPTION_KEY) blockers.push("credential_encryption_missing");
  // Not asked of the mock. Fabricated threads are not Reddit's data, and
  // requiring the marker here would lock out exactly the people the mock
  // exists for — everyone still waiting on approval.
  if (mode === "live" && !env.REDDIT_ACCESS_APPROVAL_REF) {
    blockers.push("approval_not_recorded");
  }

  return {
    requestedStage,
    effectiveStage: blockers.length > 0 ? "off" : requestedStage,
    mode,
    blockers,
    ...contract,
  };
}

/**
 * Organization ids permitted to use Reddit while this feature rolls out.
 *
 * Absent means empty — no organization is admitted by default, the same
 * fail-closed posture as `rulesExecutionAllowlist`.
 */
export function redditOrganizationAllowlist(): string[] {
  if (!env.REDDIT_ORG_ALLOWLIST) return [];
  return env.REDDIT_ORG_ALLOWLIST.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export interface RedditOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Reddit throttles on this, so it travels with the credential, not beside it. */
  userAgent: string;
}

/** The OAuth client, or a configuration error naming what is missing. */
export function requireRedditOAuthConfig(): RedditOAuthConfig {
  const missing = [
    !env.REDDIT_CLIENT_ID && "REDDIT_CLIENT_ID",
    !env.REDDIT_CLIENT_SECRET && "REDDIT_CLIENT_SECRET",
    !env.REDDIT_OAUTH_REDIRECT_URI && "REDDIT_OAUTH_REDIRECT_URI",
    !env.REDDIT_USER_AGENT && "REDDIT_USER_AGENT",
  ].filter((name): name is string => typeof name === "string");

  if (
    missing.length > 0 ||
    !env.REDDIT_CLIENT_ID ||
    !env.REDDIT_CLIENT_SECRET ||
    !env.REDDIT_OAUTH_REDIRECT_URI ||
    !env.REDDIT_USER_AGENT
  ) {
    throw new ConfigurationError(
      "Reddit is not configured on this server.",
      missing,
    );
  }

  return {
    clientId: env.REDDIT_CLIENT_ID,
    clientSecret: env.REDDIT_CLIENT_SECRET,
    redirectUri: env.REDDIT_OAUTH_REDIRECT_URI,
    userAgent: env.REDDIT_USER_AGENT,
  };
}

/* -------------------------------------------------------------------------- */
/* Rules execution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which mode the rules engine runs in.
 *
 * Execution changes what the product does to customer data without a person
 * in the loop; absence of configuration must mean absence of the behavior. So,
 * unlike the other modes in this file, there is no "unconfigured" state to
 * reason about: an unset `RULES_EXECUTION_MODE` simply means `off`, and any
 * value the schema would not accept has already stopped the process at
 * startup — this function never sees it.
 */
export function resolveRulesExecutionMode(): RulesExecutionMode {
  return env.RULES_EXECUTION_MODE ?? "off";
}

/**
 * Organization ids permitted to run rules execution while this feature rolls
 * out gradually.
 *
 * Comma-separated, trimmed, empty entries dropped. Absent means the allowlist
 * is empty — no organization is admitted by default, matching the same
 * fail-closed posture as the mode itself.
 */
export function rulesExecutionAllowlist(): string[] {
  if (!env.RULES_EXECUTION_ORG_ALLOWLIST) return [];
  return env.RULES_EXECUTION_ORG_ALLOWLIST.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export interface RulesExecutionLimits {
  maxMentionsPerSweep: number;
  maxActionsPerSweep: number;
  maxRulesPerMention: number;
  budgetMs: number;
}

/** Default cost bounds for one rules sweep. Each is independently overridable. */
export const DEFAULT_RULES_EXECUTION_LIMITS: RulesExecutionLimits = {
  maxMentionsPerSweep: 200,
  maxActionsPerSweep: 500,
  maxRulesPerMention: 50,
  budgetMs: 60_000,
};

/**
 * Cost bounds for one rules sweep: how many mentions and actions it may
 * touch, how many rules may evaluate against a single mention, and how long
 * it may run before stopping. Conservative defaults, each overridable on its
 * own so a deployment can tune one bound without touching the others.
 */
export function rulesExecutionLimits(): RulesExecutionLimits {
  return {
    maxMentionsPerSweep:
      env.RULES_MAX_MENTIONS_PER_SWEEP ??
      DEFAULT_RULES_EXECUTION_LIMITS.maxMentionsPerSweep,
    maxActionsPerSweep:
      env.RULES_MAX_ACTIONS_PER_SWEEP ??
      DEFAULT_RULES_EXECUTION_LIMITS.maxActionsPerSweep,
    maxRulesPerMention:
      env.RULES_MAX_RULES_PER_MENTION ??
      DEFAULT_RULES_EXECUTION_LIMITS.maxRulesPerMention,
    budgetMs: env.RULES_EXECUTION_BUDGET_MS ?? DEFAULT_RULES_EXECUTION_LIMITS.budgetMs,
  };
}
