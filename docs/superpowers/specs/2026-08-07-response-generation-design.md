# Voice-aware response generation for Google reviews

Design document. Written 2026-08-07, before implementation.

## Summary

Lia can analyse a mention but cannot write a word of response — the AI
provider has one method, no code can create a draft, and the brand-voice
profile is persisted but read by nothing. This sub-project adds the second
model capability the provider's own comment promised ("Workflow 05 adds a
`draftResponse()` sibling when there is a real second caller"): a
human-triggered, voice-aware public-reply draft for a Google review, landing
in the existing draft → approve → (manual) publish pipeline.

Generation is manual and scoped to Google reviews (both user decisions):
one button, one model call, one draft. Automation belongs to the rules
engine (phase 6); other source types wait for real ingest (phase 5).

## What exists and is reused

- The provider boundary (`src/ai/provider.ts`) and its rules: no key ever
  logged, no provider text ever reaches a user, failures classified into
  `AiError`.
- The Anthropic client's shape: `messages.parse` with `zodOutputFormat`,
  prompt caching, typed error classification. The mock provider and the
  registry's mode resolution (`live`/`mock`/`unconfigured`).
- Prompt versioning discipline from `src/lib/analysis/prompt.ts` — versions
  stored on every row they produce.
- `ResponseDraft` already carries every provenance column generation needs:
  `generatedBy`, `generationProvider`, `generationModel`, `promptVersion`,
  `brandVoiceVersion` — all written null today.
- `BrandVoiceProfile` (axes + phrase lists + `version`) with a working
  repository read.
- The composer pipeline from sub-project 2: assign, edit, approve-with-text,
  audit. A generated draft drops straight into it.
- The audit vocabulary + check-constraint migration pattern and its mirror
  test.

## Decisions taken

| # | Decision | Reason |
| --- | --- | --- |
| D116 | Generation is manual: a "Generate draft" button, one model call per click | Approval-first posture and visible cost. The rules engine (phase 6) already reserves `auto_respond` for the automated version; front-running it here would hand automation to a screen instead of a policy. |
| D117 | Google reviews only; the draft is always a `public_reply` | The only source with live ingest and clear reply norms. Other types keep their vocabulary but get no generation until their ingest is real (phase 5). |
| D118 | `AiProvider` gains exactly `draftResponse()` — still not a general LLM abstraction | Same reasoning as D9/the provider's own comment: two named capabilities, no speculative extension points. |
| D119 | A versioned drafting prompt module (`DRAFTING_PROMPT_VERSION = "drafting@2026-08-07"`), separate from the analysis prompt | Different job, different audience (this one writes *to the customer*), different version lifecycle. The version lands in `response_drafts.promptVersion` so a later prompt is comparable to this one. |
| D120 | The brand-voice profile is finally consumed: axes and phrase lists shape the prompt, and `brandVoiceVersion` records `String(profile.version)` on the draft | This closes the loop the brand-voice screen has been writing into a void. Recording the version is what makes "which voice produced this text" answerable later. |
| D121 | `responseDrafts.create` refuses when the mention already has an undecided draft (`draft`/`awaiting_approval`), returning the existing one with a `created: boolean` flag | Same shape as `escalations.create`: two open drafts for one review is a queue nobody trusts, and a double-click must not produce it. Deciding a draft (reject → `draft` status) keeps it the open one — regenerate replaces nothing silently. |
| D122 | New permission `response.generate`: owner, admin, communications_lead | Mirrors `mention.analyze`'s reasoning verbatim: a generation spends money on a model, so it belongs to the roles accountable for the queue. Approvers decide text; they do not commission it. Analysts/viewers stay absent. |
| D123 | New audit event `response.generated`; metadata carries model, prompt version, brand-voice version, and token counts — never text | The vocabulary's standing rule. Requires the usual full-constraint migration; the mirror test enforces it. |
| D124 | A generated draft lands as status `draft`, `generatedBy: "ai"`, unassigned | `awaiting_approval` is a claim someone routed it for sign-off; a fresh generation has not been routed anywhere. The composer can decide from `draft` already. |
| D125 | The mock provider's `draftResponse` is deterministic from the mention id and rating | Same property as the mock analyser: stable outputs make tests and demo mode reproducible. |
| D126 | Generation reads the latest analysis when one exists and proceeds without it when none does | The analysis improves the draft (risk, topics, facts needing verification feed the guidance) but requiring it would chain two model calls behind one click. The prompt states what it knows either way. |

## The pieces

### Provider (`src/ai/provider.ts`, `src/ai/anthropic/client.ts`, `src/ai/mock-provider.ts`)

```ts
export interface DraftResponseInput {
  mention: Mention;
  location: Location | null;
  /** Latest analysis when one exists (D126). */
  analysis: MentionAnalysis | null;
  brandVoice: BrandVoiceProfile;
}

export interface DraftResponseResult {
  draftText: string;
  modelProvider: string;
  modelName: string;
  inputTokens: number | null;
  outputTokens: number | null;
}
```

`draftResponse(input: DraftResponseInput): Promise<DraftResponseResult>` on
the interface and both implementations. The provider doc comment's "workflow
05" sentence is updated to describe the two-method reality. The Anthropic
implementation mirrors `analyzeMention`: `messages.parse` with a
`zodOutputFormat` over `{ draftText: z.string().min(1).max(5000) }` (the
composer's save bound — a draft the composer cannot re-save would be a trap),
same error classification, no new retry policy.

### Drafting prompt (`src/lib/drafting/prompt.ts`)

Versioned module in the analysis prompt's mold. The system prompt: Lia
writing a public reply to a Google review on behalf of a named restaurant —
concise, specific to what the reviewer said, no offers or commitments the
team did not state, never confirming or denying facts the analysis flagged
as needing verification, no personal data. Brand voice renders as
instructions from the axes (each axis's position mapped to its documented
meaning) plus "use naturally"/"never use" phrase lists. The user message
carries the review (text, rating, author first name), the location name, and
the analysis summary when present.

### Data layer

`ResponseDraftRepository.create(scope, input)` on both adapters:

```ts
createResponseDraftInputSchema = z.object({
  mentionId: uuidSchema,
  responseType: responseTypeSchema,
  draftText: z.string().min(1).max(5000),
  generatedBy: generatedBySchema,
  generationProvider: z.string().max(80).nullable(),
  generationModel: z.string().max(120).nullable(),
  promptVersion: z.string().max(40).nullable(),
  brandVoiceVersion: z.string().max(40).nullable(),
});
```

Returns `{ draft: ResponseDraft; created: boolean }` per D121; refusal path
finds an existing undecided draft for the mention and returns it with
`created: false`. Status is always `draft` (D124) — status is not an input.

### Migration

`supabase/migrations/<next timestamp>_response_generated_audit_event.sql` —
full-constraint redefinition adding `response.generated`, mirror-test
enforced. `response.generated` also joins `AUDIT_EVENT_TYPES` and
`AUDIT_EVENT_LABELS`.

### Service + action

`src/lib/drafting/generate.ts` — the orchestration, testable with a
substituted provider: load mention (must be `google_review`, else
`invalid_input`), location, latest analysis, brand-voice profile; call the
provider; `responseDrafts.create`; when `created`, record `response.generated`
(metadata: model, versions, token counts). Returns the repository's
`{ draft, created }`.

`generateResponseDraftAction(input: unknown)` in
`src/app/actions/responses.ts`: parse `{ mentionId }` → `authorize("response.generate")`
→ `isAiAvailable()` guard (the mentions page's analysis panel pattern) →
service → revalidate `/responses`, `/mentions`, and the two workspace routes
(the sub-project-2 set). `created: false` returns the existing draft with
`ok: true` — idempotent double-click, nothing to apologise for.

### UI

One new client component, `GenerateDraftButton` (mirrors the analysis
panel's trigger pattern: pending spinner, error line, permission-aware).
Rendered in the Google review workspace where the "No draft yet"
`EmptyState` sits today — the empty state's copy changes from "Response
generation arrives with the AI workflow" to an honest description plus the
button when the viewer holds `response.generate` and AI is configured;
otherwise the empty state explains what is missing (role or configuration),
in sentence case, without pretending the button exists.

The mentions pane's "Responses" section and the responses table pick the new
draft up with no changes (they already list drafts).

## Error handling

- AI unconfigured: the action refuses before any read, with the same
  wording pattern the analysis panel uses.
- `AiError` from the provider: classified message via the existing
  `toUserMessage` path; nothing provider-authored reaches the screen.
- Mention not a Google review: `invalid_input` — the button only renders on
  the review workspace, so this is a defense, not a UX path.
- Concurrent generation for one mention: the repository's undecided-draft
  check makes the second call return the first draft (`created: false`).

## Testing

Node vitest throughout:

- Prompt module: brand-voice axes and phrases render into the system prompt;
  verification facts from the analysis appear as do-not-confirm guidance;
  version constant format.
- Mock provider: deterministic output, shape-valid.
- Repository `create`: creates with provenance columns; refuses a second
  undecided draft (`created: false`, same id back); allows a new draft once
  the prior one is decided… (approved drafts stay; rejected drafts return to
  `draft` and therefore remain the open one).
- Service with a stub provider: happy path writes draft + audit (metadata
  counts/versions only, never text — the sub-project-2 assertion style);
  non-review mention refused; `created: false` records no audit event.
- Action: authorizes `response.generate`; unconfigured AI refused.

## Out of scope

Auto-generation and rules (phase 6), publishing (still disabled), quality /
policy checks and draft versioning (phase 4's remaining items — the
provenance columns `policyVersion` stay null), Reddit/news/comment drafting
(phase 5), approval-request routing changes, prompt-tuning UI.
