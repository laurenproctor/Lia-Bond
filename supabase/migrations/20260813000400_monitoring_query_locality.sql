-- ---------------------------------------------------------------------------
-- Monitoring query locality
--
-- `source_country` already told a poll which market to search. It does not say
-- *where in it*, and for an organization-wide brand watch there is no location
-- row to ask — that is the whole point of an organization-wide query.
--
-- These three columns hold the answer somebody can only give at setup: a
-- postal code inside the chosen country, and the city and region it resolves
-- to. Nothing reads them yet. GNews filters by country and nothing finer, so a
-- poll behaves identically whether they are set or null; they are captured now
-- because the information is cheap to ask for while a person is already in the
-- form, and impossible to reconstruct afterwards. The provider upgrade that
-- makes local search possible (D71) is what will read them.
--
-- All three are nullable with no default and no backfill. Every existing row
-- keeps monitoring exactly the market it monitored yesterday, and a null here
-- means "nobody has said", which is the truth for every query created before
-- this migration. Inventing a locality from the organization's first location
-- would put a guess in a column the product will later present as a fact.
-- ---------------------------------------------------------------------------

alter table public.monitoring_queries
  add column postal_code text
    check (postal_code is null or length(trim(postal_code)) between 1 and 12),
  -- The lookup returns an area rather than an address for some countries (a UK
  -- outward code, a Canadian forward sortation area), so these are the widest
  -- place name the provider gives, not a precise town. 120 matches
  -- `locations.city` and `locations.region`, so a locality copied from a
  -- location row can never be too long for this one.
  add column locality_city text
    check (locality_city is null or length(trim(locality_city)) between 1 and 120),
  add column locality_region text
    check (locality_region is null or length(trim(locality_region)) between 1 and 120);

comment on column public.monitoring_queries.postal_code is
  'Local anchor inside source_country. Free text: postal formats differ by market, and the lookup service decides what resolves. Not sent to any provider yet.';
comment on column public.monitoring_queries.locality_city is
  'City the postal code resolved to. Denormalised on purpose: the lookup provider is unauthenticated and has no SLA, so rendering a query must not depend on it being reachable.';
comment on column public.monitoring_queries.locality_region is
  'State, province, or region. The abbreviation when the lookup supplies one, the full name otherwise.';
