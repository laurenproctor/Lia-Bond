import "server-only";

import type { GenerationFailureCategory } from "@/domain";
import {
  DRAFTING_OUTPUT_SCHEMA_VERSION,
  DRAFTING_PROMPT_VERSION,
  hashRendered,
  renderDraftingPrompt,
} from "@/ai/anthropic/drafting-prompt";
import { aiErrorCode } from "@/ai/errors";
import type { AiProvider } from "@/ai/provider";
import { notFound } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  buildDraftingContext,
  canonicalContextHash,
} from "@/lib/responses/drafting-context";
import { validateDraftText } from "@/lib/responses/validate-draft";

/**
 * Manual response generation.
 *
 * One mention in, one drafted reply out — or an honest account of why there
 * isn't one. Everything that has to happen in a particular order (freeze the
 * context, claim the mention, call the model, gate the output, commit the
 * draft) happens here once, so no action or future scheduler can reorder it.
 *
 * Three properties the rest of the product depends on:
 *
 * 1. **A second click costs nothing.** The claim is taken *before* the model
 *    call, so a duplicate request short-circuits on `in_progress` or
 *    `draft_exists` without spending a token. Dedupe is the database's answer,
 *    not a guess made from a stale read here.
 * 2. **No ungated text is ever stored.** `validateDraftText` runs between the
 *    provider and `complete`, and `complete` is the only writer of a draft —
 *    so a reply that trips the gate leaves a `failed` attempt and nothing else.
 * 3. **No provider text reaches a caller.** Failures collapse to a
 *    `GenerationFailureCategory`; the provider's own message is logged
 *    name-only (`aiErrorCode`) and never returned, because a model error can
 *    echo the prompt and the prompt carries the review and the reviewer's name.
 *
 * The wording a person eventually reads is the action layer's
 * (`generateResponseDraftAction`), not this module's — the same split analysis
 * uses.
 */

export type GenerateResult =
  | { kind: "generated"; responseDraftId: string }
  | { kind: "in_progress" }
  | { kind: "draft_exists"; responseDraftId: string }
  | { kind: "failed"; category: GenerationFailureCategory };

export interface GenerationContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

export async function generateResponseDraft(
  { dataSource, scope }: GenerationContext,
  mentionId: string,
  provider: AiProvider,
): Promise<GenerateResult> {
  const detail = await dataSource.mentions.getDetail(scope, mentionId);
  if (!detail) throw notFound("Mention");

  const membership = await dataSource.organizations.getById(
    scope.organizationId,
    scope.userId,
  );
  if (!membership) throw notFound("Organization");

  const voiceProfile = await dataSource.brandVoice.get(scope);

  const built = buildDraftingContext(
    detail.mention,
    detail.location,
    membership.organization,
    voiceProfile,
    detail.analysis,
  );

  // The claim carries the frozen context and its hash, so what the row records
  // is what the model was actually shown — not what a later read of the
  // mention would reconstruct.
  const claim = await dataSource.generationAttempts.claim(scope, {
    mentionId,
    context: built.context,
    contextHash: canonicalContextHash(built.context),
    promptVersion: DRAFTING_PROMPT_VERSION,
    brandVoiceSource: built.brandVoiceSource,
    brandVoiceVersion: built.brandVoiceVersion,
    analysisIncluded: built.analysisIncluded,
  });

  if (claim.outcome === "in_progress") return { kind: "in_progress" };
  if (claim.outcome === "draft_exists") {
    return { kind: "draft_exists", responseDraftId: claim.responseDraftId };
  }

  const rendered = renderDraftingPrompt(built.context);
  const startedAt = Date.now();

  let draft;
  try {
    draft = await provider.draftResponse(built.context);
  } catch (error) {
    // Name-only, per the cron redaction posture: the code, never the message.
    console.error(
      `[generation] provider call failed for attempt ${claim.attemptId}: ${aiErrorCode(error)}`,
    );
    return failAttempt(dataSource, scope, {
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      category: "provider_error",
      latencyMs: Date.now() - startedAt,
      providerRequestId: null,
    });
  }

  const validation = validateDraftText(draft.draftText);
  if (!validation.ok) {
    console.error(
      `[generation] draft refused by the output gate for attempt ${claim.attemptId}: ${validation.reason}`,
    );
    return failAttempt(dataSource, scope, {
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      category: "invalid_output",
      latencyMs: draft.latencyMs,
      providerRequestId: draft.providerRequestId,
    });
  }

  const completion = await dataSource.generationAttempts.complete(scope, {
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    // The gate's trimmed text, not the raw string: what passed is what is stored.
    draftText: validation.text,
    renderedSystemHash: hashRendered(rendered.system),
    renderedUserHash: hashRendered(rendered.user),
    outputSchemaVersion: DRAFTING_OUTPUT_SCHEMA_VERSION,
    modelProvider: draft.modelProvider,
    modelName: draft.modelName,
    maxOutputTokens: draft.maxOutputTokens,
    temperature: draft.temperature,
    providerRequestId: draft.providerRequestId,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    latencyMs: draft.latencyMs,
  });

  if (completion.outcome === "superseded") {
    // Our token no longer names the pending attempt: somebody else's claim
    // owns this mention now. `lease_expired` is the honest category — the
    // lease we held is gone — and there is no attempt of ours left to fail,
    // so nothing is written here.
    return { kind: "failed", category: "lease_expired" };
  }

  return { kind: "generated", responseDraftId: completion.responseDraftId };
}

/**
 * Record the failure on our own attempt and report it.
 *
 * `fail` answering `superseded` is not a different outcome for the caller:
 * either way this run produced no draft, and the category it was going to
 * record is still what went wrong.
 */
async function failAttempt(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  input: {
    attemptId: string;
    claimToken: string;
    category: GenerationFailureCategory;
    latencyMs: number;
    providerRequestId: string | null;
  },
): Promise<GenerateResult> {
  await dataSource.generationAttempts.fail(scope, {
    attemptId: input.attemptId,
    claimToken: input.claimToken,
    failureCategory: input.category,
    latencyMs: input.latencyMs,
    providerRequestId: input.providerRequestId,
  });

  return { kind: "failed", category: input.category };
}
