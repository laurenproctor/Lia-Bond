/**
 * The Lia domain vocabulary.
 *
 * Everything the application knows about its own nouns lives here: Zod schemas,
 * the types inferred from them, and the lifecycle enums. This layer performs no
 * I/O and imports nothing from `src/lib` — repositories, adapters, and UI all
 * depend on the domain, never the other way round.
 */

export * from "@/domain/enums";
export * from "@/domain/primitives";
export * from "@/domain/entities/organization";
export * from "@/domain/entities/location";
export * from "@/domain/entities/platform";
export * from "@/domain/entities/oauth-state";
export * from "@/domain/entities/invitation";
export * from "@/domain/entities/onboarding";
export * from "@/domain/entities/mention";
export * from "@/domain/entities/sync-run";
export * from "@/domain/entities/analysis-run";
export * from "@/domain/entities/response";
export * from "@/domain/entities/generation";
export * from "@/domain/entities/escalation";
export * from "@/domain/entities/automation";
export * from "@/domain/entities/automation-execution";
export * from "@/domain/entities/phrase-match";
export * from "@/domain/entities/brand-voice";
export * from "@/domain/entities/audit";
export * from "@/domain/entities/monitoring";
export * from "@/domain/entities/yelp";
export * from "@/domain/entities/reddit";
export * from "@/domain/entities/publication";
export * from "@/domain/entities/review-widget";
