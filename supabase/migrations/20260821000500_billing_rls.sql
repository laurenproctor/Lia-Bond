-- Row-level security for billing.
--
-- Both tables are **unwritable through a session**, and that is the whole
-- posture. Every other configuration table in this schema lets the roles that
-- own the feature write it; neither of these does, because neither holds
-- configuration. `organization_billing` holds what Stripe told Lia, and
-- `stripe_webhook_events` holds what Stripe sent. A member who could update
-- either could grant themselves the product: one `update` setting
-- `subscription_status` to 'active', or `trial_eligible` back to true, and the
-- entitlement function — which is pure, and trusts its input — would hand over
-- full access with nothing amiss anywhere in the trail.
--
-- The precedent is `yelp_listing_snapshots` and `reddit_poll_runs`: where a
-- row is evidence rather than configuration, sessions read it and only the
-- job writes it. Billing is the sharpest case of that rule in the schema,
-- because here the evidence is what somebody is paying.
--
-- Writes go through the SECURITY DEFINER functions in 20260821000300, which
-- are owned by the service role and are the only path in.

-- ---------------------------------------------------------------------------
-- organization_billing: every member reads, nobody writes.
--
-- Read is deliberately **not** narrowed to the `billing.manage` roles. The
-- trial countdown and the payment-problem banner render in the app shell for
-- every signed-in person, and an analyst who is about to lose write access on
-- Thursday is entitled to know why — the same argument
-- `organization_onboarding_select` records for the route guard. Withholding
-- it would produce a product that silently stops working for most of the team
-- with the explanation visible only to two roles.
--
-- Nothing here is sensitive. There is no card, no bank detail, no
-- payment-method id, and no secret in the table by construction; the Stripe
-- ids it does hold are useless without the secret key.
-- ---------------------------------------------------------------------------

alter table public.organization_billing enable row level security;

create policy organization_billing_select on public.organization_billing
  for select to authenticated
  using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.organization_billing from authenticated;

comment on policy organization_billing_select on public.organization_billing is
  'Any active member may read billing state. The trial banner and the payment warning render for every role, so every role needs the read, and the row holds nothing sensitive.';

comment on table public.organization_billing is
  'One organization''s billing relationship with Stripe. A projection, never a source of truth. Readable by any active member; writable through no session at all — only the SECURITY DEFINER functions the webhook and the operator paths call, because a member who could write this table could grant themselves the product.';

-- ---------------------------------------------------------------------------
-- stripe_webhook_events: RLS on, zero policies.
--
-- Not an oversight — the same shape as `oauth_states` and
-- `platform_connection_secrets`, both of which have RLS enabled and no policy
-- at all. The table has no tenant column to scope a policy by, and there is no
-- product question a member could answer with it. Service-role only.
--
-- `anon` is revoked explicitly as well as `authenticated`. The webhook route
-- is unauthenticated by nature — Stripe carries a signature, not a session —
-- and the one thing that must never be true is that the anonymous role which
-- reaches that route can also read the table it writes.
-- ---------------------------------------------------------------------------

alter table public.stripe_webhook_events enable row level security;

revoke all on public.stripe_webhook_events from authenticated;
revoke all on public.stripe_webhook_events from anon;

comment on table public.stripe_webhook_events is
  'Stripe event processing log. RLS enabled with no policies and no grants: operational data with no tenant column, reachable only by the service role, in the shape oauth_states and platform_connection_secrets already use.';
