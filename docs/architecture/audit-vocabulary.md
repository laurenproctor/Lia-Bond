# Audit vocabulary

How `audit_events.event_type` is constrained, why that constraint has broken
three times, and what would end the class rather than repair each instance.

## The mechanism

Permitted event names live in a check constraint,
`audit_events_known_event_type`, mirrored by `AUDIT_EVENT_TYPES` in
`src/domain/enums.ts` so a typo is a compile error rather than a bad row. The
sibling column `entity_type` is constrained differently — see
[Why the entity type never breaks](#why-the-entity-type-never-breaks).

Postgres has no statement for adding a value to a check constraint. So every
migration that introduces an event name drops the constraint and adds it back
with the **entire list restated** — 85 names as of `20260820000100`.

## Why it breaks

That restatement is safe on one line of history and hazardous the moment there
are two. Each branch restates the vocabulary as it stood on that branch.
Migrations apply in filename order. Whichever sorts last wins, and silently
drops the names the other added.

The failure has three properties that make it worse than it sounds:

- **It applies cleanly.** Both migrations are valid SQL. Nothing fails at
  deploy time.
- **It is invisible in either diff.** The defect exists only in the union, so
  no reviewer of either branch can see it.
- **The demo adapter cannot catch it.** That data source is a plain in-memory
  array enforcing no list at all, so tests pass. The first symptom is a `23514`
  on a real write, in Supabase mode, in production.

### The three occurrences

| Repair migration | What was dropped |
| --- | --- |
| `20260807000700_audit_vocabulary_merge` | 8 names — membership provisioning and brand voice, dropped by news monitoring |
| `20260818000300_yelp_audit_vocabulary` | 13 Reddit and publication names, caught pre-merge |
| `20260820000100_location_audit_vocabulary_after_yelp` | `location.updated`, `location.status_changed`, caught post-merge |

The name-count sequence across all vocabulary migrations is the signature: it
should grow monotonically, and at each of those three points it dips.

## What guards it today

**Detection** — `tests/audit-vocabulary-migrations.test.ts` parses every
migration with the real Postgres grammar (`libpg-query`, not a regex), replays
them in the order Supabase applies them, derives the constraint's *final*
permitted set, and compares it against `AUDIT_EVENT_TYPES` in both directions.
It caught all three. It reports by direction, because the two failures are not
equally urgent: a name the migrations reject while the application still emits
it is a production `23514`, whereas the reverse is only a constraint looser than
the type.

**Repair** — `npm run audit:vocabulary:generate` emits a new migration whose
list is derived from `AUDIT_EVENT_TYPES` rather than hand-merged from the
previous two vocabulary migrations. `tests/audit-vocabulary-generator.test.ts`
parses the generator's own output with the same grammar and asserts it permits
exactly the declared vocabulary, in order.

```
npm run audit:vocabulary:generate -- --slug reddit_audit_vocabulary \
  --reason "Add the Reddit monitoring and publication events."
```

### What the generator does not do

**It does not prevent the collision.** Two branches that each add events still
produce two migrations, each carrying only the union its own branch could see,
and the later filename still wins. What it removes is the chance of getting the
*repair* wrong: hand-merging is how a fix comes out correct for the branches its
author knew about and wrong for the next one, which is exactly how
`20260818000300` was written.

The test detects; the generator repairs. Neither prevents.

## Why the entity type never breaks

`audit_entity_type` is a Postgres enum, and new values arrive by
`alter type … add value if not exists`. That is **additive**: order-independent,
and a later migration cannot drop an earlier one's value. Two parallel branches
adding entity types simply both succeed.

It has never broken, and it never will, for a structural reason rather than a
diligence reason. The check constraint was chosen for `event_type` because enum
values can never be removed — the vocabulary bought removability and paid for it
with this whole failure class.

## Ending the class

Replace the restated constraint with an accumulated one — a reference table:

```sql
create table public.audit_event_types (name text primary key);

alter table public.audit_events
  add constraint audit_events_known_event_type
  foreign key (event_type) references public.audit_event_types(name);
```

Adding an event becomes `insert into public.audit_event_types … on conflict do
nothing`. Additive and order-independent like the enum, so two branches both
insert and neither can drop the other's names — and unlike the enum, a row can
still be deleted, which is the removability the check constraint was chosen for.

What it would cost:

- **A conversion migration** seeding all 85 existing names and swapping the
  constraint for the foreign key.
- **Teaching the guard test a new shape.** Its extractor reads
  `check (event_type in (...))` today and throws on anything it does not
  recognise — deliberately, so it cannot pass by finding nothing. It would need
  to replay `insert` statements instead.
- **A changed error code.** An unknown event raises `23503` rather than `23514`.
  Any handler keyed on the latter needs updating.
- **An RI lookup per insert** against a small primary-key table. Negligible, but
  it is not zero.

**Sequencing matters.** A conversion must not land while another branch has an
in-flight migration that restates the check constraint — that branch's migration
would try to drop a constraint that is now a foreign key. Do it when no
vocabulary migration is in flight, which is the same reason this document exists
instead of the conversion.
