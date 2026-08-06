# Brand voice configuration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/brand-voice` from a read-only fixture into editable, persisted, permission-gated, audited configuration.

**Architecture:** A `brand_voice_profiles` table (one row per organization) behind the existing repository interface, implemented on both the demo and Supabase adapters. A server action guarded by a new `brand_voice.update` permission writes it and records an audit event. The screen stays a server component and delegates editing to one client form. Nothing generates text — there is no consumer yet.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict + `noUncheckedIndexedAccess`, zod 4, Tailwind 4, Supabase/PostgreSQL, vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-04-brand-voice-design.md`

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **Sentence case throughout the interface.** "Save changes", not "Save Changes".
- **Server components by default.** Client components only where interactivity requires them.
- **No `any`** unless justified in a comment.
- **No page component over roughly 300 lines.**
- **TypeScript strict mode** with `noUncheckedIndexedAccess` — indexing an array yields `T | undefined` and must be narrowed.
- **Visual direction:** purple primary accent (`purple-600`), green success, amber warning, red risk, thin borders, restrained shadows, rounded cards. Dark navy is the sidebar only.
- **Accessible labels and keyboard states** on every control.
- **Never imply a platform capability that does not exist.** Nothing in this feature may suggest Lia can publish or generate text.
- Every organization-owned repository method takes an `OrganizationScope`. There is no unscoped read.
- Writes pass through `authorize()` then `recordAuditEvent()`.
- `supabase/seed.sql` is **generated**, never hand-edited. Regenerate with `npm run db:seed:generate`.

**Verification commands** (used throughout):

```bash
npm run test        # vitest run
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run db:validate # parses every migration with libpg-query
npm run verify      # lint + typecheck + test + build
```

## File Structure

| Path | Status | Responsibility |
| --- | --- | --- |
| `src/domain/entities/brand-voice.ts` | create | Schemas, axis taxonomy, defaults. No I/O. |
| `src/domain/enums.ts` | modify | Add `brand_voice` entity type, `brand_voice.updated` event type. |
| `src/domain/index.ts` | modify | Re-export the new entity module. |
| `src/lib/brand-voice/summary.ts` | create | Pure axis-values → plain-language lines. |
| `src/lib/auth/permissions.ts` | modify | Add `brand_voice.update`. |
| `supabase/migrations/20260806000100_brand_voice.sql` | create | Table, helper function, audit enum and constraint changes. |
| `supabase/migrations/20260806000200_brand_voice_rls.sql` | create | Row-level security. |
| `src/lib/seed/dataset.ts` | modify | One seeded profile for the demo org. |
| `scripts/generate-seed-sql.ts` | modify | Emit the new table. |
| `src/lib/data/types.ts` | modify | `BrandVoiceRepository`, wired into `LiaDataSource`. |
| `src/lib/data/demo/index.ts` | modify | Demo implementation. |
| `src/lib/data/supabase/mappers.ts` | modify | `toBrandVoiceProfile`. |
| `src/lib/data/supabase/index.ts` | modify | Supabase implementation. |
| `src/lib/brand-voice/save.ts` | create | `saveBrandVoice` service: persist plus audit. The tested unit. |
| `src/app/actions/brand-voice.ts` | create | `updateBrandVoiceAction`: authorize, call the service, revalidate. |
| `src/components/brand-voice/axis-slider.tsx` | create | One labelled range input. |
| `src/components/brand-voice/phrase-editor.tsx` | create | Add/remove chips. Used twice. |
| `src/components/brand-voice/voice-summary.tsx` | create | Derived lines, live. |
| `src/components/brand-voice/voice-form.tsx` | create | Owns editable state and submission. |
| `src/components/brand-voice/channel-scope.tsx` | create | Read-only connected platforms. |
| `src/app/(app)/brand-voice/page.tsx` | rewrite | Server component; reads and composes. |
| `src/lib/fixtures/brand-voice.ts` | **delete** | Superseded. Deleted in Task 9, when nothing imports it. |
| `docs/architecture/current-state.md` | modify | Route table, gaps, decisions D60–D69. |

**Ordering constraint:** the fixture is deleted only in Task 9. Deleting it earlier breaks the build, because the current page imports it.

---

### Task 1: Domain schemas and audit vocabulary

**Files:**
- Create: `src/domain/entities/brand-voice.ts`
- Modify: `src/domain/enums.ts`
- Modify: `src/domain/index.ts`
- Test: `tests/brand-voice-domain.test.ts`

**Interfaces:**
- Consumes: `organizationOwnedSchema`, `timestampSchema`, `uuidSchema` from `@/domain/primitives`.
- Produces:
  - `BRAND_VOICE_AXIS_KEYS: readonly ["warmth","detail","formality","confidence","hospitality"]`
  - `BrandVoiceAxisKey`, `BrandVoiceAxes`, `BrandVoiceProfile`, `UpdateBrandVoiceInput`
  - `BRAND_VOICE_AXES: readonly BrandVoiceAxis[]` where `BrandVoiceAxis = { key, leftLabel, rightLabel, bands: readonly [string,string,string] }`
  - `brandVoiceProfileSchema`, `updateBrandVoiceInputSchema`, `brandVoiceAxesSchema`
  - `DEFAULT_BRAND_VOICE: UpdateBrandVoiceInput`
  - `MAX_PHRASES = 20`, `MAX_PHRASE_LENGTH = 80`
  - Enum additions: `"brand_voice"` in `AUDIT_ENTITY_TYPES`, `"brand_voice.updated"` in `AUDIT_EVENT_TYPES`

- [ ] **Step 1: Write the failing test**

Create `tests/brand-voice-domain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BRAND_VOICE_AXES,
  BRAND_VOICE_AXIS_KEYS,
  DEFAULT_BRAND_VOICE,
  updateBrandVoiceInputSchema,
} from "@/domain";

/**
 * Brand voice input validation.
 *
 * The contradiction rule is the one that matters: a phrase in both lists
 * reaches generation as an instruction that cannot be satisfied.
 */

const valid = {
  name: "Maison Laurent voice",
  axes: { warmth: 45, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
  approvedPhrases: ["thank you for sharing"],
  prohibitedPhrases: ["not our fault"],
};

describe("axis taxonomy", () => {
  it("declares one axis per key, in the same order", () => {
    expect(BRAND_VOICE_AXES.map((axis) => axis.key)).toEqual([...BRAND_VOICE_AXIS_KEYS]);
  });

  it("gives every axis three bands and two pole labels", () => {
    for (const axis of BRAND_VOICE_AXES) {
      expect(axis.bands).toHaveLength(3);
      expect(axis.leftLabel.length).toBeGreaterThan(0);
      expect(axis.rightLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("axis values", () => {
  it("accepts the boundaries", () => {
    for (const value of [0, 100]) {
      const axes = { warmth: value, detail: value, formality: value, confidence: value, hospitality: value };
      expect(updateBrandVoiceInputSchema.parse({ ...valid, axes }).axes.warmth).toBe(value);
    }
  });

  it("rejects a value outside 0 to 100", () => {
    const axes = { ...valid.axes, warmth: 101 };
    expect(() => updateBrandVoiceInputSchema.parse({ ...valid, axes })).toThrow();
  });

  it("rejects a fractional value", () => {
    const axes = { ...valid.axes, warmth: 44.5 };
    expect(() => updateBrandVoiceInputSchema.parse({ ...valid, axes })).toThrow();
  });
});

describe("phrase lists", () => {
  it("trims and drops blank entries", () => {
    const parsed = updateBrandVoiceInputSchema.parse({
      ...valid,
      approvedPhrases: ["  we're here to help  ", "   ", ""],
    });
    expect(parsed.approvedPhrases).toEqual(["we're here to help"]);
  });

  it("removes duplicates case-insensitively, keeping the first spelling", () => {
    const parsed = updateBrandVoiceInputSchema.parse({
      ...valid,
      approvedPhrases: ["Thank you", "thank YOU", "thank you "],
    });
    expect(parsed.approvedPhrases).toEqual(["Thank you"]);
  });

  it("rejects a phrase over 80 characters", () => {
    expect(() =>
      updateBrandVoiceInputSchema.parse({ ...valid, approvedPhrases: ["x".repeat(81)] }),
    ).toThrow();
  });

  it("rejects more than 20 phrases in a list", () => {
    const many = Array.from({ length: 21 }, (_, index) => `phrase ${index}`);
    expect(() =>
      updateBrandVoiceInputSchema.parse({ ...valid, approvedPhrases: many }),
    ).toThrow();
  });

  it("rejects a phrase present in both lists", () => {
    expect(() =>
      updateBrandVoiceInputSchema.parse({
        ...valid,
        approvedPhrases: ["We appreciate the feedback"],
        prohibitedPhrases: ["we appreciate the feedback"],
      }),
    ).toThrow(/both/i);
  });

  it("allows both lists to be empty", () => {
    const parsed = updateBrandVoiceInputSchema.parse({
      ...valid,
      approvedPhrases: [],
      prohibitedPhrases: [],
    });
    expect(parsed.approvedPhrases).toEqual([]);
    expect(parsed.prohibitedPhrases).toEqual([]);
  });
});

describe("defaults", () => {
  it("are themselves valid input", () => {
    expect(() => updateBrandVoiceInputSchema.parse(DEFAULT_BRAND_VOICE)).not.toThrow();
  });

  it("start with no phrases, so nothing is asserted on a new organization's behalf", () => {
    expect(DEFAULT_BRAND_VOICE.approvedPhrases).toEqual([]);
    expect(DEFAULT_BRAND_VOICE.prohibitedPhrases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/brand-voice-domain.test.ts`
Expected: FAIL — `BRAND_VOICE_AXES` is not exported from `@/domain`.

- [ ] **Step 3: Create the domain module**

Create `src/domain/entities/brand-voice.ts`:

```ts
import { z } from "zod";
import {
  organizationOwnedSchema,
  timestampSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Brand voice: how Lia is configured to sound.
 *
 * One profile per organization. Nothing reads it to generate text yet —
 * response drafting is a later workflow — so this module's job is to settle the
 * shape and refuse input that could not be acted on later.
 */

export const MAX_PHRASES = 20;
export const MAX_PHRASE_LENGTH = 80;

export const BRAND_VOICE_AXIS_KEYS = [
  "warmth",
  "detail",
  "formality",
  "confidence",
  "hospitality",
] as const;

export type BrandVoiceAxisKey = (typeof BRAND_VOICE_AXIS_KEYS)[number];

export interface BrandVoiceAxis {
  key: BrandVoiceAxisKey;
  /** The 0 pole. */
  leftLabel: string;
  /** The 100 pole. */
  rightLabel: string;
  /**
   * Plain-language descriptions of the low, middle, and high thirds.
   *
   * Held here rather than in the summary module so that adding an axis cannot
   * leave the summary silently describing four of five settings.
   */
  bands: readonly [string, string, string];
}

/**
 * The taxonomy.
 *
 * The single declaration of the axes. The form, the summary, and any future
 * prompt all read this, so a change lands in one place.
 */
export const BRAND_VOICE_AXES: readonly BrandVoiceAxis[] = [
  {
    key: "warmth",
    leftLabel: "Warm",
    rightLabel: "Formal",
    bands: ["Warm and personal", "Warm but composed", "Formal and reserved"],
  },
  {
    key: "detail",
    leftLabel: "Concise",
    rightLabel: "Detailed",
    bands: ["Brief and to the point", "Brief but thoughtful", "Thorough and specific"],
  },
  {
    key: "formality",
    leftLabel: "Casual",
    rightLabel: "Professional",
    bands: ["Casual and conversational", "Relaxed but polished", "Professional throughout"],
  },
  {
    key: "confidence",
    leftLabel: "Apologetic",
    rightLabel: "Confident",
    bands: ["Leads with an apology", "Acknowledges without over-apologising", "Confident and direct"],
  },
  {
    key: "hospitality",
    leftLabel: "Hospitality-forward",
    rightLabel: "Neutral",
    bands: [
      "Ends with an invitation back",
      "Offers a helpful next step",
      "Neutral, with no invitation",
    ],
  },
] as const;

const axisValueSchema = z
  .number()
  .int("Use a whole number.")
  .min(0, "Must be between 0 and 100.")
  .max(100, "Must be between 0 and 100.");

export const brandVoiceAxesSchema = z.object({
  warmth: axisValueSchema,
  detail: axisValueSchema,
  formality: axisValueSchema,
  confidence: axisValueSchema,
  hospitality: axisValueSchema,
});

export type BrandVoiceAxes = z.infer<typeof brandVoiceAxesSchema>;

/**
 * Keep the first spelling of each phrase, comparing case-insensitively.
 *
 * "Thank you" and "thank you" are the same instruction. Storing both would put
 * a meaningless distinction in front of whoever reads the list later.
 */
function dedupePhrases(phrases: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const phrase of phrases) {
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(phrase);
  }

  return kept;
}

/**
 * A phrase list, normalised on the way in.
 *
 * Trim and drop blanks first, so a row of empty inputs is not a validation
 * error a person has to hunt for. Length limits apply to what survives.
 */
export const phraseListSchema = z
  .array(z.string())
  .transform((raw) => raw.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0))
  .pipe(
    z
      .array(z.string().max(MAX_PHRASE_LENGTH, `Keep each phrase under ${MAX_PHRASE_LENGTH} characters.`))
      .max(MAX_PHRASES, `Up to ${MAX_PHRASES} phrases.`),
  )
  .transform(dedupePhrases);

export const updateBrandVoiceInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give this voice a name.").max(80),
    axes: brandVoiceAxesSchema,
    approvedPhrases: phraseListSchema,
    prohibitedPhrases: phraseListSchema,
  })
  .superRefine((value, ctx) => {
    // A phrase Lia must use and must never use is not a preference, it is a
    // contradiction. Cheaper to refuse here than to invent a precedence rule
    // nobody will remember when generation finally reads these lists.
    const approved = new Set(value.approvedPhrases.map((phrase) => phrase.toLowerCase()));
    const collisions = value.prohibitedPhrases.filter((phrase) =>
      approved.has(phrase.toLowerCase()),
    );

    if (collisions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["prohibitedPhrases"],
        message: `Listed in both use and avoid: ${collisions.join(", ")}. Remove it from one.`,
      });
    }
  });

export type UpdateBrandVoiceInput = z.infer<typeof updateBrandVoiceInputSchema>;

export const brandVoiceProfileSchema = z
  .object({
    name: z.string().min(1),
    axes: brandVoiceAxesSchema,
    approvedPhrases: z.array(z.string()),
    prohibitedPhrases: z.array(z.string()),
    /**
     * Incremented on every save that changes something.
     *
     * `response_drafts.brand_voice_version` records which voice produced a
     * draft, so a no-op save must not bump this — see the repository.
     */
    version: z.number().int().positive(),
    updatedByUserId: uuidSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape);

export type BrandVoiceProfile = z.infer<typeof brandVoiceProfileSchema>;

/**
 * The starting point for an organization with no row.
 *
 * There is no backfill migration and `provision_organization` does not create
 * one, so absence is normal and means "never configured". The axis values match
 * the column defaults in `20260806000100_brand_voice.sql`; the phrase lists are
 * empty because a default phrase would put words in a customer's mouth.
 */
export const DEFAULT_BRAND_VOICE: UpdateBrandVoiceInput = {
  name: "Brand voice",
  axes: { warmth: 45, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
  approvedPhrases: [],
  prohibitedPhrases: [],
};
```

- [ ] **Step 4: Add the audit vocabulary**

In `src/domain/enums.ts`, add `"brand_voice"` to the end of `AUDIT_ENTITY_TYPES`:

```ts
export const AUDIT_ENTITY_TYPES = [
  "organization",
  "membership",
  "location",
  "platform_connection",
  "platform_profile",
  "mention",
  "mention_analysis",
  "response_draft",
  "approval",
  "escalation",
  "automation_rule",
  "brand_voice",
] as const;
```

In the same file, add `"brand_voice.updated"` to the end of `AUDIT_EVENT_TYPES` (after the integration block):

```ts
  "integration.disconnected",
  "brand_voice.updated",
] as const;
```

- [ ] **Step 5: Export the module**

In `src/domain/index.ts`, add the re-export beside the others, keeping the existing ordering style:

```ts
export * from "@/domain/entities/automation";
export * from "@/domain/entities/brand-voice";
export * from "@/domain/entities/audit";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/brand-voice-domain.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/domain/entities/brand-voice.ts src/domain/enums.ts src/domain/index.ts tests/brand-voice-domain.test.ts
git commit -m "Add brand voice domain schemas and audit vocabulary"
```

---

### Task 2: Voice summary derivation

**Files:**
- Create: `src/lib/brand-voice/summary.ts`
- Test: `tests/brand-voice-summary.test.ts`

**Interfaces:**
- Consumes: `BRAND_VOICE_AXES`, `BrandVoiceAxes` from `@/domain` (Task 1).
- Produces: `summarizeBrandVoice(axes: BrandVoiceAxes): string[]` — one line per axis, in `BRAND_VOICE_AXES` order.

- [ ] **Step 1: Write the failing test**

Create `tests/brand-voice-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BRAND_VOICE_AXES, type BrandVoiceAxes } from "@/domain";
import { summarizeBrandVoice } from "@/lib/brand-voice/summary";

/**
 * The summary is derived rather than stored so it cannot disagree with the
 * sliders. These tests pin the band boundaries, which are the only place that
 * derivation can go subtly wrong.
 */

function axesAt(value: number): BrandVoiceAxes {
  return {
    warmth: value,
    detail: value,
    formality: value,
    confidence: value,
    hospitality: value,
  };
}

describe("summarizeBrandVoice", () => {
  it("returns one line per axis, in taxonomy order", () => {
    const lines = summarizeBrandVoice(axesAt(50));
    expect(lines).toHaveLength(BRAND_VOICE_AXES.length);
  });

  it("uses the low band at and below 33", () => {
    expect(summarizeBrandVoice(axesAt(0))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[0]);
    expect(summarizeBrandVoice(axesAt(33))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[0]);
  });

  it("uses the middle band from 34 to 66", () => {
    expect(summarizeBrandVoice(axesAt(34))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[1]);
    expect(summarizeBrandVoice(axesAt(66))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[1]);
  });

  it("uses the high band from 67 up", () => {
    expect(summarizeBrandVoice(axesAt(67))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[2]);
    expect(summarizeBrandVoice(axesAt(100))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[2]);
  });

  it("describes each axis independently", () => {
    const mixed: BrandVoiceAxes = {
      warmth: 0,
      detail: 100,
      formality: 50,
      confidence: 0,
      hospitality: 100,
    };
    const lines = summarizeBrandVoice(mixed);

    expect(lines[0]).toBe(BRAND_VOICE_AXES[0]?.bands[0]);
    expect(lines[1]).toBe(BRAND_VOICE_AXES[1]?.bands[2]);
    expect(lines[2]).toBe(BRAND_VOICE_AXES[2]?.bands[1]);
  });

  it("produces no empty lines for any value in range", () => {
    for (let value = 0; value <= 100; value += 1) {
      for (const line of summarizeBrandVoice(axesAt(value))) {
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/brand-voice-summary.test.ts`
Expected: FAIL — cannot resolve `@/lib/brand-voice/summary`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/brand-voice/summary.ts`:

```ts
import { BRAND_VOICE_AXES, type BrandVoiceAxes } from "@/domain";

/**
 * The voice, in plain language.
 *
 * Derived on every render rather than stored. The card exists so that somebody
 * who does not want to read five sliders can check the configuration, which a
 * stored summary would defeat the moment it drifted.
 *
 * Pure: no I/O, no framework imports.
 */

/** Band boundaries. Values at or below each threshold take that band. */
const LOW_MAX = 33;
const MIDDLE_MAX = 66;

function bandIndex(value: number): 0 | 1 | 2 {
  if (value <= LOW_MAX) return 0;
  if (value <= MIDDLE_MAX) return 1;
  return 2;
}

export function summarizeBrandVoice(axes: BrandVoiceAxes): string[] {
  return BRAND_VOICE_AXES.map((axis) => axis.bands[bandIndex(axes[axis.key])]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/brand-voice-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/brand-voice/summary.ts tests/brand-voice-summary.test.ts
git commit -m "Derive the brand voice summary from axis values"
```

---

### Task 3: The `brand_voice.update` permission

**Files:**
- Modify: `src/lib/auth/permissions.ts`
- Test: `tests/permissions.test.ts`

**Interfaces:**
- Produces: `"brand_voice.update"` as a member of `Permission`, held by `owner`, `admin`, `communications_lead`.

- [ ] **Step 1: Write the failing test**

Append to `tests/permissions.test.ts`:

```ts
describe("brand voice", () => {
  it("is held by owners, admins, and the communications lead", () => {
    expect(can("owner", "brand_voice.update")).toBe(true);
    expect(can("admin", "brand_voice.update")).toBe(true);
    expect(can("communications_lead", "brand_voice.update")).toBe(true);
  });

  it("is not held by approvers or location managers", () => {
    // Approving one response is a different job from setting the policy for
    // every response. A location manager's authority is scoped to their own
    // restaurants, and the voice is organization-wide.
    expect(can("approver", "brand_voice.update")).toBe(false);
    expect(can("location_manager", "brand_voice.update")).toBe(false);
  });

  it("is not held by analysts or viewers", () => {
    expect(can("analyst", "brand_voice.update")).toBe(false);
    expect(can("viewer", "brand_voice.update")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/permissions.test.ts`
Expected: FAIL — a type error on `"brand_voice.update"`, which is not a `Permission`.

- [ ] **Step 3: Add the permission**

In `src/lib/auth/permissions.ts`, add to the `PERMISSIONS` array after `"automation_rule.toggle"`:

```ts
  "automation_rule.toggle",
  "brand_voice.update",
```

And to `PERMISSION_MATRIX`, immediately after the `automation_rule.toggle` entry:

```ts
  // Brand voice sets how every generated response sounds, so it belongs with
  // automation rather than with administration: both change what the product
  // says without a person in the loop. The communications lead is the role
  // accountable for response policy — locking them out would mean filing a
  // ticket to change the tone of their own team's writing.
  //
  // Approvers are absent deliberately. Deciding one response and setting the
  // policy for all of them are different jobs, and conflating them was the
  // reason this permission is new rather than a reuse of `response.decide`.
  "brand_voice.update": ["owner", "admin", "communications_lead"],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/permissions.test.ts`
Expected: PASS. The existing "owners and admins hold every permission" and "analysts and viewers are read-only" tests must still pass — they iterate `PERMISSIONS`, so they cover the new entry automatically.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/permissions.ts tests/permissions.test.ts
git commit -m "Add the brand_voice.update permission"
```

---

### Task 4: Migrations

**Files:**
- Create: `supabase/migrations/20260806000100_brand_voice.sql`
- Create: `supabase/migrations/20260806000200_brand_voice_rls.sql`

**Interfaces:**
- Produces: table `public.brand_voice_profiles`, function `public.brand_voice_phrases_valid(text[])`, `brand_voice` added to the `audit_entity_type` enum, `brand_voice.updated` added to the `audit_events_known_event_type` check.

**Note on ordering:** `alter type ... add value` is committed before any row uses the new value, which is required — a value added in a transaction cannot be used in that same transaction.

- [ ] **Step 1: Write the schema migration**

Create `supabase/migrations/20260806000100_brand_voice.sql`:

```sql
-- Brand voice configuration.
--
-- Supersedes the typed fixture at src/lib/fixtures/brand-voice.ts. Decision
-- D34 deferred this table on the grounds that it would ship schema nothing
-- queries; that held until the screen's controls became the problem. Nothing
-- generates text from these settings yet.

-- ---------------------------------------------------------------------------
-- Phrase list validation
-- ---------------------------------------------------------------------------
--
-- A check constraint may not contain a subquery, so the per-item length test
-- lives here. Postgres does not re-validate existing rows when this function
-- changes, so tightening the limits later needs an explicit
-- `alter table ... validate constraint` rather than an edit in place.

create function public.brand_voice_phrases_valid(phrases text[])
  returns boolean
  language sql
  immutable
  parallel safe
as $$
  select cardinality(phrases) <= 20
     and not exists (
       select 1 from unnest(phrases) as p
       where length(p) < 1 or length(p) > 80
     );
$$;

comment on function public.brand_voice_phrases_valid is
  'Bounds a brand voice phrase list: at most 20 entries, each 1 to 80 characters.';

-- ---------------------------------------------------------------------------
-- brand_voice_profiles
-- ---------------------------------------------------------------------------

create table public.brand_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  -- One profile per organization. A second row is a constraint violation
  -- rather than a silent question about which one wins.
  organization_id uuid not null unique
    references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),

  -- Named columns rather than jsonb: the axes are a fixed taxonomy, not user
  -- data, so the range is enforceable here. Adding a sixth axis is a migration,
  -- which is correct — it also changes the summary and any future prompt.
  --
  -- No defaults, deliberately. Both adapters always write all five, so a
  -- default would never be exercised — it would only be a second declaration
  -- of the starting values, free to drift from DEFAULT_BRAND_VOICE in
  -- src/domain/entities/brand-voice.ts, which is the one that decides them.
  axis_warmth smallint not null check (axis_warmth between 0 and 100),
  axis_detail smallint not null check (axis_detail between 0 and 100),
  axis_formality smallint not null check (axis_formality between 0 and 100),
  axis_confidence smallint not null check (axis_confidence between 0 and 100),
  axis_hospitality smallint not null check (axis_hospitality between 0 and 100),

  approved_phrases text[] not null default '{}'
    check (public.brand_voice_phrases_valid(approved_phrases)),
  prohibited_phrases text[] not null default '{}'
    check (public.brand_voice_phrases_valid(prohibited_phrases)),

  -- response_drafts.brand_voice_version records which voice produced a draft.
  -- Incremented only when a save actually changes something: bumping on a
  -- no-op would invalidate the provenance of every existing draft because
  -- somebody pressed Save twice.
  version integer not null default 1 check (version > 0),

  updated_by_user_id uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.brand_voice_profiles is
  'How Lia is configured to sound. One row per organization. No generator reads it yet.';

comment on column public.brand_voice_profiles.version is
  'Bumped only on a change. Stamped onto response_drafts.brand_voice_version by a later workflow.';

create trigger brand_voice_profiles_set_updated_at
  before update on public.brand_voice_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit vocabulary
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value 'brand_voice';

-- The event-type check is a closed list, mirroring AUDIT_EVENT_TYPES in
-- src/domain/enums.ts. Recreated rather than extended: a check constraint
-- cannot be added to.
alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      'location.manager_changed',
      'integration.oauth_started',
      'integration.oauth_completed',
      'integration.connected',
      'integration.reauthorization_started',
      'integration.reauthorized',
      'integration.health_checked',
      'integration.health_degraded',
      'integration.profile_connected',
      'integration.profile_mapped',
      'location.created_from_integration',
      'integration.disconnected',
      'brand_voice.updated'
    )
  );
```

**Before running this step**, open `supabase/migrations/20260801000100_initial_schema.sql` and read the full `audit_events_known_event_type` constraint (starting near line 594). Copy **every** value it lists into the recreated constraint above, then add `'brand_voice.updated'`. The list above is transcribed from `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`; if the two ever differed, the migration file is the authority. Dropping values silently would let a previously-valid event type start failing to insert.

- [ ] **Step 2: Write the RLS migration**

Create `supabase/migrations/20260806000200_brand_voice_rls.sql`:

```sql
-- Row-level security for brand voice.
--
-- Same rule as everywhere else: nothing is granted on the basis of being
-- authenticated.

alter table public.brand_voice_profiles enable row level security;

-- Any active member may read it. How the product is configured to speak is not
-- a privileged question — an analyst reading a draft should be able to see the
-- rules it was written under.
create policy brand_voice_profiles_select on public.brand_voice_profiles
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Writing matches the `brand_voice.update` row in src/lib/auth/permissions.ts.
-- Restated here rather than trusted to the application: a check in application
-- code protects only the path that runs it.
create policy brand_voice_profiles_insert on public.brand_voice_profiles
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy brand_voice_profiles_update on public.brand_voice_profiles
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  )
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

-- No delete policy. There is no product action that removes a voice; resetting
-- means saving the defaults, which keeps the audit trail intact.
revoke delete on public.brand_voice_profiles from authenticated;

comment on policy brand_voice_profiles_select on public.brand_voice_profiles is
  'Any active member may read the configured voice. Reading the rules a draft was written under is not privileged.';
```

- [ ] **Step 3: Validate the migrations parse**

Run: `npm run db:validate`
Expected: PASS — every migration parses, including the two new files.

If it reports a syntax error, fix it before continuing. This is the only automated check available without a live database.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260806000100_brand_voice.sql supabase/migrations/20260806000200_brand_voice_rls.sql
git commit -m "Add the brand_voice_profiles table and its policies"
```

---

### Task 5: Seed data and the SQL generator

**Files:**
- Modify: `src/lib/seed/dataset.ts`
- Modify: `scripts/generate-seed-sql.ts`
- Regenerate: `supabase/seed.sql`
- Test: `tests/seed-dataset.test.ts`

**Interfaces:**
- Consumes: `BrandVoiceProfile` from `@/domain` (Task 1).
- Produces: `SeedDataset.brandVoiceProfiles: BrandVoiceProfile[]`, exported id `BRAND_VOICE_USHG`.

**Note:** `src/lib/fixtures/brand-voice.ts` is **not** deleted here. The page still imports it until Task 9.

- [ ] **Step 1: Write the failing test**

Append to `tests/seed-dataset.test.ts`:

```ts
describe("brand voice seed", () => {
  it("gives the primary organization exactly one profile", () => {
    const owned = SEED_DATASET.brandVoiceProfiles.filter(
      (profile) => profile.organizationId === ORG_USHG,
    );
    expect(owned).toHaveLength(1);
  });

  it("holds at most one profile per organization", () => {
    const seen = new Set<string>();
    for (const profile of SEED_DATASET.brandVoiceProfiles) {
      expect(seen.has(profile.organizationId)).toBe(false);
      seen.add(profile.organizationId);
    }
  });

  it("seeds values that satisfy the domain schema", () => {
    for (const profile of SEED_DATASET.brandVoiceProfiles) {
      expect(() => brandVoiceProfileSchema.parse(profile)).not.toThrow();
    }
  });
});
```

Add `brandVoiceProfileSchema` to the `@/domain` import at the top of that file, and `ORG_USHG` to the `@/lib/seed/dataset` import if not already present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/seed-dataset.test.ts`
Expected: FAIL — `SEED_DATASET.brandVoiceProfiles` does not exist.

- [ ] **Step 3: Add the seeded profile**

In `src/lib/seed/dataset.ts`:

Add `BrandVoiceProfile` to the `@/domain` type import list.

Add the field to the `SeedDataset` interface, after `automationRules`:

```ts
  automationRules: AutomationRule[];
  brandVoiceProfiles: BrandVoiceProfile[];
  auditEvents: AuditEvent[];
```

Add a section before the final dataset assembly, following the file's existing section-comment style. These are the values that were in `src/lib/fixtures/brand-voice.ts`:

```ts
/* -------------------------------------------------------------------------- */
/* Brand voice                                                                 */
/* -------------------------------------------------------------------------- */

export const BRAND_VOICE_USHG = seedId("brand_voice:ushg");

const brandVoiceProfiles: BrandVoiceProfile[] = [
  {
    id: BRAND_VOICE_USHG,
    organizationId: ORG_USHG,
    name: "Union Square Hospitality voice",
    axes: { warmth: 45, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
    approvedPhrases: [
      "thank you for sharing",
      "we appreciate the feedback",
      "we're here to help",
      "we look forward to welcoming you back",
    ],
    prohibitedPhrases: ["we never", "not our fault", "policy prohibits", "as per our policy"],
    version: 1,
    updatedByUserId: USER_NAOMI,
    createdAt: CREATED,
    updatedAt: CREATED,
  },
];
```

Harbor & Vine deliberately gets no row: the second tenant exists to prove isolation, and an organization with no profile is the case the repository has to handle anyway.

Add `brandVoiceProfiles` to the exported `SEED_DATASET` object literal, in the same position it occupies in the interface.

- [ ] **Step 4: Teach the generator to emit the table**

In `scripts/generate-seed-sql.ts`, add an `insert(...)` call between the `automation_rules` and `audit_events` entries.

The axes **must be flattened here.** The generator maps one field to one column, and `literal()` throws on an object in a column not listed in `JSONB_COLUMNS` — deliberately, so a missing entry fails loudly rather than emitting `[object Object]`. Do **not** add `axes` to `JSONB_COLUMNS`: these are five `smallint` columns, not jsonb. Project the rows instead:

```ts
  insert(
    "brand_voice_profiles",
    SEED_DATASET.brandVoiceProfiles.map((profile) => ({
      id: profile.id,
      organizationId: profile.organizationId,
      name: profile.name,
      axisWarmth: profile.axes.warmth,
      axisDetail: profile.axes.detail,
      axisFormality: profile.axes.formality,
      axisConfidence: profile.axes.confidence,
      axisHospitality: profile.axes.hospitality,
      approvedPhrases: profile.approvedPhrases,
      prohibitedPhrases: profile.prohibitedPhrases,
      version: profile.version,
      updatedByUserId: profile.updatedByUserId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
    [
      "id", "organizationId", "name", "axisWarmth", "axisDetail",
      "axisFormality", "axisConfidence", "axisHospitality", "approvedPhrases",
      "prohibitedPhrases", "version", "updatedByUserId", "createdAt", "updatedAt",
    ],
  ),
```

This needs no other change to the script: `columnName()` turns `axisWarmth` into `axis_warmth`, and `literal()` already emits a `string[]` as a PostgreSQL array literal (`'{"thank you for sharing","we appreciate the feedback"}'`), which is what `text[]` wants.

- [ ] **Step 5: Regenerate the seed**

Run: `npm run db:seed:generate`

Then inspect the generated block:

```bash
grep -A 6 "insert into public.brand_voice_profiles" supabase/seed.sql
```

Expected: one `insert` with five separate integer axis columns and both phrase lists as `'{...}'` array literals. If you see `[object Object]` or a JSON array, fix the generator and regenerate.

- [ ] **Step 6: Validate and run the tests**

Run: `npm run db:validate && npx vitest run tests/seed-dataset.test.ts`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/seed/dataset.ts scripts/generate-seed-sql.ts supabase/seed.sql tests/seed-dataset.test.ts
git commit -m "Seed a brand voice profile for the demo organization"
```

---

### Task 6: Repository interface and demo adapter

**Files:**
- Modify: `src/lib/data/types.ts`
- Modify: `src/lib/data/demo/index.ts`
- Test: `tests/repositories.test.ts`

**Interfaces:**
- Consumes: `BrandVoiceProfile`, `UpdateBrandVoiceInput` from `@/domain`; `BRAND_VOICE_USHG`, `ORG_HARBOR` from the seed (Task 5).
- Produces:

```ts
export interface BrandVoiceRepository {
  get(scope: OrganizationScope): Promise<BrandVoiceProfile | null>;
  save(scope: OrganizationScope, input: UpdateBrandVoiceInput): Promise<BrandVoiceProfile>;
}
```

  reachable as `dataSource.brandVoice`.

- [ ] **Step 1: Write the failing test**

Append to `tests/repositories.test.ts`:

```ts
describe("brand voice", () => {
  const input = {
    name: "Maison Laurent voice",
    axes: { warmth: 60, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
    approvedPhrases: ["thank you for sharing"],
    prohibitedPhrases: ["not our fault"],
  };

  it("reads the seeded profile", async () => {
    const profile = await data.brandVoice.get(ushg.admin());
    expect(profile?.id).toBe(BRAND_VOICE_USHG);
    expect(profile?.version).toBe(1);
  });

  it("returns null for an organization that has never configured one", async () => {
    // Absence is normal: provisioning does not create a row, so this is what
    // every organization looks like until somebody presses Save.
    expect(await data.brandVoice.get(harbor.owner())).toBeNull();
  });

  it("inserts at version 1 on the first save", async () => {
    const saved = await data.brandVoice.save(harbor.owner(), input);
    expect(saved.version).toBe(1);
    expect(saved.organizationId).toBe(ORG_HARBOR);
    expect(saved.name).toBe("Maison Laurent voice");
  });

  it("bumps the version when something changes", async () => {
    const before = await data.brandVoice.get(ushg.admin());
    const saved = await data.brandVoice.save(ushg.admin(), input);
    expect(saved.version).toBe((before?.version ?? 0) + 1);
  });

  it("leaves the version alone when nothing changes", async () => {
    // response_drafts.brand_voice_version records which voice produced a draft.
    // Bumping on a no-op would invalidate the provenance of every existing
    // draft because somebody pressed Save twice.
    const first = await data.brandVoice.save(ushg.admin(), input);
    const second = await data.brandVoice.save(ushg.admin(), input);

    expect(second.version).toBe(first.version);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("treats a reordered phrase list as a change", async () => {
    await data.brandVoice.save(ushg.admin(), {
      ...input,
      approvedPhrases: ["one", "two"],
    });
    const reordered = await data.brandVoice.save(ushg.admin(), {
      ...input,
      approvedPhrases: ["two", "one"],
    });
    expect(reordered.approvedPhrases).toEqual(["two", "one"]);
  });

  it("records who saved it", async () => {
    const saved = await data.brandVoice.save(ushg.comms(), input);
    expect(saved.updatedByUserId).toBe(ushg.comms().userId);
  });

  it("does not leak one organization's voice into another", async () => {
    await data.brandVoice.save(harbor.owner(), { ...input, name: "Harbor voice" });
    const ushgProfile = await data.brandVoice.get(ushg.admin());
    expect(ushgProfile?.name).not.toBe("Harbor voice");
  });
});
```

Add `harbor` to the `./helpers/scope` import, and `BRAND_VOICE_USHG` plus `ORG_HARBOR` to the `@/lib/seed/dataset` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/repositories.test.ts`
Expected: FAIL — `data.brandVoice` does not exist.

- [ ] **Step 3: Declare the interface**

In `src/lib/data/types.ts`, add `BrandVoiceProfile` and `UpdateBrandVoiceInput` to the `@/domain` type import, then add the interface near `AutomationRuleRepository`:

```ts
/**
 * Brand voice.
 *
 * One profile per organization, so there is no id parameter and no list
 * method — naming the scope names the row. `get` returns null for an
 * organization that has never saved one; callers substitute
 * `DEFAULT_BRAND_VOICE` rather than treating absence as an error.
 */
export interface BrandVoiceRepository {
  get(scope: OrganizationScope): Promise<BrandVoiceProfile | null>;
  /**
   * Insert or update the organization's profile.
   *
   * Returns the stored row unchanged when the input matches it — no version
   * bump, no `updatedAt` change. See the `version` column comment.
   */
  save(scope: OrganizationScope, input: UpdateBrandVoiceInput): Promise<BrandVoiceProfile>;
}
```

And add it to `LiaDataSource` after `automationRules`:

```ts
  automationRules: AutomationRuleRepository;
  /** How Lia is configured to sound. One row per organization. */
  brandVoice: BrandVoiceRepository;
  auditEvents: AuditEventRepository;
```

- [ ] **Step 4: Implement the demo adapter**

In `src/lib/data/demo/index.ts`, add a `brandVoice` block after `automationRules`. Add `BrandVoiceProfile` to the `@/domain` type import.

```ts
    brandVoice: {
      async get(scope) {
        return (
          store().brandVoiceProfiles.find(
            (row) => row.organizationId === scope.organizationId,
          ) ?? null
        );
      },

      async save(scope, input) {
        const existing = store().brandVoiceProfiles.find(
          (row) => row.organizationId === scope.organizationId,
        );

        if (!existing) {
          const created: BrandVoiceProfile = {
            id: seedId(`brand_voice:${scope.organizationId}`),
            organizationId: scope.organizationId,
            name: input.name,
            axes: { ...input.axes },
            approvedPhrases: [...input.approvedPhrases],
            prohibitedPhrases: [...input.prohibitedPhrases],
            version: 1,
            updatedByUserId: scope.userId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };

          store().brandVoiceProfiles.push(created);
          return created;
        }

        // A save that changes nothing returns the stored row untouched.
        // `response_drafts.brand_voice_version` records which voice produced a
        // draft, so bumping on a no-op would invalidate the provenance of every
        // existing draft because somebody pressed Save twice.
        if (matchesStored(existing, input)) return existing;

        const updated: BrandVoiceProfile = {
          ...existing,
          name: input.name,
          axes: { ...input.axes },
          approvedPhrases: [...input.approvedPhrases],
          prohibitedPhrases: [...input.prohibitedPhrases],
          version: existing.version + 1,
          updatedByUserId: scope.userId,
          updatedAt: nowIso(),
        };

        return replaceRow(store().brandVoiceProfiles, updated);
      },
    },
```

Add the comparison helper beside the other module-level helpers in that file (near `nowIso`):

```ts
/**
 * Whether a save would change anything.
 *
 * Order counts as a change for phrase lists: the order is what somebody sees
 * when they read the list back, so silently keeping the old one would make the
 * screen disagree with the database.
 */
function matchesStored(stored: BrandVoiceProfile, input: UpdateBrandVoiceInput): boolean {
  const sameAxes = BRAND_VOICE_AXIS_KEYS.every(
    (key) => stored.axes[key] === input.axes[key],
  );
  const samePhrases = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  return (
    sameAxes &&
    stored.name === input.name &&
    samePhrases(stored.approvedPhrases, input.approvedPhrases) &&
    samePhrases(stored.prohibitedPhrases, input.prohibitedPhrases)
  );
}
```

Import `BRAND_VOICE_AXIS_KEYS` and the `UpdateBrandVoiceInput` type from `@/domain`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/repositories.test.ts`
Expected: PASS.

Note the "leaves the version alone" test depends on `nowIso()` returning the frozen `REFERENCE_NOW` in demo mode, so `updatedAt` equality is meaningful only because the version is also asserted. Both assertions must pass.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: FAIL, with an error that the Supabase adapter does not implement `brandVoice`. That is expected and is fixed in Task 7. Do not add a stub to silence it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/types.ts src/lib/data/demo/index.ts tests/repositories.test.ts
git commit -m "Add the brand voice repository and its demo implementation"
```

---

### Task 7: Supabase adapter

**Files:**
- Modify: `src/lib/data/supabase/mappers.ts`
- Modify: `src/lib/data/supabase/index.ts`

**Interfaces:**
- Consumes: `BrandVoiceRepository` (Task 6), `brandVoiceProfileSchema` (Task 1).
- Produces: `toBrandVoiceProfile(row: Row): BrandVoiceProfile` exported from the mappers module.

- [ ] **Step 1: Write the mapper**

In `src/lib/data/supabase/mappers.ts`, add `brandVoiceProfileSchema` and the `BrandVoiceProfile` type to the `@/domain` import, then add beside `toAutomationRule`:

```ts
/**
 * Five axis columns fold back into one object.
 *
 * The columns are separate in Postgres so each carries its own range check;
 * the domain groups them because every consumer wants them together.
 */
export function toBrandVoiceProfile(row: Row): BrandVoiceProfile {
  return parseOrThrow(
    brandVoiceProfileSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      axes: {
        warmth: row.axis_warmth,
        detail: row.axis_detail,
        formality: row.axis_formality,
        confidence: row.axis_confidence,
        hospitality: row.axis_hospitality,
      },
      approvedPhrases: row.approved_phrases ?? [],
      prohibitedPhrases: row.prohibited_phrases ?? [],
      version: row.version,
      updatedByUserId: row.updated_by_user_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    "brand voice profile",
  );
}
```

Check the third argument against the other `parseOrThrow` calls in that file and match their convention exactly — read `toAutomationRule` and one neighbour before writing this.

- [ ] **Step 2: Implement the repository**

In `src/lib/data/supabase/index.ts`, add a `brandVoice` block after `automationRules`, importing `toBrandVoiceProfile`:

```ts
    brandVoice: {
      async get(scope) {
        const { data, error } = await from("brand_voice_profiles", scope).maybeSingle();
        if (error) fail(error, "load the brand voice");
        return data ? toBrandVoiceProfile(data as Row) : null;
      },

      async save(scope, input) {
        const current = await this.get(scope);

        const columns = {
          name: input.name,
          axis_warmth: input.axes.warmth,
          axis_detail: input.axes.detail,
          axis_formality: input.axes.formality,
          axis_confidence: input.axes.confidence,
          axis_hospitality: input.axes.hospitality,
          approved_phrases: input.approvedPhrases,
          prohibited_phrases: input.prohibitedPhrases,
          updated_by_user_id: scope.userId,
        };

        if (!current) {
          const { data, error } = await client
            .from("brand_voice_profiles")
            .insert({ ...columns, organization_id: scope.organizationId, version: 1 })
            .select("*")
            .single();
          if (error) fail(error, "save the brand voice");
          return toBrandVoiceProfile(data as Row);
        }

        // Unchanged input returns the stored row untouched, so the version --
        // and therefore the provenance of every draft that cites it -- is not
        // disturbed by pressing Save twice.
        if (matchesStoredProfile(current, input)) return current;

        const { data, error } = await client
          .from("brand_voice_profiles")
          .update({ ...columns, version: current.version + 1 })
          .eq("organization_id", scope.organizationId)
          .select("*")
          .single();
        if (error) fail(error, "save the brand voice");
        return toBrandVoiceProfile(data as Row);
      },
    },
```

Add the comparison helper near the other module-level helpers in this file. It is written out again rather than shared with the demo adapter, matching the convention recorded at `src/lib/data/supabase/index.ts:98` — the two adapters are meant to be independently readable:

```ts
/**
 * Whether a save would change anything.
 *
 * Order counts as a change for phrase lists: the order is what somebody sees
 * when they read the list back.
 */
function matchesStoredProfile(
  stored: BrandVoiceProfile,
  input: UpdateBrandVoiceInput,
): boolean {
  const sameAxes = BRAND_VOICE_AXIS_KEYS.every(
    (key) => stored.axes[key] === input.axes[key],
  );
  const samePhrases = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  return (
    sameAxes &&
    stored.name === input.name &&
    samePhrases(stored.approvedPhrases, input.approvedPhrases) &&
    samePhrases(stored.prohibitedPhrases, input.prohibitedPhrases)
  );
}
```

**Known trade-off to leave as-is:** read-then-write is two statements with no transaction available (D17). Two concurrent saves can both read version *n* and both write *n+1*, so one edit is lost and the version undercounts by one. The unique constraint still guarantees one row. This is a configuration screen edited rarely by a handful of people; a serialising fix would need a stored procedure, which is out of scope here. Note it in Task 10's known gaps.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — both adapters now satisfy `LiaDataSource`.

- [ ] **Step 4: Run the full suite**

Run: `npm run test`
Expected: PASS. The Supabase adapter is not exercised by tests (no live database in this environment); it is covered by typecheck and the production build, exactly as the sync and analysis write paths are.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/supabase/mappers.ts src/lib/data/supabase/index.ts
git commit -m "Implement the brand voice repository on the Supabase adapter"
```

---

### Task 8: Save service and server action

**Files:**
- Create: `src/lib/brand-voice/save.ts`
- Create: `src/app/actions/brand-voice.ts`
- Test: `tests/brand-voice-save.test.ts`

**Interfaces:**
- Consumes: the repository (Task 6), `diff`/`recordAuditEvent` from `@/lib/audit/record`, `updateBrandVoiceInputSchema` (Task 1).
- Produces:
  - `BrandVoiceContext = { dataSource: LiaDataSource; scope: OrganizationScope }`
  - `saveBrandVoice(context: BrandVoiceContext, input: UpdateBrandVoiceInput): Promise<SaveBrandVoiceResult>` where `SaveBrandVoiceResult = { profile: BrandVoiceProfile; changed: boolean }`
  - `updateBrandVoiceAction(input: unknown): Promise<ActionResult<BrandVoiceProfile>>`

**Why a service and not just an action.** This repository does not test server actions — nothing under `tests/` imports `@/app/actions`, and there is no mocking infrastructure at all (no `vi.mock` anywhere). The established split is the one `analyzeMentions` uses: the service holds the logic and takes an already-authorized `{dataSource, scope}`, the action is authorize → call → revalidate, and the tests exercise the service with `freshDataSource()`. Follow it rather than introducing a fourth pattern.

**Where the permission is tested.** In the action, via `authorize()`, exactly as every other action does. The matrix itself is covered by Task 3. There is deliberately no service-level permission test — the service receives a context that has already passed the gate, and asserting otherwise would test a check that does not live there.

- [ ] **Step 1: Write the failing test**

Create `tests/brand-voice-save.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import { saveBrandVoice } from "@/lib/brand-voice/save";
import type { LiaDataSource } from "@/lib/data/types";
import type { UpdateBrandVoiceInput } from "@/domain";

/**
 * Saving the brand voice, through the service.
 *
 * Repositories and audit are production code here — what these tests are for is
 * how persistence and the trail fit together. A save that stores correctly but
 * records nothing, or one that records a change that did not happen, is exactly
 * the bug a unit test of either piece alone would miss.
 */

let data: LiaDataSource;

const input: UpdateBrandVoiceInput = {
  name: "Maison Laurent voice",
  axes: { warmth: 70, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
  approvedPhrases: ["thank you for sharing"],
  prohibitedPhrases: ["not our fault"],
};

beforeEach(() => {
  data = freshDataSource();
});

function auditEvents(scope = ushg.admin()) {
  return data.auditEvents.list(scope, { entityType: "brand_voice" });
}

describe("saveBrandVoice", () => {
  it("persists the change and reports it as changed", async () => {
    const scope = ushg.comms();
    const result = await saveBrandVoice({ dataSource: data, scope }, input);

    expect(result.changed).toBe(true);
    expect(result.profile.axes.warmth).toBe(70);
    expect((await data.brandVoice.get(scope))?.axes.warmth).toBe(70);
  });

  it("records exactly one audit event, attributed to the actor", async () => {
    const scope = ushg.comms();
    await saveBrandVoice({ dataSource: data, scope }, input);

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("brand_voice.updated");
    expect(events[0]?.entityType).toBe("brand_voice");
    expect(events[0]?.actorUserId).toBe(scope.userId);
  });

  it("records only the fields that moved", async () => {
    const scope = ushg.comms();
    const before = await data.brandVoice.get(scope);
    await saveBrandVoice(
      { dataSource: data, scope },
      {
        name: before?.name ?? "",
        axes: { ...(before?.axes ?? input.axes), warmth: 90 },
        approvedPhrases: before?.approvedPhrases ?? [],
        prohibitedPhrases: before?.prohibitedPhrases ?? [],
      },
    );

    const events = await auditEvents();
    expect(events[0]?.newState).toEqual({ warmth: 90 });
    expect(events[0]?.previousState).toEqual({ warmth: before?.axes.warmth });
  });

  it("writes no audit event when nothing changed", async () => {
    // An entry for a save that changed nothing is noise in the one place noise
    // is most expensive.
    const scope = ushg.comms();
    await saveBrandVoice({ dataSource: data, scope }, input);
    const first = await auditEvents();

    const second = await saveBrandVoice({ dataSource: data, scope }, input);

    expect(second.changed).toBe(false);
    expect(await auditEvents()).toHaveLength(first.length);
  });

  it("leaves the version alone on a no-op save", async () => {
    const scope = ushg.comms();
    const first = await saveBrandVoice({ dataSource: data, scope }, input);
    const second = await saveBrandVoice({ dataSource: data, scope }, input);
    expect(second.profile.version).toBe(first.profile.version);
  });

  it("records a creation with a null previous state", async () => {
    // Harbor has no seeded profile, so this is the insert path.
    const scope = harbor.owner();
    const result = await saveBrandVoice({ dataSource: data, scope }, input);

    expect(result.profile.version).toBe(1);

    const events = await data.auditEvents.list(scope, { entityType: "brand_voice" });
    expect(events).toHaveLength(1);
    expect(events[0]?.previousState).toBeNull();
    expect(events[0]?.newState).not.toBeNull();
  });

  it("keeps one organization's audit trail out of another's", async () => {
    await saveBrandVoice({ dataSource: data, scope: harbor.owner() }, input);
    expect(await auditEvents()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/brand-voice-save.test.ts`
Expected: FAIL — cannot resolve `@/lib/brand-voice/save`.

- [ ] **Step 3: Write the service**

Create `src/lib/brand-voice/save.ts`:

```ts
import {
  BRAND_VOICE_AXIS_KEYS,
  type BrandVoiceProfile,
  type UpdateBrandVoiceInput,
} from "@/domain";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/**
 * Saving the brand voice: persist, then record what moved.
 *
 * Separate from the action for the reason `analyzeMentions` is: the ordering
 * that matters lives here, so a future caller — a scheduled reset, an import —
 * gets identical behaviour rather than a second implementation of it.
 *
 * The caller has already passed `authorize("brand_voice.update")`. This
 * function performs no role check of its own.
 */

export interface BrandVoiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

export interface SaveBrandVoiceResult {
  profile: BrandVoiceProfile;
  /** False when the input matched what was already stored. */
  changed: boolean;
}

/**
 * Flatten a profile into scalars for the audit diff.
 *
 * `diff` compares with `===` and stringifies anything that is not a primitive,
 * so handing it the axes object or the phrase arrays would report a change on
 * every save — two equal arrays are never `===`. Joining them makes the
 * comparison meaningful and the stored trail readable.
 */
function auditShape(profile: BrandVoiceProfile): Record<string, string | number> {
  const axes = Object.fromEntries(
    BRAND_VOICE_AXIS_KEYS.map((key) => [key, profile.axes[key]]),
  ) as Record<string, number>;

  return {
    ...axes,
    name: profile.name,
    approvedPhrases: profile.approvedPhrases.join(", "),
    prohibitedPhrases: profile.prohibitedPhrases.join(", "),
  };
}

const AUDITED_FIELDS = [
  ...BRAND_VOICE_AXIS_KEYS,
  "name",
  "approvedPhrases",
  "prohibitedPhrases",
] as const;

export async function saveBrandVoice(
  context: BrandVoiceContext,
  input: UpdateBrandVoiceInput,
): Promise<SaveBrandVoiceResult> {
  const existing = await context.dataSource.brandVoice.get(context.scope);
  const profile = await context.dataSource.brandVoice.save(context.scope, input);

  // The repository returns the stored row untouched when nothing differs, so
  // the version is the signal. Comparing the inputs again here would be a
  // second implementation of the same rule.
  const changed = existing === null || existing.version !== profile.version;

  if (!changed) return { profile, changed: false };

  const changes = existing
    ? diff(auditShape(existing), auditShape(profile), [...AUDITED_FIELDS])
    : { previousState: null, newState: auditShape(profile) };

  await recordAuditEvent(context, {
    eventType: "brand_voice.updated",
    entityType: "brand_voice",
    entityId: profile.id,
    previousState: changes.previousState,
    newState: changes.newState,
    metadata: { version: profile.version },
  });

  return { profile, changed: true };
}
```

On creation `previousState` is null and `newState` is the whole shape rather than a diff, matching the `auditEventSchema` comment: "Null on creation events."

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/brand-voice-save.test.ts`
Expected: PASS on all seven cases.

- [ ] **Step 5: Write the action**

Create `src/app/actions/brand-voice.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { updateBrandVoiceInputSchema, type BrandVoiceProfile } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { saveBrandVoice } from "@/lib/brand-voice/save";

/**
 * Save the organization's brand voice.
 *
 * Thin, like the analysis and integration actions: authorise, call the service,
 * revalidate. Nothing generates text from these settings yet, so this changes
 * no output today — but it is audited, because "who widened the approved phrase
 * list" is exactly the question asked after a response goes wrong, and the
 * trail has to already exist by then.
 */
export async function updateBrandVoiceAction(
  input: unknown,
): Promise<ActionResult<BrandVoiceProfile>> {
  return runAction("brand_voice.update", async () => {
    const parsed = updateBrandVoiceInputSchema.parse(input);
    const context = await authorize("brand_voice.update");

    const { profile } = await saveBrandVoice(context, parsed);

    // Only this screen reads the voice. Nothing generates from it yet, so no
    // other route's output can have changed.
    revalidatePath("/brand-voice");
    return profile;
  });
}
```

Parsing happens before `authorize()` so that malformed input is rejected as a validation error regardless of role, rather than reporting "forbidden" for a payload that was never valid.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npm run test`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/brand-voice/save.ts src/app/actions/brand-voice.ts tests/brand-voice-save.test.ts
git commit -m "Add the brand voice save service and action"
```

---

### Task 9: Screen

**Files:**
- Create: `src/components/brand-voice/axis-slider.tsx`
- Create: `src/components/brand-voice/phrase-editor.tsx`
- Create: `src/components/brand-voice/voice-summary.tsx`
- Create: `src/components/brand-voice/voice-form.tsx`
- Create: `src/components/brand-voice/channel-scope.tsx`
- Rewrite: `src/app/(app)/brand-voice/page.tsx`
- Delete: `src/lib/fixtures/brand-voice.ts`

**Interfaces:**
- Consumes: `updateBrandVoiceAction` (Task 8), `summarizeBrandVoice` (Task 2), `BRAND_VOICE_AXES`, `DEFAULT_BRAND_VOICE`, `MAX_PHRASES`, `MAX_PHRASE_LENGTH` (Task 1), `can` from `@/lib/auth/permissions`.
- Produces: `AxisSlider`, `PhraseEditor`, `VoiceSummary`, `VoiceForm`, `ChannelScope`.

- [ ] **Step 1: Write the axis slider**

Create `src/components/brand-voice/axis-slider.tsx`:

```tsx
"use client";

import type { BrandVoiceAxis } from "@/domain";

export interface AxisSliderProps {
  axis: BrandVoiceAxis;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/**
 * One voice axis.
 *
 * A real `input[type=range]`, so keyboard operation, focus, and screen-reader
 * announcement come from the platform rather than from a reimplementation of
 * them. The pole labels are the accessible name; the numeric value is exposed
 * through `aria-valuetext` so it is read as "warm to formal", not "62".
 */
export function AxisSlider({ axis, value, disabled = false, onChange }: AxisSliderProps) {
  const label = `${axis.leftLabel} to ${axis.rightLabel}`;

  return (
    <li className="grid grid-cols-[7rem_1fr_7rem] items-center gap-3">
      <label
        htmlFor={`axis-${axis.key}`}
        className="text-[13px] font-medium text-gray-950"
      >
        {axis.leftLabel}
      </label>
      <input
        id={`axis-${axis.key}`}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${value} of 100, ${label}`}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-purple-600 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="text-right text-[13px] text-gray-500">{axis.rightLabel}</span>
    </li>
  );
}
```

- [ ] **Step 2: Write the phrase editor**

Create `src/components/brand-voice/phrase-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { MAX_PHRASE_LENGTH, MAX_PHRASES } from "@/domain";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface PhraseEditorProps {
  /** Distinguishes the two instances for label association. */
  id: string;
  legend: string;
  tone: "approved" | "prohibited";
  phrases: string[];
  disabled?: boolean;
  error?: string;
  onChange: (phrases: string[]) => void;
}

const TONE_CLASSES: Record<PhraseEditorProps["tone"], string> = {
  approved: "bg-green-100 text-green-600",
  prohibited: "bg-red-100 text-red-600",
};

/**
 * A editable list of phrases.
 *
 * Used for both the approved and prohibited lists — they differ only in colour
 * and wording, so one component with a `tone` beats two that drift apart.
 *
 * Duplicates and blanks are dropped by the schema on save; this only guards the
 * count, so somebody cannot add a 21st chip and discover on submit that it was
 * never going to be accepted.
 */
export function PhraseEditor({
  id,
  legend,
  tone,
  phrases,
  disabled = false,
  error,
  onChange,
}: PhraseEditorProps) {
  const [draft, setDraft] = useState("");
  const full = phrases.length >= MAX_PHRASES;

  function add() {
    const phrase = draft.trim();
    if (!phrase || full) return;
    if (phrases.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...phrases, phrase]);
    setDraft("");
  }

  return (
    <div className="mt-4">
      <ul className="flex flex-wrap gap-2">
        {phrases.map((phrase) => (
          <li
            key={phrase}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px]",
              TONE_CLASSES[tone],
            )}
          >
            {phrase}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(phrases.filter((value) => value !== phrase))}
              aria-label={`Remove ${phrase}`}
              className="rounded-sm hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
        {phrases.length === 0 ? (
          <li className="text-[13px] text-gray-500">None yet.</li>
        ) : null}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {legend}
        </label>
        <input
          id={id}
          type="text"
          value={draft}
          maxLength={MAX_PHRASE_LENGTH}
          disabled={disabled || full}
          placeholder={full ? `Limit of ${MAX_PHRASES} reached` : "Add a phrase"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the phrase rather than submitting the form. A form
            // submit here would save the whole profile from a half-typed chip.
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="h-9 min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 text-[13px] text-gray-950 placeholder:text-gray-400 focus:border-purple-600 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
        />
        <Button
          type="button"
          size="sm"
          icon={Plus}
          disabled={disabled || full || draft.trim().length === 0}
          onClick={add}
        >
          Add
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Write the summary card**

Create `src/components/brand-voice/voice-summary.tsx`:

```tsx
"use client";

import { CheckCircle2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { summarizeBrandVoice } from "@/lib/brand-voice/summary";
import type { BrandVoiceAxes } from "@/domain";

export interface VoiceSummaryProps {
  axes: BrandVoiceAxes;
}

/**
 * The settings in plain language.
 *
 * Derived from the live form state rather than from the saved row, so it
 * describes what will be saved rather than what was.
 */
export function VoiceSummary({ axes }: VoiceSummaryProps) {
  return (
    <Card>
      <CardHeader
        title="Voice summary"
        description="The same settings in plain language, so anyone can check them."
      />
      <ul className="mt-4 space-y-2">
        {summarizeBrandVoice(axes).map((line) => (
          <li key={line} className="flex items-center gap-2 text-[13px] text-gray-700">
            <CheckCircle2 className="size-4 shrink-0 text-green-600" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

- [ ] **Step 4: Write the form**

Create `src/components/brand-voice/voice-form.tsx`. It owns all editable state, dirty tracking, and submission.

```tsx
"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Loader2, Save } from "lucide-react";
import { updateBrandVoiceAction } from "@/app/actions/brand-voice";
import { AxisSlider } from "@/components/brand-voice/axis-slider";
import { PhraseEditor } from "@/components/brand-voice/phrase-editor";
import { VoiceSummary } from "@/components/brand-voice/voice-summary";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { BRAND_VOICE_AXES, type UpdateBrandVoiceInput } from "@/domain";

export interface VoiceFormProps {
  initial: UpdateBrandVoiceInput;
  /** True when the caller's role cannot change the voice. */
  readOnly: boolean;
  /** Server-rendered cards that sit inside the form's layout. */
  channels: ReactNode;
  preview: ReactNode;
}

function isDirty(a: UpdateBrandVoiceInput, b: UpdateBrandVoiceInput): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * The editable brand voice.
 *
 * Save lives in a sticky bar inside the form rather than in the page header,
 * because the header cannot observe this component's dirty state without
 * lifting it out of the one place that uses it. A configuration screen that
 * cannot say "you have unsaved changes" is the more common failure anyway.
 *
 * On failure the edits stay on screen. Losing somebody's tuning because a
 * request failed is not an acceptable outcome for a screen whose whole purpose
 * is accumulating small adjustments.
 */
export function VoiceForm({ initial, readOnly, channels, preview }: VoiceFormProps) {
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const dirty = isDirty(value, saved);

  function submit() {
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await updateBrandVoiceAction(value);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      const next: UpdateBrandVoiceInput = {
        name: result.data.name,
        axes: result.data.axes,
        approvedPhrases: result.data.approvedPhrases,
        prohibitedPhrases: result.data.prohibitedPhrases,
      };
      setSaved(next);
      setValue(next);
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <Card>
            <CardHeader
              title="1. How should Lia sound?"
              description="Five paired sliders set the register of every generated response."
            />
            <ul className="mt-4 space-y-4">
              {BRAND_VOICE_AXES.map((axis) => (
                <AxisSlider
                  key={axis.key}
                  axis={axis}
                  value={value.axes[axis.key]}
                  disabled={readOnly || pending}
                  onChange={(next) =>
                    setValue((current) => ({
                      ...current,
                      axes: { ...current.axes, [axis.key]: next },
                    }))
                  }
                />
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="2. Use these phrases"
              description="Phrases Lia may include in responses."
            />
            <PhraseEditor
              id="approved-phrase"
              legend="Add an approved phrase"
              tone="approved"
              phrases={value.approvedPhrases}
              disabled={readOnly || pending}
              error={fieldErrors.approvedPhrases}
              onChange={(next) =>
                setValue((current) => ({ ...current, approvedPhrases: next }))
              }
            />
          </Card>

          <Card>
            <CardHeader
              title="3. Avoid these phrases"
              description="Phrases Lia will never write."
            />
            <PhraseEditor
              id="prohibited-phrase"
              legend="Add a prohibited phrase"
              tone="prohibited"
              phrases={value.prohibitedPhrases}
              disabled={readOnly || pending}
              error={fieldErrors.prohibitedPhrases}
              onChange={(next) =>
                setValue((current) => ({ ...current, prohibitedPhrases: next }))
              }
            />
          </Card>

          {channels}
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          {preview}
          <VoiceSummary axes={value.axes} />
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-600/30 bg-red-100 px-3 py-2 text-[13px] text-red-600"
        >
          {error}
        </p>
      ) : null}

      {!readOnly && dirty ? (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-card">
          <span className="text-[13px] text-gray-700">Unsaved changes</span>
          <span className="flex items-center gap-2">
            <Button type="button" disabled={pending} onClick={() => setValue(saved)}>
              Discard
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={pending ? Loader2 : Save}
              disabled={pending}
            >
              {pending ? "Saving" : "Save changes"}
            </Button>
          </span>
        </div>
      ) : null}
    </form>
  );
}
```

Check that `shadow-card` exists as a utility — it is used in the current page at line 58. If it does not resolve, use the same treatment the other cards use.

- [ ] **Step 5: Write the channel card**

Create `src/components/brand-voice/channel-scope.tsx` as a **server** component (no `"use client"`):

```tsx
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";

export interface ChannelScopeProps {
  /** Display names of the platforms this organization has connected. */
  connected: string[];
}

/**
 * Where this voice applies.
 *
 * Read from the organization's actual connections rather than typed in.
 * `CLAUDE.md` requires platform capabilities stay explicit and forbids implying
 * publishing where a source does not support it — an editable list lets
 * somebody name a platform Lia has no connector for, which is exactly the
 * implication that rule exists to prevent.
 */
export function ChannelScope({ connected }: ChannelScopeProps) {
  return (
    <Card>
      <CardHeader
        title="4. Where Lia will respond"
        description="Taken from your connected platforms. Manage these in integrations."
      />
      {connected.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2">
          {connected.map((channel) => (
            <li
              key={channel}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] text-gray-700"
            >
              {channel}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[13px] text-gray-500">
          No platforms connected yet.{" "}
          <Link href="/integrations" className="text-purple-600 hover:underline">
            Connect one in integrations
          </Link>
          .
        </p>
      )}
    </Card>
  );
}
```

- [ ] **Step 6: Rewrite the page**

Replace `src/app/(app)/brand-voice/page.tsx` entirely:

```tsx
import type { Metadata } from "next";
import { PageBody } from "@/components/shell/app-shell";
import { ChannelScope } from "@/components/brand-voice/channel-scope";
import { VoiceForm } from "@/components/brand-voice/voice-form";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { DEFAULT_BRAND_VOICE, type UpdateBrandVoiceInput } from "@/domain";

export const metadata: Metadata = { title: "Brand voice" };

/**
 * Brand voice configuration.
 *
 * An organization with no saved profile is the normal case, not an error:
 * provisioning does not create one, so the defaults are rendered and the first
 * save inserts the row.
 */
export default async function BrandVoicePage() {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();

  const [profile, connections] = await Promise.all([
    dataSource.brandVoice.get(context.scope),
    dataSource.platformConnections.list(context.scope),
  ]);

  const initial: UpdateBrandVoiceInput = profile
    ? {
        name: profile.name,
        axes: profile.axes,
        approvedPhrases: profile.approvedPhrases,
        prohibitedPhrases: profile.prohibitedPhrases,
      }
    : DEFAULT_BRAND_VOICE;

  const readOnly = !can(context.role, "brand_voice.update");

  return (
    <PageBody>
      <PageHeader
        title="Brand voice"
        description="Set how Lia writes so every response reflects your brand."
      />

      {readOnly ? (
        <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700">
          You can read this configuration but not change it. Ask an owner, an
          admin, or your communications lead.
        </p>
      ) : null}

      <VoiceForm
        initial={initial}
        readOnly={readOnly}
        channels={<ChannelScope connected={connectedPlatformNames(connections)} />}
        preview={
          <SectionPlaceholder
            title="5. Live preview"
            description="A real mention answered in this voice. Available once response drafting arrives."
            shape="lines"
          />
        }
      />
    </PageBody>
  );
}
```

Write `connectedPlatformNames` in this file as a small local function. Read `src/lib/labels.ts` first — it very likely already holds the platform display names, in which case use it rather than writing a second mapping. Include only connections whose status indicates they are actually connected; read the `PlatformConnection` type in `src/domain/entities/platform.ts` to get the field and its values right. Do **not** list a platform merely because a row exists.

- [ ] **Step 7: Delete the fixture**

```bash
git rm src/lib/fixtures/brand-voice.ts
```

Then confirm nothing still imports it:

```bash
grep -rn "fixtures/brand-voice" src/ tests/
```

Expected: no results.

- [ ] **Step 8: Verify the whole build**

Run: `npm run verify`
Expected: lint, typecheck, tests, and build all PASS.

If the build complains that `VoiceForm` receives non-serialisable props, note that `channels` and `preview` are React elements rendered on the server and passed as children — that is supported. If it objects to something else, do not convert `ChannelScope` into a client component to make it go away; find the actual cause.

- [ ] **Step 9: Check it in the browser**

Run: `npm run dev`

Confirm, in demo mode:

1. The sliders drag, and respond to arrow keys when focused.
2. The summary lines change as a slider moves.
3. Adding a phrase and pressing Enter adds a chip without submitting the form.
4. The sticky save bar appears only after a change, and Discard restores the saved values.
5. Save persists — reload the page and the change is still there.
6. Adding the same phrase to both lists and saving shows the contradiction error on the prohibited list.
7. Switching to a read-only role via the `lia_demo_user` cookie hides the save bar and disables the controls.

- [ ] **Step 10: Commit**

```bash
git add src/components/brand-voice src/app/\(app\)/brand-voice/page.tsx
git commit -m "Make the brand voice screen editable"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/architecture/current-state.md`

- [ ] **Step 1: Correct the route table**

Change the `/brand-voice` row from `typed fixture (no table yet)` to `repositories`.

- [ ] **Step 2: Close the resolved gaps**

Two entries claim brand voice has no table — one under "Carried over from workflow 01", one under "New in workflow 04". Strike both through and mark them resolved, following the existing convention in that file:

```markdown
- ~~Brand voice has no table; the screen still reads a typed fixture.~~
  **Resolved.** `brand_voice_profiles` ships with RLS, both adapters, and an
  audited action. Nothing generates text from it yet.
```

- [ ] **Step 3: Add the decisions**

Add a new section after "Decisions made building sign-up and multi-user", holding D60–D69 exactly as they appear in the spec's decision table.

- [ ] **Step 4: Record the new gaps**

Add to the known gaps:

```markdown
New in brand voice configuration:

- **Nothing reads the table.** Response generation does not exist, so the
  settings change no output. This was D34's objection, accepted deliberately:
  the alternative was leaving a screen whose controls discarded every edit.
- **The Supabase write path has only run against the demo adapter**, the same
  position the sync and analysis writes are in.
- **A concurrent save can lose an edit.** `save` is read-then-write with no
  transaction available (D17), so two simultaneous saves can both read version
  *n* and both write *n+1*. The unique constraint still guarantees one row.
  Acceptable for a screen edited rarely by a handful of people; a serialising
  fix needs a stored procedure.
- **The axis taxonomy is unvalidated.** Five paired sliders are inherited from
  the fixture and the reference screens. Whether they are the right five is
  unanswerable until a prompt consumes them.
- `response_drafts.brand_voice_version` is still written null. Stamping it is
  drafting's job.
```

- [ ] **Step 5: Update the stated scope line**

The document opens with "Factual snapshot of the Lia codebase after workflow 04 … and the authentication work that followed it." Extend it to mention brand voice configuration.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/current-state.md
git commit -m "Record brand voice configuration in the architecture doc"
```

---

## Final verification

- [ ] **Run the full gate**

```bash
npm run verify && npm run db:validate
```

Expected: all PASS.

- [ ] **Confirm the fixture is gone and nothing references it**

```bash
grep -rn "BRAND_VOICE_PROFILE" src/ tests/
```

Expected: no results.

- [ ] **Confirm the seed regenerated cleanly**

```bash
git diff --stat master -- supabase/seed.sql
```

Expected: additions only in the `brand_voice_profiles` block. If other tables moved, the generator was changed in a way it should not have been.

## Deferred to response generation

Not in scope, listed so a later reader does not mistake absence for oversight:

- `draftResponse()` on `AiProvider`, and any prompt that reads these settings.
- A working live preview. The card stays a placeholder.
- Stamping `response_drafts.brand_voice_version`.
- Per-location voice overrides.
