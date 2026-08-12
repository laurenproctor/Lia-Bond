import { z } from "zod";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Response-generation attempt vocabulary.
 *
 * A generation attempt is the claim/lease a worker takes on a mention while
 * it produces a response draft — one row per attempt, whether it finishes,
 * fails, or times out. `claimToken` is deliberately absent from this entity:
 * it is never readable once issued, only ever returned once by the claim RPC
 * (Task 6), so it has no place in a schema meant to describe a readable row.
 */

export const GENERATION_ATTEMPT_STATUSES = ["pending", "completed", "failed"] as const;
export type GenerationAttemptStatus = (typeof GENERATION_ATTEMPT_STATUSES)[number];

export const GENERATION_FAILURE_CATEGORIES =
  ["provider_error", "invalid_output", "lease_expired"] as const;
export type GenerationFailureCategory = (typeof GENERATION_FAILURE_CATEGORIES)[number];

export const BRAND_VOICE_SOURCES = ["configured", "default"] as const;
export type BrandVoiceSource = (typeof BRAND_VOICE_SOURCES)[number];

export const generationAttemptSchema = z
  .object({
    mentionId: uuidSchema,
    status: z.enum(GENERATION_ATTEMPT_STATUSES),
    failureCategory: z.enum(GENERATION_FAILURE_CATEGORIES).nullable(),
    claimedByUserId: uuidSchema,
    claimedAt: timestampSchema,
    expiresAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
    responseDraftId: uuidSchema.nullable(),
    promptVersion: z.string(),
    brandVoiceSource: z.enum(BRAND_VOICE_SOURCES),
    brandVoiceVersion: z.string().nullable(),
    analysisIncluded: z.boolean(),
    dedupHits: z.number().int().min(0),
    modelProvider: z.string().nullable(),
    modelName: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    latencyMs: z.number().int().nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);
export type GenerationAttempt = z.infer<typeof generationAttemptSchema>;
