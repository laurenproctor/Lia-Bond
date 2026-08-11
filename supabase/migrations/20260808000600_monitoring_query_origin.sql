-- ---------------------------------------------------------------------------
-- Monitoring-query origin
--
-- Step 2 of onboarding manages one organization-wide brand query, and step 3
-- may create one location query per newly mapped location. Both need to know
-- which persisted rows the wizard is responsible for, and until now the only
-- available identification was structural (the oldest org-wide brand query)
-- — workable for the single brand watch, but unable to distinguish "the
-- wizard already created this location's query" from "a person configured
-- this location deliberately". This column is that distinction.
--
-- Provenance, not behaviour: nothing in polling, gating, or budgeting reads
-- it. The onboarding services use it to be idempotent (never a second
-- onboarding row for the same location, never an edit to a row a person
-- created), and it is not writable through the public update input — a
-- query's origin is a fact about its creation.
-- ---------------------------------------------------------------------------

alter table public.monitoring_queries
  add column origin text not null default 'user'
    check (origin in ('user', 'onboarding'));

comment on column public.monitoring_queries.origin is
  'Who created the row: a person (user) or the setup wizard (onboarding). Provenance for idempotent onboarding writes; immutable through the public update path.';
