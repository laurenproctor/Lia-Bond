# Prompt 2 — Build the core operating views

Using the existing shell and components, fully implement these routes with realistic mock data:

- `/overview`
- `/mentions`
- `/reviews/google/[id]`
- `/reddit/[id]`
- `/media/[id]`
- `/escalations`
- `/responses`

Use the corresponding reference images. Preserve the three-column workspace pattern where applicable.

Implement interactions for:
- Selecting rows and mentions
- Filtering and searching
- Switching status tabs
- Editing draft responses
- Regenerating mock drafts
- Approving, dismissing, escalating, and publishing through simulated state transitions
- Opening history, notes, and detail panels

Do not implement real API calls. State should be deterministic and local.

Run lint, type-check, and build. Fix all errors.
