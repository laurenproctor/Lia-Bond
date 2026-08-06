# Detail panes for mentions, responses, and escalations

Design document. Written 2026-08-06, before implementation.

## Summary

Replace the three "Selected item" `SectionPlaceholder` cards — the right pane
on `/mentions`, the pane under the table on `/responses`, and the pane under
the table on `/escalations` — with working detail panes built on the existing,
currently consumerless `DetailPanel` component. Selection is server-rendered
from a URL search param; clicking a row re-renders the page with that item in
the pane.

No new tables, no new repository methods, no new server actions. Every pane is
assembled from data the pages already load plus at most one extra read that
already exists (`responseDrafts.listApprovals`, `auditEvents.list`).

## What exists and is reused

- `DetailPanel` / `DetailSection` / `DetailField`
  (`src/components/ui/detail-panel.tsx`) — built for exactly this, zero
  consumers today. `DetailPanel` documents itself as "the right-hand half of
  every split view".
- `MentionListItem` already accepts `href` and `selected` props built for
  split-view use; both are unused.
- `toMentionView` already carries everything the mentions pane shows:
  full content, sentiment, risk, topics, recommended action, summary, rating,
  location and context labels, `workspacePath`.
- `workspacePathFor()` already emits `/mentions?mention=<id>` for source types
  with no dedicated workspace. Those links currently point at a page that
  ignores the param.
- `Timeline` (one consumer), `EmptyState`, status badges, `ResponseComposer`
  with its working approve/reject server actions.

## Decisions taken

| # | Decision | Reason |
| --- | --- | --- |
| D96 | Selection is a URL search param read by the server page, not client state | Matches server-components-first; URLs are shareable; the pane's data is resolved with the same scoped repository reads as the rest of the page. At 50-row page size the extra round trip is not worth trading for shipping every row's full detail to the client. |
| D97 | `/mentions` uses `?mention=`, the table pages use `?selected=` | `workspacePathFor()` has emitted `/mentions?mention=<id>` since workflow 02. Adopting that name makes existing links work instead of introducing a second competing param. The table pages have no such precedent and share `?selected=`. |
| D98 | A missing or stale param falls back to the first item; it never 404s | A stale bookmark or a deleted record should degrade to "the page as if freshly opened", not an error page. The lists are already sorted newest/worst-first, so the first item is the right default focus. |
| D99 | Empty list: `/mentions` shows an `EmptyState` in the pane; the table pages omit the pane | The mentions grid reserves the pane's columns, so an empty hole needs content. On the table pages the pane sits below the table and can simply not render — the table's own empty state already explains the situation. |
| D100 | Queue rows on `/mentions` select in-page; the workspace moves to an explicit "Open workspace" link in the pane | The queue's job is triage; the workspace's job is acting. Clicking through the queue should never lose the reader's place in the list — which is the documented reason `DetailPanel` scrolls independently. |
| D101 | Selection links pass `scroll={false}` | Selecting a row must not jump the viewport to the top; the pane swap is the feedback. |
| D102 | `DataTable` gains optional `rowHref(row)` and `selectedKey` props | The two table pages need row-level selection and a highlight. Extending the shared primitive once beats hand-rolling row links per page, and both props are optional so existing consumers are untouched. |
| D103 | The responses pane embeds `ResponseComposer` only if it drops in without modification; otherwise the pane is read-only | Approve/reject from the pane is valuable and the actions exist, but reworking the composer is sub-project 2's territory (its Save-draft defect is known and out of scope here). The pane must not fork the composer. |
| D104 | Publishing metadata renders honestly as "Not published" | Publishing does not exist (capability is hard-coded `not_configured`). The pane states that plainly rather than showing empty fields that imply a wiring gap. |
| D105 | The escalations pane is read-only in this pass | Status/assignment mutations for escalations have no existing server actions. Creating them is rule-execution/escalation-workflow territory (implementation plan phase 6), not a pane-wiring change. |
| D106 | Selection resolution is a pure helper with unit tests, not inline page code | `resolveSelection(items, param)` — param match, stale-id fallback, empty list — is the same logic three times. One tested pure function keeps the three pages honest and the edge cases pinned. |

## Per-page design

### `/mentions`

Layout unchanged: queue card `xl:col-span-5`, pane `xl:col-span-7`.

- Page reads `searchParams.mention`; `resolveSelection(views, param)` picks the
  view. Rows render with an `href` of `/mentions?mention=<id>`,
  `selected={id === selectedId}`, and `scroll={false}`.
- Pane: `DetailPanel` with
  - **Header** — `PlatformGlyph`, author name and avatar initials, context
    label, published time, "Open workspace" link to `workspacePath`.
  - **Body** — full mention text (not the excerpt); "AI analysis"
    `DetailSection` (sentiment, risk, recommended-action badges, topics,
    summary) shown only when analysis exists, with a one-line "Not analysed
    yet" fallback; "Details" `DetailSection` of `DetailField`s (location,
    status, rating when review); "Responses" `DetailSection` listing this
    mention's drafts with `ResponseStatusBadge`, or omitted when none.
  - **Footer** — primary "Open workspace" link.
- The page already loads mentions, analyses, and locations. Drafts for the
  "Responses" section come from `responseDrafts.list(scope)` filtered by
  mention id — one added parallel read.

### `/responses`

Table full-width as today; pane replaces the placeholder below it.

- Page reads `searchParams.selected`; selection over the existing `rows`.
- `DataTable` gets a `rowHref` of `/responses?selected=<draft id>` and
  `selectedKey`. The mention-title cell keeps its workspace link.
- Pane sections: original mention (excerpt, author, workspace link); draft
  text; final text only when `finalText !== null && finalText !== draftText`,
  labelled as the human edit; details (`DetailField`s: type, generated by,
  status, assignee, updated); approvals history from
  `responseDrafts.listApprovals` rendered with `Timeline`; publishing
  metadata per D104.
- Composer embedding per D103, decided during implementation by reading the
  composer's props — not by modifying it.

### `/escalations`

Same table treatment as `/responses`.

- `rowHref` of `/escalations?selected=<escalation id>`.
- Pane sections: case overview (title, summary, category label, severity and
  status badges, SLA with the existing overdue treatment); source evidence
  (mention excerpt, author, workspace link, or "Mention unavailable");
  owner; activity timeline from `auditEvents.list` filtered to this
  escalation, rendered with `Timeline` — omitted if the audit filter cannot
  target one escalation without a repository change (checked during
  implementation; the pane ships without the timeline rather than growing the
  repository interface in this sub-project).

## Error handling

- Stale or missing selection param: first item (D98). Never `notFound()`.
- Empty lists: D99.
- A draft whose mention was deleted: the pane renders the draft sections and
  "Mention unavailable" for the source section, mirroring the table cell.

## Testing

TDD, in the existing node-environment vitest suite (no jsdom, matching D74's
precedent of testing pure modules rather than components):

- `resolveSelection` — match, stale id, missing param, empty list.
- Pane view-assembly helpers per page where logic exceeds pass-through —
  e.g. the responses pane's "final text differs" predicate and the mentions
  pane's drafts-for-mention filter.
- Existing route tests still pass (`searchParams` is additive).

## Out of scope

Filter and tab wiring (sub-project 4), composer save/publish (sub-project 2),
response generation (sub-project 3), escalation creation and mutation (phase
6), any repository interface change.
