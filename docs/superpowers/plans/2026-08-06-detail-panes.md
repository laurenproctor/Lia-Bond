# Detail Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Selected item" `SectionPlaceholder` cards on `/mentions`, `/responses`, and `/escalations` with working, server-rendered detail panes selected via a URL search param.

**Architecture:** Selection is a search param read by the server page (`?mention=` on `/mentions` per existing `workspacePathFor` links; `?selected=` on the table pages). A pure `resolveSelection` helper picks the item with stale-param fallback. Panes are server components built on the existing `DetailPanel`; the two table pages get row-selection support added to the shared `DataTable`. No new repository methods or server actions.

**Tech Stack:** Next.js 16 App Router (searchParams is a `Promise`), React 19 server components, vitest (node environment — pure modules only, no component tests), TypeScript strict.

Spec: `docs/superpowers/specs/2026-08-06-detail-panes-design.md` (decisions D96–D106).

## Global Constraints

- TypeScript strict; no `any` without a justifying comment.
- Server components by default; `"use client"` only where interactivity requires it (no new client components are needed in this plan).
- Sentence case for all UI copy ("Open workspace", not "Open Workspace").
- Never imply publishing capability that does not exist (D104): publishing metadata renders "Not published" with an honest explanation.
- Tests run in vitest's node environment (`tests/**/*.test.ts`, `@/` alias works). Do not add jsdom or component tests.
- No page component over ~300 lines.
- Verify suite: `npm run verify` (lint + typecheck + test + build).
- Do NOT touch the unrelated uncommitted changes in the working tree (`src/proxy.ts` rename, `src/app/robots.ts`, `tests/onboarding-permissions.test.ts`, `tests/site-routes.test.ts`). Commit only files this plan names.

---

### Task 1: `resolveSelection` helper

**Files:**
- Create: `src/lib/selection.ts`
- Test: `tests/selection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveSelection<T>(items: readonly T[], selectedId: string | undefined, idOf: (item: T) => string): T | null` — used by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

```ts
// tests/selection.test.ts
import { describe, expect, it } from "vitest";
import { resolveSelection } from "@/lib/selection";

interface Item {
  id: string;
}

const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
const idOf = (item: Item) => item.id;

describe("resolveSelection", () => {
  it("returns the matching item when the param matches", () => {
    expect(resolveSelection(items, "b", idOf)).toEqual({ id: "b" });
  });

  it("falls back to the first item when the param is stale", () => {
    expect(resolveSelection(items, "deleted-id", idOf)).toEqual({ id: "a" });
  });

  it("falls back to the first item when the param is missing", () => {
    expect(resolveSelection(items, undefined, idOf)).toEqual({ id: "a" });
  });

  it("returns null when there is nothing to select", () => {
    expect(resolveSelection([], "a", idOf)).toBeNull();
    expect(resolveSelection([], undefined, idOf)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selection.test.ts`
Expected: FAIL — cannot resolve `@/lib/selection`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/selection.ts

/**
 * Which item a split view shows.
 *
 * A missing or stale selection param falls back to the first item rather than
 * erroring: a stale bookmark or a deleted record degrades to "the page as
 * freshly opened" (D98). The lists are already sorted newest/worst-first, so
 * the first item is the right default focus. Null only when the list is empty.
 */
export function resolveSelection<T>(
  items: readonly T[],
  selectedId: string | undefined,
  idOf: (item: T) => string,
): T | null {
  if (selectedId) {
    const match = items.find((item) => idOf(item) === selectedId);
    if (match) return match;
  }
  return items[0] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/selection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/selection.ts tests/selection.test.ts
git commit -m "Add resolveSelection with stale-param fallback"
```

---

### Task 2: `DataTable` row selection props

**Files:**
- Modify: `src/components/ui/data-table.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: three new optional `DataTableProps` members used by Tasks 4 and 5:
  - `rowHref?: (row: Row) => string`
  - `rowLabel?: (row: Row) => string` (accessible name for the selection link)
  - `selectedKey?: string | null` (compared against `rowKey(row)`)

No unit test: components are not testable in the node-only vitest setup (D74 precedent). The gate is `npm run typecheck` plus unchanged behavior for the existing consumers, which pass none of the new props.

- [ ] **Step 1: Add the props and the stretched selection link**

In `src/components/ui/data-table.tsx`:

Add the import at the top:

```tsx
import Link from "next/link";
```

Extend `DataTableProps`:

```tsx
export interface DataTableProps<Row> {
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
  /**
   * Makes every row a selection link via a stretched overlay in the first
   * cell. Interactive content inside cells must add `relative` to its own
   * class list to stay clickable above the overlay.
   */
  rowHref?: (row: Row) => string;
  /** Accessible name for the row's selection link. Provide with rowHref. */
  rowLabel?: (row: Row) => string;
  /** The rowKey of the selected row; highlights it and sets aria-current. */
  selectedKey?: string | null;
}
```

Destructure `rowHref`, `rowLabel`, and `selectedKey` in the function signature, then replace the existing `<tbody>` row rendering (currently `rows.map((row) => (<tr key={rowKey(row)} className="transition-colors hover:bg-gray-50">…`) with:

```tsx
<tbody className="divide-y divide-gray-200">
  {rows.map((row) => {
    const key = rowKey(row);
    const selected = selectedKey != null && key === selectedKey;
    return (
      <tr
        key={key}
        className={cn(
          "transition-colors",
          rowHref && "relative",
          selected ? "bg-purple-50" : "hover:bg-gray-50",
        )}
      >
        {columns.map((column, columnIndex) => (
          <td
            key={column.id}
            className={cn(
              "px-4 py-3 text-[13px] text-gray-700 align-middle",
              column.align === "right" ? "text-right" : "text-left",
              column.secondary && "hidden lg:table-cell",
              column.className,
            )}
          >
            {rowHref && columnIndex === 0 ? (
              <Link
                href={rowHref(row)}
                scroll={false}
                aria-label={rowLabel?.(row) ?? "Select row"}
                aria-current={selected ? "true" : undefined}
                className="absolute inset-0"
              />
            ) : null}
            {column.cell(row)}
          </td>
        ))}
      </tr>
    );
  })}
</tbody>
```

Why this shape: the overlay is the **first child** of the first cell, so any cell content that is itself positioned (`relative`) paints above it in DOM order and stays independently clickable — no z-index dance. `scroll={false}` is D101; `position: relative` on `<tr>` is fine in all current browsers.

- [ ] **Step 2: Verify types and existing consumers**

Run: `npm run typecheck && npm run lint`
Expected: clean. All eight existing `DataTable` consumers compile untouched (all new props optional).

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/data-table.tsx
git commit -m "Add optional row selection to DataTable"
```

---

### Task 3: `/mentions` detail pane

**Files:**
- Modify: `src/components/mentions/mention-list-item.tsx` (add `scroll` prop)
- Create: `src/components/mentions/mention-detail-pane.tsx`
- Modify: `src/app/(app)/mentions/page.tsx`

**Interfaces:**
- Consumes: `resolveSelection` (Task 1); `MentionView` from `@/lib/view-models/mention`; `DetailPanel`/`DetailSection`/`DetailField` from `@/components/ui/detail-panel`; `ResponseDraft` from `@/domain`.
- Produces: `MentionDetailPane({ mention: MentionView; drafts: ResponseDraft[]; className?: string })` — no later task depends on it.

- [ ] **Step 1: Add the `scroll` prop to `MentionListItem`**

In `src/components/mentions/mention-list-item.tsx`, add to the props interface:

```tsx
export interface MentionListItemProps {
  mention: MentionView;
  href?: string;
  selected?: boolean;
  /** Forwarded to the link. Selection links pass false to stop the scroll-to-top jump. */
  scroll?: boolean;
  /** Trims the row to title, source, and time for dense sidebars. */
  density?: "comfortable" | "compact";
}
```

Destructure `scroll` in the component signature and forward it on the `Link`:

```tsx
<Link
  href={href ?? mention.workspacePath}
  scroll={scroll}
  aria-current={selected ? "true" : undefined}
```

(`scroll={undefined}` is Next's default `true`, so existing consumers are unchanged.)

- [ ] **Step 2: Create the pane component**

```tsx
// src/components/mentions/mention-detail-pane.tsx
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import {
  DetailField,
  DetailPanel,
  DetailSection,
} from "@/components/ui/detail-panel";
import { RatingStars } from "@/components/ui/rating-stars";
import { PlatformGlyph } from "@/components/ui/source-badge";
import {
  MentionStatusBadge,
  RecommendedActionBadge,
  ResponseStatusBadge,
  RiskBadge,
  SentimentBadge,
} from "@/components/ui/status-badge";
import { formatRelativeLong, formatRelativeShort } from "@/lib/format";
import { PLATFORM_LABELS, RESPONSE_TYPE_LABELS } from "@/lib/labels";
import type { MentionView } from "@/lib/view-models/mention";
import type { ResponseDraft } from "@/domain";

export interface MentionDetailPaneProps {
  mention: MentionView;
  /** Existing drafts for this mention; the pane lists them, never creates one. */
  drafts: ResponseDraft[];
  className?: string;
}

/**
 * The right half of the mentions split view.
 *
 * Read-only by design: triage happens here, acting happens in the source's
 * workspace, which stays one click away in the header and footer (D100).
 */
export function MentionDetailPane({
  mention,
  drafts,
  className,
}: MentionDetailPaneProps) {
  const hasAnalysis =
    mention.recommendedAction !== null ||
    mention.topics.length > 0 ||
    mention.summary !== null;

  return (
    <DetailPanel
      className={className}
      label="Selected mention"
      header={
        <div className="flex items-center gap-3">
          <PlatformGlyph platform={mention.platform} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-gray-950">
              {mention.title}
            </p>
            <p className="truncate text-[12.5px] text-gray-500">
              {PLATFORM_LABELS[mention.platform]} • {mention.contextLabel} •{" "}
              {formatRelativeLong(mention.publishedAt)}
            </p>
          </div>
          <Link
            href={mention.workspacePath}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-purple-600 hover:underline"
          >
            Open workspace
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      }
      footer={
        <Link
          href={mention.workspacePath}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-purple-600 bg-purple-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-purple-500"
        >
          Open workspace
          <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2.5">
          <Avatar
            initials={mention.authorInitials}
            name={mention.authorName}
            size="xs"
          />
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-gray-700">
              {mention.authorName}
            </p>
            <p className="mt-1 text-[13.5px] leading-relaxed whitespace-pre-line text-gray-950">
              {mention.content}
            </p>
          </div>
        </div>

        <DetailSection title="AI analysis">
          {hasAnalysis ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <SentimentBadge sentiment={mention.sentiment} />
                <RiskBadge risk={mention.riskLevel} />
                {mention.recommendedAction ? (
                  <RecommendedActionBadge action={mention.recommendedAction} />
                ) : null}
              </div>
              {mention.topics.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {mention.topics.map((topic) => (
                    <li
                      key={topic}
                      className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[12px] text-gray-700"
                    >
                      {topic}
                    </li>
                  ))}
                </ul>
              ) : null}
              {mention.summary ? (
                <p className="text-[12.5px] text-gray-700">{mention.summary}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-[12.5px] text-gray-500">
              Not analysed yet. Analysis runs from the panel above the queue.
            </p>
          )}
        </DetailSection>

        <DetailSection title="Details">
          <dl className="grid grid-cols-2 gap-3">
            <DetailField label="Location">{mention.locationLabel}</DetailField>
            <DetailField label="Status">
              <MentionStatusBadge status={mention.status} />
            </DetailField>
            {mention.rating !== null ? (
              <DetailField label="Rating">
                <RatingStars rating={mention.rating} />
              </DetailField>
            ) : null}
          </dl>
        </DetailSection>

        {drafts.length > 0 ? (
          <DetailSection title="Responses">
            <ul className="flex flex-col gap-2">
              {drafts.map((draft) => (
                <li
                  key={draft.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2"
                >
                  <span className="text-[12.5px] text-gray-700">
                    {RESPONSE_TYPE_LABELS[draft.responseType]}
                  </span>
                  <span className="flex items-center gap-2">
                    <ResponseStatusBadge status={draft.status} />
                    <span className="text-[12px] text-gray-400">
                      {formatRelativeShort(draft.updatedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </DetailSection>
        ) : null}
      </div>
    </DetailPanel>
  );
}
```

- [ ] **Step 3: Wire the page**

In `src/app/(app)/mentions/page.tsx`:

Add imports:

```tsx
import { MentionDetailPane } from "@/components/mentions/mention-detail-pane";
import { resolveSelection } from "@/lib/selection";
```

Remove the now-unused `SectionPlaceholder` import.

Change the component signature (searchParams is a Promise in Next 16 — same pattern as `src/app/(app)/integrations/page.tsx:55-57`):

```tsx
interface MentionsPageProps {
  searchParams: Promise<{ mention?: string }>;
}

export default async function MentionsPage({ searchParams }: MentionsPageProps) {
  const { mention: mentionParam } = await searchParams;
```

After `views` is built, resolve the selection and load its drafts:

```tsx
  const selected = resolveSelection(views, mentionParam, (view) => view.id);
  const selectedDrafts = selected
    ? await dataSource.responseDrafts.list(scope, { mentionId: selected.id })
    : [];
```

In the queue list, make rows select in-page (D100, D101):

```tsx
{views.map((mention) => (
  <MentionListItem
    key={mention.id}
    mention={mention}
    href={`/mentions?mention=${mention.id}`}
    selected={mention.id === selected?.id}
    scroll={false}
  />
))}
```

Replace the `SectionPlaceholder` block (`src/app/(app)/mentions/page.tsx:176-181`) with:

```tsx
{selected ? (
  <MentionDetailPane
    className="xl:col-span-7 xl:max-h-[calc(100dvh-16rem)]"
    mention={selected}
    drafts={selectedDrafts}
  />
) : (
  <Card className="xl:col-span-7">
    <EmptyState
      title="Nothing selected"
      description="Once a source is connected and synced, select a mention to see its details."
      size="sm"
    />
  </Card>
)}
```

(`EmptyState` and `Card` are already imported by the page.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all clean; no test regressions.

Then confirm in the running app (`npm run dev`): `/mentions` shows the pane with the first mention; clicking another row swaps the pane without scrolling to the top; `?mention=<stale-uuid>` falls back to the first item; "Open workspace" reaches the source workspace.

- [ ] **Step 5: Commit**

```bash
git add src/components/mentions/mention-list-item.tsx src/components/mentions/mention-detail-pane.tsx "src/app/(app)/mentions/page.tsx"
git commit -m "Wire the mentions split view detail pane"
```

---

### Task 4: `/responses` detail pane

**Files:**
- Create: `src/lib/view-models/response.ts`
- Test: `tests/response-view-model.test.ts`
- Create: `src/components/responses/response-detail-pane.tsx`
- Modify: `src/app/(app)/responses/page.tsx`

**Interfaces:**
- Consumes: `resolveSelection` (Task 1); `DataTable` `rowHref`/`rowLabel`/`selectedKey` (Task 2); `ResponseComposer({ draft, publishing, canDecide })` (existing, embedded unmodified per D103); `mentions.getDetail(scope, mentionId)` and `responseDrafts.listApprovals(scope, draftId)` (existing repository methods); `resolvePublishingMode` from `@/domain`; `TimelineEntry` from `@/components/ui/timeline`.
- Produces:
  - `hasHumanEdit(draft: ResponseDraft): boolean`
  - `approvalTimelineEntries(approvals: Approval[], namesById: Map<string, string>): TimelineEntry[]`
  - `ResponseDetailPane({ draft, mention, publishing, canDecide, assigneeName, approvalEntries, className? })`

- [ ] **Step 1: Write the failing view-model tests**

```ts
// tests/response-view-model.test.ts
import { describe, expect, it } from "vitest";
import {
  approvalTimelineEntries,
  hasHumanEdit,
} from "@/lib/view-models/response";
import type { Approval, ResponseDraft } from "@/domain";

const baseDraft = {
  id: "d1",
  organizationId: "org1",
  mentionId: "m1",
  responseType: "public_reply",
  draftText: "Thank you for the kind words.",
  finalText: null,
  status: "draft",
  generatedBy: "ai",
  generationProvider: null,
  generationModel: null,
  promptVersion: null,
  brandVoiceVersion: null,
  policyVersion: null,
  assignedUserId: null,
  approvedByUserId: null,
  approvedAt: null,
  publishedAt: null,
  externalResponseId: null,
  publicationError: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
} as ResponseDraft;

const baseApproval = {
  id: "a1",
  organizationId: "org1",
  responseDraftId: "d1",
  requestedByUserId: "u1",
  assignedToUserId: "u2",
  status: "approved",
  decisionNote: "Reads well.",
  decidedAt: "2026-08-02T09:00:00.000Z",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
} as Approval;

describe("hasHumanEdit", () => {
  it("is false while finalText is unset", () => {
    expect(hasHumanEdit(baseDraft)).toBe(false);
  });

  it("is false when finalText matches the draft", () => {
    expect(
      hasHumanEdit({ ...baseDraft, finalText: baseDraft.draftText }),
    ).toBe(false);
  });

  it("is true when a person changed the text", () => {
    expect(hasHumanEdit({ ...baseDraft, finalText: "Edited." })).toBe(true);
  });
});

describe("approvalTimelineEntries", () => {
  const names = new Map([["u2", "Dana Kim"]]);

  it("maps an approval to a timeline entry with the decider's name", () => {
    const [entry] = approvalTimelineEntries([baseApproval], names);
    expect(entry?.id).toBe("a1");
    expect(entry?.tone).toBe("green");
    expect(entry?.meta).toContain("Dana Kim");
    expect(entry?.meta).toContain("Reads well.");
  });

  it("uses createdAt while the approval is undecided and tones it amber", () => {
    const [entry] = approvalTimelineEntries(
      [{ ...baseApproval, status: "pending", decidedAt: null, decisionNote: null }],
      names,
    );
    expect(entry?.tone).toBe("amber");
    expect(entry?.timestamp.length).toBeGreaterThan(0);
  });

  it("omits meta when there is no name and no note", () => {
    const [entry] = approvalTimelineEntries(
      [{ ...baseApproval, assignedToUserId: null, decisionNote: null }],
      names,
    );
    expect(entry?.meta).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/response-view-model.test.ts`
Expected: FAIL — cannot resolve `@/lib/view-models/response`.

- [ ] **Step 3: Write the view-model module**

```ts
// src/lib/view-models/response.ts
import type { TimelineEntry, TimelineTone } from "@/components/ui/timeline";
import { formatDateTime } from "@/lib/format";
import { APPROVAL_STATUS_LABELS } from "@/lib/labels";
import type { Approval, ApprovalStatus, ResponseDraft } from "@/domain";

/** True when a person changed the model's text before it went out. */
export function hasHumanEdit(draft: ResponseDraft): boolean {
  return draft.finalText !== null && draft.finalText !== draft.draftText;
}

const APPROVAL_TONES: Record<ApprovalStatus, TimelineTone> = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  canceled: "neutral",
};

/**
 * Approvals as timeline entries.
 *
 * An undecided approval has no `decidedAt`, so the entry timestamps when it
 * was requested — the honest reading of "what happened when".
 */
export function approvalTimelineEntries(
  approvals: Approval[],
  namesById: Map<string, string>,
): TimelineEntry[] {
  return approvals.map((approval) => {
    const deciderName = approval.assignedToUserId
      ? (namesById.get(approval.assignedToUserId) ?? null)
      : null;
    const meta = [deciderName, approval.decisionNote]
      .filter((part): part is string => part !== null)
      .join(" — ");

    return {
      id: approval.id,
      title: APPROVAL_STATUS_LABELS[approval.status],
      meta: meta.length > 0 ? meta : undefined,
      timestamp: formatDateTime(approval.decidedAt ?? approval.createdAt),
      tone: APPROVAL_TONES[approval.status],
    };
  });
}
```

Check that `TimelineTone` is exported from `@/components/ui/timeline` (it is: `export type TimelineTone`) and that `ApprovalStatus` is re-exported from `@/domain`; if `@/domain` does not re-export it, import it from `@/domain/enums` instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/response-view-model.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit the view model**

```bash
git add src/lib/view-models/response.ts tests/response-view-model.test.ts
git commit -m "Add response detail view-model helpers"
```

- [ ] **Step 6: Create the pane component**

```tsx
// src/components/responses/response-detail-pane.tsx
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ResponseComposer } from "@/components/responses/response-composer";
import {
  DetailField,
  DetailPanel,
  DetailSection,
} from "@/components/ui/detail-panel";
import { Timeline, type TimelineEntry } from "@/components/ui/timeline";
import { formatDateTime, formatRelativeShort } from "@/lib/format";
import { GENERATED_BY_LABELS, RESPONSE_TYPE_LABELS } from "@/lib/labels";
import { hasHumanEdit } from "@/lib/view-models/response";
import { excerptFrom, workspacePathFor } from "@/lib/view-models/mention";
import type { Mention, PublishingMode, ResponseDraft } from "@/domain";

export interface ResponseDetailPaneProps {
  draft: ResponseDraft;
  /** Undefined when the mention behind the draft no longer exists. */
  mention: Mention | undefined;
  publishing: PublishingMode;
  canDecide: boolean;
  assigneeName: string | null;
  approvalEntries: TimelineEntry[];
  className?: string;
}

/**
 * The detail half of the responses library.
 *
 * Approve/reject runs through the embedded composer and its audited server
 * action; everything else here is a read. Publishing metadata renders
 * honestly — publishing is not built, and the pane says so (D104).
 */
export function ResponseDetailPane({
  draft,
  mention,
  publishing,
  canDecide,
  assigneeName,
  approvalEntries,
  className,
}: ResponseDetailPaneProps) {
  return (
    <DetailPanel className={className} label="Selected response">
      <div className="flex flex-col gap-4">
        <DetailSection title="Original mention">
          {mention ? (
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12.5px] text-gray-700">
                <span className="font-medium text-gray-950">
                  {mention.authorName ?? "Unknown author"}
                </span>{" "}
                — {excerptFrom(mention.content, 180)}
              </p>
              <Link
                href={workspacePathFor(mention)}
                className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-purple-600 hover:underline"
              >
                Open workspace
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          ) : (
            <p className="text-[12.5px] text-gray-400">Mention unavailable</p>
          )}
        </DetailSection>

        <DetailSection title="Response">
          <ResponseComposer
            draft={draft}
            publishing={publishing}
            canDecide={canDecide}
          />
        </DetailSection>

        {hasHumanEdit(draft) ? (
          <DetailSection title="Original AI draft">
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] whitespace-pre-line text-gray-700">
              {draft.draftText}
            </p>
          </DetailSection>
        ) : null}

        <DetailSection title="Details">
          <dl className="grid grid-cols-2 gap-3">
            <DetailField label="Type">
              {RESPONSE_TYPE_LABELS[draft.responseType]}
            </DetailField>
            <DetailField label="Author">
              {GENERATED_BY_LABELS[draft.generatedBy]}
            </DetailField>
            <DetailField label="Assigned to">
              {assigneeName ?? <span className="text-gray-400">Unassigned</span>}
            </DetailField>
            <DetailField label="Updated">
              {formatRelativeShort(draft.updatedAt)}
            </DetailField>
          </dl>
        </DetailSection>

        <DetailSection title="Approvals">
          {approvalEntries.length > 0 ? (
            <Timeline entries={approvalEntries} />
          ) : (
            <p className="text-[12.5px] text-gray-500">No approvals yet.</p>
          )}
        </DetailSection>

        <DetailSection title="Publishing">
          {draft.publishedAt ? (
            <dl className="grid grid-cols-2 gap-3">
              <DetailField label="Published">
                {formatDateTime(draft.publishedAt)}
              </DetailField>
              <DetailField label="External id">
                {draft.externalResponseId ?? "—"}
              </DetailField>
            </dl>
          ) : (
            <p className="text-[12.5px] text-gray-500">
              Not published. Lia cannot post replies to sources yet; approved
              text is published by a person.
            </p>
          )}
        </DetailSection>
      </div>
    </DetailPanel>
  );
}
```

- [ ] **Step 7: Wire the page**

In `src/app/(app)/responses/page.tsx`:

Add imports; remove the `SectionPlaceholder` import:

```tsx
import { ResponseDetailPane } from "@/components/responses/response-detail-pane";
import { approvalTimelineEntries } from "@/lib/view-models/response";
import { resolveSelection } from "@/lib/selection";
import { can } from "@/lib/auth/permissions";
import { resolvePublishingMode } from "@/domain";
```

Switch from scope-only to full context (the page needs the role for `canDecide`) — replace `getOrganizationScope` usage:

```tsx
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
// …
export default async function ResponsesPage({ searchParams }: ResponsesPageProps) {
  const { selected: selectedParam } = await searchParams;
  const { scope, role } = await getOrganizationContext();
```

with

```tsx
interface ResponsesPageProps {
  searchParams: Promise<{ selected?: string }>;
}
```

After `rows` is built, resolve the selection and load the pane's two extra reads:

```tsx
  const selectedRow = resolveSelection(rows, selectedParam, (row) => row.draft.id);

  const [approvals, selectedDetail] = selectedRow
    ? await Promise.all([
        dataSource.responseDrafts.listApprovals(scope, selectedRow.draft.id),
        dataSource.mentions.getDetail(scope, selectedRow.draft.mentionId),
      ])
    : [[], null];

  const publishing = selectedDetail?.connection
    ? resolvePublishingMode(selectedDetail.connection.capabilities)
    : "unavailable";
```

Update the mention-title cell in `COLUMNS` so its link stays clickable above the row overlay — add `relative` to its class list:

```tsx
        <Link
          href={workspacePathFor(row.mention)}
          className="relative font-medium text-gray-950 hover:text-purple-600 hover:underline"
        >
```

Pass the new props to `DataTable`:

```tsx
        <DataTable
          caption="Response drafts and published responses"
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.draft.id}
          rowHref={(row) => `/responses?selected=${row.draft.id}`}
          rowLabel={(row) =>
            row.mention
              ? (row.mention.title ?? excerptFrom(row.mention.content, 60))
              : "Response draft"
          }
          selectedKey={selectedRow?.draft.id ?? null}
          emptyTitle="No responses yet"
          emptyDescription="Drafts appear here as soon as anyone writes one."
        />
```

Replace the `SectionPlaceholder` block (`src/app/(app)/responses/page.tsx:197-201`) with (D99 — omit the pane when there is nothing to select):

```tsx
      {selectedRow ? (
        <ResponseDetailPane
          draft={selectedRow.draft}
          mention={selectedRow.mention}
          publishing={publishing}
          canDecide={can(role, "response.decide")}
          assigneeName={selectedRow.assigneeName}
          approvalEntries={approvalTimelineEntries(approvals, namesById)}
        />
      ) : null}
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: clean.

In the app: `/responses` shows the first draft's pane; clicking a row selects it (highlighted, URL updates, no scroll jump); the mention-title cell still opens the workspace; approve/reject works from the embedded composer; publishing section says "Not published" for seed drafts without `publishedAt`.

- [ ] **Step 9: Commit**

```bash
git add src/components/responses/response-detail-pane.tsx "src/app/(app)/responses/page.tsx"
git commit -m "Wire the responses detail pane with embedded composer"
```

---

### Task 5: `/escalations` detail pane

**Files:**
- Create: `src/lib/view-models/escalation.ts`
- Test: `tests/escalation-view-model.test.ts`
- Create: `src/components/escalations/escalation-detail-pane.tsx`
- Modify: `src/app/(app)/escalations/page.tsx`

**Interfaces:**
- Consumes: `resolveSelection` (Task 1); `DataTable` selection props (Task 2); `auditEvents.list(scope, { entityType: "escalation", entityId })` (existing — `AuditEventFilter` supports both fields); `AUDIT_EVENT_LABELS` from `@/lib/labels`; `Timeline`.
- Produces:
  - `escalationTimelineEntries(events: AuditEvent[], namesById: Map<string, string>): TimelineEntry[]`
  - `EscalationDetailPane({ escalation, mention, ownerName, timelineEntries, className? })`

- [ ] **Step 1: Write the failing view-model test**

```ts
// tests/escalation-view-model.test.ts
import { describe, expect, it } from "vitest";
import { escalationTimelineEntries } from "@/lib/view-models/escalation";
import type { AuditEvent } from "@/domain";

const baseEvent = {
  id: "e1",
  organizationId: "org1",
  actorUserId: "u1",
  actorType: "user",
  eventType: "escalation.status_changed",
  entityType: "escalation",
  entityId: "esc1",
  previousState: { status: "open" },
  newState: { status: "resolved" },
  metadata: {},
  occurredAt: "2026-08-03T15:00:00.000Z",
} as AuditEvent;

describe("escalationTimelineEntries", () => {
  const names = new Map([["u1", "Riley Otero"]]);

  it("maps an event to a titled, timestamped entry with the actor's name", () => {
    const [entry] = escalationTimelineEntries([baseEvent], names);
    expect(entry?.id).toBe("e1");
    expect(entry?.title).toBe("Escalation status changed");
    expect(entry?.meta).toBe("Riley Otero");
    expect(entry?.timestamp.length).toBeGreaterThan(0);
  });

  it("falls back to the humanized actor type when there is no person", () => {
    const [entry] = escalationTimelineEntries(
      [{ ...baseEvent, actorUserId: null, actorType: "system" }],
      names,
    );
    expect(entry?.meta).toBe("System");
  });

  it("tones assignment purple and other events neutral", () => {
    const [assigned] = escalationTimelineEntries(
      [{ ...baseEvent, eventType: "escalation.assigned" }],
      names,
    );
    const [changed] = escalationTimelineEntries([baseEvent], names);
    expect(assigned?.tone).toBe("purple");
    expect(changed?.tone).toBe("neutral");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/escalation-view-model.test.ts`
Expected: FAIL — cannot resolve `@/lib/view-models/escalation`.

- [ ] **Step 3: Write the view-model module**

```ts
// src/lib/view-models/escalation.ts
import type { TimelineEntry, TimelineTone } from "@/components/ui/timeline";
import { formatDateTime, humanize } from "@/lib/format";
import { AUDIT_EVENT_LABELS } from "@/lib/labels";
import type { AuditEvent } from "@/domain";

const EVENT_TONES: Partial<Record<AuditEvent["eventType"], TimelineTone>> = {
  "escalation.created_from_analysis": "red",
  "escalation.assigned": "purple",
};

/**
 * An escalation's audit trail as timeline entries.
 *
 * Titles come from the shared audit vocabulary so the pane can never invent
 * an event name the trail does not use.
 */
export function escalationTimelineEntries(
  events: AuditEvent[],
  namesById: Map<string, string>,
): TimelineEntry[] {
  return events.map((event) => ({
    id: event.id,
    title: AUDIT_EVENT_LABELS[event.eventType],
    meta: event.actorUserId
      ? (namesById.get(event.actorUserId) ?? humanize(event.actorType))
      : humanize(event.actorType),
    timestamp: formatDateTime(event.occurredAt),
    tone: EVENT_TONES[event.eventType] ?? "neutral",
  }));
}
```

Check `humanize("system")` returns "System" (`src/lib/format.ts:133`); if it lowercases or differs, adjust the test's expectation to the actual output — the contract is "a readable word", not a specific casing rule.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/escalation-view-model.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit the view model**

```bash
git add src/lib/view-models/escalation.ts tests/escalation-view-model.test.ts
git commit -m "Add escalation timeline view-model"
```

- [ ] **Step 6: Create the pane component**

```tsx
// src/components/escalations/escalation-detail-pane.tsx
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  DetailField,
  DetailPanel,
  DetailSection,
} from "@/components/ui/detail-panel";
import {
  EscalationStatusBadge,
  RiskBadge,
} from "@/components/ui/status-badge";
import { Timeline, type TimelineEntry } from "@/components/ui/timeline";
import { formatDateTime, formatSlaRemaining } from "@/lib/format";
import { ESCALATION_CATEGORY_LABELS } from "@/lib/labels";
import { excerptFrom, workspacePathFor } from "@/lib/view-models/mention";
import type { Escalation, Mention } from "@/domain";

export interface EscalationDetailPaneProps {
  escalation: Escalation;
  /** Undefined when the mention behind the case no longer exists. */
  mention: Mention | undefined;
  ownerName: string | null;
  timelineEntries: TimelineEntry[];
  className?: string;
}

/**
 * The detail half of the escalations centre. Read-only in this pass (D105):
 * status and assignment changes have no server actions yet, and the pane
 * must not invent authority the backend does not have.
 */
export function EscalationDetailPane({
  escalation,
  mention,
  ownerName,
  timelineEntries,
  className,
}: EscalationDetailPaneProps) {
  const sla = escalation.dueAt ? formatSlaRemaining(escalation.dueAt) : null;

  return (
    <DetailPanel
      className={className}
      label="Selected case"
      header={
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-[14px] font-semibold text-gray-950">
            {escalation.title}
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            <RiskBadge risk={escalation.severity} short />
            <EscalationStatusBadge status={escalation.status} />
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <DetailSection title="Case overview">
          {escalation.summary ? (
            <p className="text-[12.5px] leading-relaxed text-gray-700">
              {escalation.summary}
            </p>
          ) : null}
          <dl className="mt-2.5 grid grid-cols-2 gap-3">
            <DetailField label="Category">
              {ESCALATION_CATEGORY_LABELS[escalation.category]}
            </DetailField>
            <DetailField label="Owner">
              {ownerName ?? <span className="text-gray-400">Unassigned</span>}
            </DetailField>
            <DetailField label="SLA">
              {sla ? (
                <span
                  className={
                    sla.overdue ? "font-semibold text-red-600" : "text-gray-700"
                  }
                >
                  {sla.label}
                </span>
              ) : (
                <span className="text-gray-400">No deadline</span>
              )}
            </DetailField>
            <DetailField label="Raised">
              {formatDateTime(escalation.createdAt)}
            </DetailField>
          </dl>
        </DetailSection>

        {escalation.resolutionNote ? (
          <DetailSection title="Resolution">
            <p className="text-[12.5px] leading-relaxed text-gray-700">
              {escalation.resolutionNote}
            </p>
            {escalation.resolvedAt ? (
              <p className="mt-1 text-[12px] text-gray-400">
                Resolved {formatDateTime(escalation.resolvedAt)}
              </p>
            ) : null}
          </DetailSection>
        ) : null}

        <DetailSection title="Source evidence">
          {mention ? (
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12.5px] text-gray-700">
                <span className="font-medium text-gray-950">
                  {mention.authorName ?? "Unknown author"}
                </span>{" "}
                — {excerptFrom(mention.content, 180)}
              </p>
              <Link
                href={workspacePathFor(mention)}
                className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-purple-600 hover:underline"
              >
                Open workspace
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          ) : (
            <p className="text-[12.5px] text-gray-400">Mention unavailable</p>
          )}
        </DetailSection>

        <DetailSection title="Activity">
          {timelineEntries.length > 0 ? (
            <Timeline entries={timelineEntries} />
          ) : (
            <p className="text-[12.5px] text-gray-500">
              No recorded activity yet.
            </p>
          )}
        </DetailSection>
      </div>
    </DetailPanel>
  );
}
```

- [ ] **Step 7: Wire the page**

In `src/app/(app)/escalations/page.tsx`:

Add imports; remove the `SectionPlaceholder` import:

```tsx
import { EscalationDetailPane } from "@/components/escalations/escalation-detail-pane";
import { escalationTimelineEntries } from "@/lib/view-models/escalation";
import { resolveSelection } from "@/lib/selection";
```

Change the signature:

```tsx
interface EscalationsPageProps {
  searchParams: Promise<{ selected?: string }>;
}

export default async function EscalationsPage({ searchParams }: EscalationsPageProps) {
  const { selected: selectedParam } = await searchParams;
```

After `rows` is built:

```tsx
  const selectedRow = resolveSelection(
    rows,
    selectedParam,
    (row) => row.escalation.id,
  );

  const auditEvents = selectedRow
    ? await dataSource.auditEvents.list(scope, {
        entityType: "escalation",
        entityId: selectedRow.escalation.id,
      })
    : [];
```

Update the Case cell's `Link` in `COLUMNS` to add `relative` (same reason as Task 4):

```tsx
        <Link
          href={workspacePathFor(row.mention)}
          className="relative font-medium text-gray-950 hover:text-purple-600 hover:underline"
        >
```

Pass the selection props to `DataTable`:

```tsx
        <DataTable
          caption="Escalations by severity and due date"
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.escalation.id}
          rowHref={(row) => `/escalations?selected=${row.escalation.id}`}
          rowLabel={(row) => row.escalation.title}
          selectedKey={selectedRow?.escalation.id ?? null}
          emptyTitle="No escalations"
          emptyDescription="Nothing has been escalated. High-risk mentions arrive here automatically."
        />
```

Replace the `SectionPlaceholder` block (`src/app/(app)/escalations/page.tsx:171-175`) with:

```tsx
      {selectedRow ? (
        <EscalationDetailPane
          escalation={selectedRow.escalation}
          mention={selectedRow.mention}
          ownerName={selectedRow.assigneeName}
          timelineEntries={escalationTimelineEntries(auditEvents, namesById)}
        />
      ) : null}
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: clean.

In the app: `/escalations` shows the first case's pane; row clicks select; overdue SLA renders red; the activity section shows audit events for seeded escalations or "No recorded activity yet."

- [ ] **Step 9: Commit**

```bash
git add src/components/escalations/escalation-detail-pane.tsx "src/app/(app)/escalations/page.tsx"
git commit -m "Wire the escalations detail pane with audit timeline"
```

---

### Task 6: Full verification and ledger update

**Files:**
- Modify: `docs/architecture/current-state.md`

**Interfaces:** none — closes the loop.

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, typecheck, all tests, and `next build` pass.

- [ ] **Step 2: Update the current-state ledger**

`docs/architecture/current-state.md` is the honest ledger of what is real. Find its claims that the selected-item panes are placeholders:

Run: `grep -n "Selected mention\|Selected response\|Selected case\|SectionPlaceholder" docs/architecture/current-state.md`

For each hit describing the mentions/responses/escalations detail panes as not built, update the sentence to state what is now true, in the document's voice. The substance to record: the three panes render from a `?mention=`/`?selected=` search param resolved server-side with stale-param fallback; the responses pane embeds the existing composer (approve/reject only — save and publish remain disabled); the escalations pane is read-only and shows the case's audit trail. Do not touch claims about other placeholders (insights, settings, rules, workspace sub-panels) — those remain true.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/current-state.md
git commit -m "Record the wired detail panes in the current-state ledger"
```
