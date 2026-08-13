# Brand voice autosave

Design document. Written 2026-08-06, before implementation.

> **Later amendment (2026-08-12).** The three modules below were promoted out
> of `brand-voice/` when the onboarding News configurator adopted autosave:
> `src/lib/autosave/status.ts`, `src/components/autosave/use-autosave.ts`,
> `src/components/autosave/save-status.tsx`. The hook gained `flush()` — send
> now and resolve on the answer — for the callers that have a moment autosave
> cannot cover on its own (closing a panel, leaving a wizard step). Every
> decision below still holds; only the paths moved. See `docs/onboarding.md`
> §7.2.

## Summary

Replace the brand voice screen's explicit Save with autosave, and show whether
the current state is saved, saving, unsaved, or failed.

The server action, service, repositories, and schema are unchanged. This is a
client-side change plus one pure module.

## Why the audit trail is the interesting part

`saveBrandVoice` writes a `brand_voice.updated` audit event and increments
`version` on every save that changes something. Today one tuning session is one
Save press: one event, `version` 1 → 2. Under autosave the same session — five
sliders and three phrases — becomes eight saves: eight events, `version` 1 → 9.

Merging those events server-side is not available. `audit_events` is
append-only by construction: the migrations grant no UPDATE or DELETE to
`authenticated`, deliberately, because an audit trail that can be amended is not
one. So the only lever is how aggressively the client coalesces before it sends.

The user's decision, recorded: **accept the extra events, coalesce well.** The
volume is the honest record of what happened, and `version` is an integer with
no ceiling. The real cost is a noisier trail, and it is worth the screen no
longer silently depending on somebody pressing a button.

## Decisions taken

| # | Decision | Reason |
| --- | --- | --- |
| D70 | Autosave replaces explicit save; Save and Discard are removed | With changes persisting themselves there is nothing to discard, and a Save button that is never the thing that saves is a lie about how the screen works. |
| D71 | Save on interaction end, then 800 ms idle | A drag is one decision, not forty `onChange` events. Committing on release matches what the control means; the idle window then coalesces a burst of separate edits into one request. |
| D72 | Exactly one request in flight; a change during a save re-fires after it returns | This is the client half of the concurrent-save race already recorded as a known gap. Autosave is precisely what would start triggering it regularly, so the client must not race itself. |
| D73 | No automatic retry | Autosave now surfaces validation failures — a phrase in both lists — as you type rather than on submit. Automatic retry would loop on them forever. Retry is a button. |
| D74 | The status rules live in a pure module, not in the hook | `vitest.config.mts` runs `environment: "node"` and the repo has no testing-library dependency. Testing a hook would mean adding jsdom and a dependency. Extracting the rules tests what is worth testing without changing the project's test setup. |
| D75 | Nothing renders until the first save | Showing "Saved" on arrival claims something that never happened. |
| D76 | `pending` is removed from the controls' `disabled` | Left in, every autosave would freeze the form mid-edit. This is the single most likely way to make the feature feel broken. |
| D77 | The status renders as the form's first row, not inside `PageHeader` | `PageHeader` is rendered by the server page while the state lives in the client form — the same cross-component problem that put Save in a sticky bar originally. A context provider for one string is not worth it; the row sits directly under the header and reads as part of it. |

## The status machine

`src/lib/brand-voice/autosave-status.ts` — pure, no React, no timers.

```text
hidden ──edit──▶ unsaved ──send──▶ saving ──ok────▶ saved
                    ▲                 │
                    │                 ├──fail──▶ failed
                    └──edit───────────┘              │
                                                  edit/retry
                                                     │
                                                     ▼
                                                  unsaved
```

States: `hidden | unsaved | saving | saved | failed`.

Two transitions carry the weight:

- **An edit during `saving` goes to `unsaved`, not back to `saving`.** The
  in-flight request no longer reflects what is on screen, so its success must
  not be reported as "Saved" for the newer state. The hook re-fires when it
  returns.
- **`failed` never transitions to `saved` without a successful send.** An edit
  after a failure moves to `unsaved`, so the screen never claims a save that a
  later request has not actually made.

Copy: `Saved`, `Saving…`, `Unsaved`, `Couldn't save`.

## Components

| Path | Status | Responsibility |
| --- | --- | --- |
| `src/lib/brand-voice/autosave-status.ts` | create | The pure state machine. |
| `src/components/brand-voice/use-autosave.ts` | create | Timer, request serialisation, calling the action. |
| `src/components/brand-voice/save-status.tsx` | create | Renders the status line. |
| `src/components/brand-voice/voice-form.tsx` | modify | Wires the hook; drops the sticky bar. |
| `src/components/brand-voice/axis-slider.tsx` | modify | Adds `onCommit`, fired on release. |

`PhraseEditor` needs no change: adding and removing a phrase are already
discrete, so its existing `onChange` is the commit.

## Behaviour details

**Sliders** keep firing `onChange` during the drag so the summary updates live,
and call `onCommit` on `pointerup`, `keyup`, and `blur`. Only `onCommit` starts
the save timer. `blur` is included because a slider changed by keyboard and then
tabbed away never receives `keyup` on the control.

**Phrase edits** call the same commit path immediately.

**The 800 ms timer** restarts on each commit, so a burst of edits sends once.

**On unload**, a `beforeunload` guard fires only while the status is `unsaved`
or `saving`, so the idle window cannot silently swallow the last edit.

**Accessibility**: the status line is `aria-live="polite"` so a change is
announced without interrupting. The error keeps its `role="alert"`.

## Error handling

A failure preserves the edits on screen, sets `failed`, and renders the existing
inline error with a Retry button. Field errors continue to surface on the
relevant phrase editor. Nothing is auto-retried (D73).

The read-only path is unchanged: a role without `brand_voice.update` gets
disabled controls, no status line, and no autosave.

## Testing

`tests/brand-voice-autosave.test.ts` — pure transitions:

- an edit from `hidden` produces `unsaved`
- a successful send produces `saved`
- **an edit during `saving` produces `unsaved`, and a later success for the
  stale request does not report `saved`**
- a failure produces `failed`, and an edit from `failed` produces `unsaved`
- `hidden` is only ever the initial state — nothing transitions back to it

The hook and the components are covered by typecheck and the production build,
as every other component in this codebase is.

Existing suites must not regress. Server rendering is re-verified, including the
read-only render.

## Non-goals

- Offline queueing or optimistic local persistence.
- Undo. Removed Discard is not replaced; the audit trail records what changed.
- Per-field saves. The action writes the whole profile; per-card status would be
  a granularity the request does not have.
- Any change to the action, service, repositories, schema, or migrations.

## Known consequences

- **A tuning session leaves several audit rows and several version bumps**
  instead of one. Accepted deliberately (D70); recorded in `current-state.md`.
- **The last 800 ms of editing is not durable** if the tab is killed rather than
  closed. The `beforeunload` guard covers closing, not `SIGKILL`.
- Interactive behaviour still has no browser coverage in this repo, so the
  timer, the guard, and the status transitions in situ remain verified by
  reading and by SSR only.
