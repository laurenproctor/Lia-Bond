# Prompt 4 — Add Supabase persistence

Read `docs/data-model.md` and implement a Supabase-backed schema with migrations, row-level security, seed data, and typed database helpers.

Add organization tenancy and roles:
- Owner
- Admin
- Communications lead
- Location manager
- Approver
- Analyst
- Read-only

Replace mock data incrementally while keeping a fallback demo mode.

Implement audit events for consequential actions.

Do not add external platform integrations yet.
