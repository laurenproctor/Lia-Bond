# Website press widget

One to three pieces of earned media, on the customer's own website, from a
copy-and-paste snippet.

```html
<div data-lia-press-widget="pw_XlCDLpc78pKlEkL0e5-q"></div>
<script async src="https://lia.bond/embed/press-widget.js"></script>
```

Configured at `/integrations/press-widget`, reached from
`/integrations/website-widgets`.

Its sibling is `docs/review-widget.md`. **Read that one first.** Everything the
two widgets share — why a public embed is different from every other surface in
this product, why the document is a string rather than a page, why the loader is
ES5, why the public id is not a secret, and why approved domains are a CSP
directive — is argued there and is not repeated here. This document covers what
is different, and the differences are more interesting than they look.

---

## 0. Two widgets, not one widget with a mode

Reviews and press are both proof on a homepage, and that is where the
similarity ends.

| | Review widget | Press widget |
| --- | --- | --- |
| Scope | one **location** | one **organization** |
| Shows | one review | one to three stories |
| Chosen | automatically, or **pinned** | automatically only |
| Filtered by | minimum star rating | a monitoring query, or nothing |
| Source | `google_review` mentions | `news_article` mentions |
| Public id | `rw_…` | `pw_…` |
| Loads images | only its own sample media, as `data:` URIs | yes — bundled publisher logos |

Overloading `review_widgets` with `monitoring_query_id`, `item_limit`, and a
nullable `location_id` would have produced one table where half the columns are
meaningless for half the rows, one check constraint nobody can read, and one
RLS policy protecting two different things. D21's "extend the canonical model"
applies to `mentions`, which is where the **content** lives and which press
genuinely does reuse; it does not apply to two publishing surfaces that share
only an envelope.

**What is shared, and shared verbatim.** `src/lib/widgets/kinds.ts` (the five
strings that differ), `domains.ts` (normalisation and `frame-ancestors`),
`csp.ts` (the content policy and the response headers), `html.ts` (escaping and
outbound URL validation), `public-id.ts`, `snippet.ts`, `loader.ts`,
`attribution.ts`, and `use-widget-frame-height.ts`. One loader function builds
both scripts; one escape function serves both documents.

**What is not shared, deliberately.** Eligibility, the render boundary, the
document, the palettes, the sample, the preview resolver, the service, both
repositories, and both configurators. A shared renderer over a row full of
nullable review-or-press fields is how both of them end up half-wrong.

## 1. Why the widget is organization-level

A review arrives bound to a location, because the sync asked a specific listing
for it. **A news article does not.** It arrives bound to a *monitoring query* —
`mentions.monitoring_query_id`, set once when the article is first seen and
never re-attributed (see the note on that column: an article naming two
restaurants attributes to whichever query saw it first).

So a press widget names an organization, and its only filter is a query. A
query may itself be organization-wide or scoped to a location, and **choosing a
location-scoped query is how a per-restaurant press widget is expressed.**

There is deliberately no `location_id` column. A second, independent location
filter would silently disagree with the first the moment an article named two
restaurants, and the interface would be offering a control that could not
honour what it promised.

## 2. Which articles are eligible

The rules live in one place, `src/lib/widgets/press/eligibility.ts`, as a named
list rather than a boolean expression. Every one reuses a meaning the
repository already has; none invents a new mention state.

| Rule | Condition | Why |
| --- | --- | --- |
| `organization` | belongs to the widget's organization | tenancy, restated at the point of the read |
| `source` | `source_type = 'news_article'` | a thread or a review is not press |
| `query` | matches `monitoring_query_id` when the widget selects one | the widget's only filter |
| `query_enabled` | that query is enabled | see below |
| `headline` | non-empty `title` | the card *is* a headline |
| `source_url` | a non-empty, valid HTTP(S) `source_url` | the card *is* a link |
| `published` | a publication timestamp exists | the list is ordered by it and the card shows it |
| `not_dismissed` | `status <> 'dismissed'` | the existing "dealt with and put away" |
| `not_escalated` | `status <> 'escalated'` | Lia routed it to a person as a risk |
| `present_at_source` | `source_removed_at is null` | withdrawn coverage stops being republished |
| `not_syndicated` | `is_syndicated = false` | see below |
| `provider_returned` | `capture_method = 'provider_api'` | a typed article is unverifiable by construction |

Sorted `published_at desc, id desc`, then cut to `item_limit`.

Four deserve the argument in full.

**`query_enabled`** is not a property of the article; it is a property of the
watch that found it. A customer who disables a monitoring query has said "stop
watching this", and continuing to publish what it found — on their own
homepage, indefinitely — would be Lia deciding that "stop" meant "stop
fetching". It applies **only when the widget selects a query**: the "all press"
mode draws on everything already ingested, and retro-actively hiding an article
because the watch that found it was later switched off would empty widgets for
a reason nobody could see. The configurator refuses to *attach* a disabled
watch for the same reason, so the only way to reach this state is to disable a
watch a widget already uses.

**`not_syndicated`** has no review equivalent. `is_syndicated` is set by Lia's
own gate (D86) when the same headline reappears inside the syndication window —
a wire story picked up by four outlets. In the inbox that is a useful signal;
in a three-item strip it is the difference between "three publications covered
us" and "one wire service did, and we printed it three times".

**`source_url`** is a rule rather than a rendering detail. A review widget with
no "Read on Google" link still shows the review, because the words are the
point. A press card with no destination is a headline a reader cannot check,
which is exactly the shape of a fabricated one — so the story is dropped, not
the anchor.

**What is deliberately *not* a rule.** `responded`, `monitoring`, and
`no_action_recommended` are mention statuses that describe Lia's own queue and
say nothing about whether the article still exists. An article Lia recommends
no action on is very often the best coverage a customer has. **Internal
workflow state and public existence are different facts**, and only the second
belongs here. `supabase/tests/press-widget-verification.sql` §3 asserts a
`responded` article is still published, and
`tests/press-widget-eligibility.test.ts` asserts the migration contains no
reference to those statuses at all.

### The rules exist twice, and that is forced

The anonymous render path cannot run TypeScript. An embed request carries no
session, so `auth.uid()` is null and no policy on `mentions` or
`monitoring_queries` would return a row; the render goes through
`public.press_widget_render`, a `SECURITY DEFINER` function whose `where`
clauses are a hand-written mirror of the table above.

The duplication is documented at both ends, the rule identifiers appear as
trailing comments on each SQL clause, and
`tests/press-widget-eligibility.test.ts` fails if the migration stops naming
one. **Change both or neither.**

## 3. The logo trust boundary

This is the part of the press widget with no review-widget precedent, and it is
the reason the feature took the shape it did.

A press strip wants mastheads. Every obvious way of getting them turns the
customer's website into an uncontrolled network client, so **none of them is
used**:

- **Not the provider's image URL.** GNews returns an `image` field; it is a
  publisher-controlled URL, and putting it in an `<img src>` on somebody's
  homepage means the publisher's server sees every visitor, sets whatever it
  likes, and can serve anything at all — including nothing, on the day their
  CDN moves.
- **Not a favicon service, Clearbit, Logo.dev, or Google's `s2/favicons`.**
  Same problem with a third party added: a request from the customer's page to
  a company the customer has never heard of, which their consent banner has an
  opinion about and their content policy may simply block.
- **Not a server-side fetch of a publisher-controlled URL during a render.**
  That is an SSRF surface reachable by anonymous traffic and an availability
  dependency on somebody else's uptime, on a route that must always answer.
- **Not provider- or customer-supplied SVG markup.** Storing markup that ends
  up inline in a document is storing a script tag that has not been written
  yet.

### What is used instead

```
mention.publisher_domain            (provider-controlled text)
  └─ normalised in SQL              lower(), strip www., nullif
      └─ crosses the anonymous boundary as a bare hostname — never a URL
          └─ normalised again in TypeScript   normalizePublisherDomain()
              └─ looked up in PUBLISHER_LOGOS  ← the ONLY thing that picks a path
                  └─ path re-checked against /^\/widget-logos\/…\.v\d+\.svg$/
                      └─ <img src="/widget-logos/…">   img-src 'self' data:
```

Four properties hold at once, and each is load-bearing:

1. **The resolver returns a key, never a path.** `press_widget_render` emits a
   normalised `publisher_domain` and a display name. A database row therefore
   *cannot name an asset* — it can only name a key the registry may or may not
   recognise.
2. **The registry is the only chooser.** `resolvePublisherLogo()` in
   `src/lib/widgets/press/publisher-logos.ts` maps a domain to a bundled file,
   and re-validates the path shape on the way out.
3. **The content policy is the enforcement.** `img-src 'self' data:` on both
   the public document and the preview, and **never widened to `https:`**. Even
   a bug in (1) or (2) cannot produce a request to another origin. The review
   widget carries the same `img-src` — its sample layouts draw pictures as
   `data:` URIs — plus a `media-src` for the video layout's clip, which the
   press widget deliberately does not have: `default-src 'none'` covers it, so
   a `<video>` that somehow reached a press document could not load a thing.
4. **A missing logo never costs a story its place.** The publisher's name in
   text is a complete rendering of "who published this". Dropping an otherwise
   eligible article for want of a picture would be the tail wagging the dog.

### What is bundled, and what is not

**Three publications ship with marks, and all three are invented:**

| Publication | Domain | Logo | Provenance |
| --- | --- | --- | --- |
| The Harbour Ledger | `harbourledger.example` | yes, light + dark | invented; original artwork |
| Meridian Table | `meridiantable.example` | yes, light + dark | invented; original artwork |
| Northside Dispatch | `northsidedispatch.example` | yes, light + dark | invented; original artwork |
| **Every real publication** | — | **no — text fallback** | — |

They exist so the Website widgets landing page can show a press widget drawn by
the real renderer, with real logo files, without reproducing a trademark this
project has no licence to and without presenting invented coverage as
somebody's real coverage. Their domains are under `.example`, which RFC 2606
reserves, so a customer can never be covered by one of them.

**The consequence is deliberate and worth stating plainly: no real publication
has a bundled logo today, so production coverage renders the publisher's name
as text.** That is a complete rendering, and it is the honest state until
somebody does the licensing work outlet by outlet. `public/widget-logos/README.md`
holds the provenance table and the three-step process for adding one — a code
change, not a migration.

### Rendering rules

- `object-fit: contain` with a fixed 20px box height and an `auto` width. Every
  mark gets the same vertical space and keeps its own proportions. Stretching a
  masthead to a common box is the most recognisable way to make a publication
  look like it did not consent to appear.
- The 20px cap keeps the mark subordinate to a 15px bold headline. A masthead
  larger than the story turns a proof strip into an advert for somebody else.
- Alt text is **the registry's** name, not the provider's. The registry's name
  was checked when the mark was added; a provider reporting "Harbour Ledger —
  Food & Drink" must not put that in an image's accessible name.
- A mark and its own name are never both drawn. Either the logo carries the
  name as alt text, or the name is a text node — never an image with empty alt
  beside the same words, which is the arrangement most likely to rot into an
  image with no alt at all.

## 4. Unavailable states

Three, and each is a different sentence. There is no press equivalent of
`selected_review_unavailable`, because there is no pinning.

| Reason | What the visitor reads |
| --- | --- |
| `unknown_widget` | the snippet points at a widget that was removed or had its code regenerated |
| `disabled` | the widget is switched off |
| `no_eligible_press` | there is no coverage to show yet |

None mentions eligibility, monitoring queries, syndication, or dismissals: a
restaurant guest may be the first person to load the page, and Lia's internal
vocabulary is not for them. All three are quiet grey text.
`tests/press-widget-render.test.ts` asserts none of them contains the words
"eligible", "dismissed", "escalated", "syndicated", "monitoring query", or
"organization".

## 5. The anonymous public-data boundary

```
signed-in path                        anonymous path
──────────────                        ──────────────
server action                         route handler
 └─ authorize("website_widget.manage")  └─ (no session at all)
     └─ OrganizationScope                   └─ press_widget_render(public_id)
         └─ RLS policies                        └─ SECURITY DEFINER, 11 columns
```

`public.press_widget_render(widget_public_id text)` is the entire anonymous
surface for this feature. It is `SECURITY DEFINER`, `search_path` is pinned to
`public, pg_temp`, every object is schema-qualified, `execute` is revoked from
`PUBLIC` and granted only to `anon` and `authenticated`.

**It returns one row per story**, and one row with every story column null when
nothing qualifies — the left join that keeps a widget with no coverage from
disappearing entirely, so the renderer can draw the quiet card rather than
nothing at all.

**Story fields, and nothing else:** headline, excerpt, publisher name,
normalised publisher domain, source URL, published timestamp.
**Configuration fields:** theme, layout, status, allowed domains,
`attribution_suppressed`.

Nothing else crosses. No organization id, no mention id, no monitoring query
id, no keyword, no status, no sentiment, no risk level, no relevance or
engagement score, no raw payload, no analysis. `PressWidgetRenderRow` is the
type that bounds it — a caller cannot widen it, so what anonymous traffic can
see is a property of the type rather than of care at the call site.

`anon` has SELECT on nothing. `supabase/tests/press-widget-verification.sql`
§11 pins the function's exact eleven output columns; §12 proves `anon` holds no
grant on `press_widgets` and reads zero rows from both `mentions` and
`monitoring_queries`.

**The excerpt is trimmed at the resolver, not the renderer** — 240 characters,
cut on a word boundary — so the anonymous surface carries what the widget shows
rather than a paragraph the widget would discard.

**No poll is ever triggered.** This route reads what monitoring already
ingested. An embed that fetched news would put a provider request, and a shared
daily budget, behind an anonymous URL on somebody else's homepage.

## 6. Tenancy, and a foreign key that does the work

`press_widgets.monitoring_query_id` must be unable to point at another tenant's
watch. A simple foreign key to `monitoring_queries(id)` would accept any query
id in existence, and the only thing between a mis-set row and one restaurant
group publishing the coverage another group is watching would be application
code.

So the reference is composite:

```sql
constraint press_widgets_query_same_org
  foreign key (monitoring_query_id, organization_id)
  references public.monitoring_queries (id, organization_id)
  on delete set null (monitoring_query_id)
```

which needed a matching parent unique — `monitoring_queries_id_org`, added in
the same migration, the same construction 20260811000100 built for
`mentions.location_id`.

The service checks it too, and reports a cross-tenant query as **not found**
rather than "belongs to another organization": the second sentence to a caller
who supplied an arbitrary UUID would confirm the id exists, which is an
existence oracle across the boundary.

`on delete set null` rather than cascade: deleting a monitoring query **widens**
the widget to all press rather than emptying it or destroying it. A customer
who deletes a watch has decided to stop watching something, not that their
homepage should go blank.

### Permissions

`website_widget.manage` — owner, admin, communications lead. **Renamed in this
change from `review_widget.manage`**, because it now gates two products.

The rename was atomic and left no alias. Nothing in SQL names the permission —
the RLS policies restate the *roles* with `has_organization_role`, which is
what Postgres can express — so the change was confined to the permission table,
four call sites, and the tests that pin the role list. The role list is
unchanged, which is why no policy migration was needed.

One permission rather than two with identical role lists. Two names for one
authority is a place for two lists to drift apart, and there is no plausible
world in which somebody may configure the review widget but not the press one.

Location managers are absent. For the review widget that needs an argument (see
`docs/review-widget.md` §8). For the press widget it does not: a press widget
carries no location at all, so there is nothing to scope them to even in
principle.

### Grants

Written out explicitly, because **a new table in `public` is not closed to the
Data API merely by existing**. Supabase's `alter default privileges` hands
`anon`, `authenticated`, and `service_role` ALL privileges on every new table.

- `grant select, insert, update` to `authenticated` and `service_role` —
  exactly what the four repository methods need.
- `revoke delete` from **both**. A grant adds; it never subtracts, so the
  grants above do not take back the DELETE the default privileges already
  handed out. This was caught by the SQL harness asserting the absence rather
  than trusting the grant list to imply it.
- `revoke all` from `anon`.

No delete policy either. "Revoke" is a rotation and "switch off" is a status;
both leave the row, and therefore the record that a widget existed and what it
showed. A migration runs as the table's owner and is unaffected — the one path
that should be able to remove a row, and the one that leaves a record of doing
so.

## 7. Embed architecture

```
customer's page
  └─ <div data-lia-press-widget="pw_…">
  └─ <script async src="/embed/press-widget.js">   ← loader, ES5, ~2 KB
       └─ <iframe src="/embed/press-widget/pw_…">  ← self-contained document
            └─ postMessage height ──▶ loader sizes the frame
```

| Route | Audience | Notes |
| --- | --- | --- |
| `/embed/press-widget.js` | anonymous | Loader. Origin baked in at request time. |
| `/embed/press-widget/[publicId]` | anonymous | The document. Always 200 with something drawable. |
| `/embed/press-widget/preview` | signed in, `website_widget.manage` | Same renderer, unsaved configuration, `frame-ancestors 'self'`, `no-store`. |
| `/embed/press-widget/preview?sample=1` | anyone | The landing page's sample. Invented coverage, bundled logos, no tenant data. |

**A separate loader from the review widget's**, not one script scanning for both
attributes. A customer running only the review widget should not ship the press
widget's code to every visitor; a page running both loads two ~2 KB files that
share an origin and ignore each other. `buildLoaderScript(origin, kind)` is the
single implementation, so the origin check — the security-relevant line in the
file — exists once.

**A page may carry both widgets.** Four things keep them from interfering:
different attribute, different frame path, different id prefix, and different
`postMessage` source name. `tests/press-widget-embed.test.ts` asserts all four
are distinct across `WIDGET_KINDS`, and the height listener matches on the
frame's own `contentWindow` as well as on the source name.

**The id prefix is checked on the route**, so a `rw_…` id pasted into a press
snippet is answered immediately rather than becoming a lookup that returns
nothing — "no such widget" would send somebody hunting for a deleted widget
when what they actually did was copy the wrong two lines.

### Caching

The document is cached at the edge for 60 seconds with a five-minute stale
window; the `unknown_widget` response is `no-store`, because it is exactly what
somebody sees immediately after rotating an embed id. The loader is
`max-age=300, s-maxage=3600, stale-while-revalidate=86400`. Logo files are
served by Next from `public/` and are versioned in their filenames (`.v1.svg`),
so a redrawn mark gets `v2` and a new registry row rather than overwriting a
file a thousand pages have cached.

## 8. The in-app preview, and what it costs

The preview shows a theme, a query, and a story count somebody just chose,
before any of it has reached the database — so it cannot go through
`pressWidgets.render()`, and it resolves the stories in TypeScript using the
shared eligibility predicate.

**Stated plainly:** on a Supabase deployment the public embed resolves in SQL
and the preview resolves in TypeScript. Both mirror the same rule list, but
they are two implementations, so a preview is a faithful rendering of the
*predicate* rather than a byte-for-byte replay. What cannot differ is how it
looks: both go through the same `resolveRenderedPressWidget` →
`renderPressWidgetDocument`, so a divergence could only ever be *which* stories
appear.

**The preview uses the customer's real coverage**, never the invented sample. A
preview built from fiction would answer the wrong question: the person looking
at it wants to know what *their* homepage will say. The invented sample exists
in exactly one place — the landing page — where it is labelled as an example
and where no tenant data has been read at all.

The one asymmetry worth knowing: when a query is selected, the preview fetches
filtered (`MentionFilter.monitoringQueryId`, added for this) rather than
filtering an unfiltered page in memory. Without it a query whose coverage sat
outside the fetched page would preview as empty while the live widget showed
it — precisely the drift a preview exists to rule out.

## 9. The Website widgets landing page

`/integrations/website-widgets`. A landing route rather than a tab on either
configurator, because the question it answers comes *before* configuration: a
person arriving from the sidebar does not yet know Lia publishes two different
embeds, and putting one configurator here would make that one the product and
the other a link somebody might not notice.

**It reads no tenant data at all** — no organization context, no locations, no
mentions, no widget rows. Both samples are rendered by the two real renderers
through their `?sample=1` branches, which answer before organization context is
resolved for the same reason the review teaser does: the page is shown to every
member of every organization, including the ones who will never hold
`website_widget.manage`.

**The review card carries the layout carousel**, so the page shows all three
arrangements — text, photos, video — rather than only the one a customer can
publish. It reuses `ReviewWidgetLayoutCarousel` verbatim, which means the two
media slides automatically carry the note that they cannot be embedded yet: the
carousel derives that from `SAVABLE_REVIEW_WIDGET_LAYOUTS`, so the day media
gets a real source and that list widens, the note disappears on its own instead
of surviving as a lie about a feature that shipped. The carousel opens on the
text card, which is the arrangement somebody can actually buy.

The press card has no carousel. `recent_press_list` is its only layout, and a
one-tab carousel would imply a choice nobody has.

The deliberate cost: **this page cannot say "you already have a review
widget"**. That belongs on the screens that know — the configurators and the
integrations entry card — and buying the sentence here would cost the page its
independence from tenancy for very little.

`/integrations/review-widget` keeps working, untouched. It has been in the
sidebar and in customers' browser history since the review widget shipped, so
the sidebar entry reaches both configurators through `NavItem.alsoMatches`
rather than by moving either URL beneath the landing route.

## 10. Audit and observability

Five canonical events: `press_widget.created`, `.updated`, `.enabled`,
`.disabled`, `.embed_id_rotated`. Their own names rather than a shared
`website_widget.*` set, because the two are separate tables with separate
entity ids and a trail that could not say which product changed would be
answering the wrong question. `press_widget` is its own `audit_entity_type` for
the same reason.

**What the metadata carries:** theme, layout, story count, the selected
monitoring query's **id**, approved domains, and — on a rotation — both public
ids.

**What it never carries:** a headline, an excerpt, a publisher, or a monitoring
query's keywords. The widget publishes the first three, and the audit trail is
not where a second copy of them belongs; the fourth is the customer's own
competitive information and is worse still.
`tests/press-widget-service.test.ts` asserts none of them appears in a
serialised trail.

A save that changes nothing writes nothing, and a status change to the status
already held is a no-op rather than a second event.

Server logs carry no article content, no monitoring keyword, and no full public
id. The public route logs nothing at all on the happy path; the preview route's
one `console.error` carries the caught error, never the configuration.

## 11. Verifying it

```
npm run verify                    # lint, typecheck, 2800+ vitest, build
npm run db:verify-press-widget    # migrations + RLS + the eligibility harness
npm run db:verify-website-widgets # both widgets' harnesses in one run
```

The second matters more than it looks. `public.press_widget_render` is a
hand-written mirror of a TypeScript predicate and **nothing in the vitest suite
can execute it** — `tests/press-widget-eligibility.test.ts` can only prove the
migration *names* each rule in a comment.
`supabase/tests/press-widget-verification.sql` is the other half: it builds
four eligible controls and eight newer articles that each fail exactly one
rule, and asserts the controls still win. A rule missing from the SQL loses
that contest.

It also pins the item limit at each of its three values and at both refused
ones, the ordering and its `id desc` tiebreaker, the query filter and the
enabled check, cross-tenant attachment at the **database** layer, the
`on delete set null` widening, what the function may return (eleven named
columns), domain normalisation and excerpt trimming across the boundary, the
public-id shape constraint, and — at the two different layers that actually
apply — that `anon` holds no grant on `press_widgets` while `mentions` and
`monitoring_queries` are closed by RLS with the grant still in place.

Section 14 of `supabase/tests/rls-verification.sql` covers the policies:
cross-tenant reads, the write role set, `anon` executing the function,
cross-tenant query attachment through a session, and the absence of any delete
path.

The vitest suites:

| File | Covers |
| --- | --- |
| `press-widget-eligibility.test.ts` | every rule, selection, ordering, limits, the SQL mirror |
| `press-widget-render.test.ts` | escaping, URL validation, logos in both themes, unavailable states, excerpts, dates |
| `press-widget-logos.test.ts` | domain normalisation, path trust, assets on disk, declared dimensions, provenance |
| `press-widget-embed.test.ts` | ids, snippets, loader ES5 and origin checks, the CSP |
| `press-widget-contrast.test.ts` | WCAG contrast in both palettes, focus, list semantics, container queries |
| `press-widget-service.test.ts` | lifecycle, tenancy, audit, the anonymous projection, permissions |
| `website-widgets-landing.test.ts` | both real samples, the page's structure, the sidebar, the old route |

**No test in this repository computes layout**, so a green suite says nothing
about CSS. The landing page and both configurators were driven in a real
browser at 1440px and 700px: two equal cards side by side and stacked, both
samples framed and sized to their content, logos loading with their intrinsic
aspect ratios intact and under the 20px cap, the theme control changing only
its own sample, `aria-pressed` proving hydration, and no horizontal overflow.

## 12. Operational runbook

### "My press widget shows nothing"

In order:

1. Is the widget switched off? The configuration page says so on the page
   itself.
2. Was the embed code regenerated? The page will say "no longer available" —
   copy the current code.
3. Is a news watch selected, and is that watch switched on? A widget pointed at
   a disabled watch publishes nothing, by design.
4. Has any article passed §2? The configuration screen lists every article Lia
   has found and the reason each ineligible one was refused.
5. Is the site's domain on the approved list, or is the list empty? A blocked
   frame leaves a `frame-ancestors` violation in the browser console.

### "A publication is showing as text instead of its logo"

Expected. **No real publication has a bundled logo** — see §3. Adding one is a
licensing decision followed by a two-file change plus a registry row; it is not
a bug report.

### "The widget shows a story we would rather not feature"

There is no pinning and no per-story hide. The levers are: dismiss the mention
(it stops being published immediately, with no widget write), narrow the widget
to a monitoring query that does not carry it, or reduce the story count. If
per-story exclusion becomes a real need, it is a `press_widget_exclusions`
table keyed by mention id — not a `pinned` column, which is the feature that
turns a "recent press" strip into a stale one.

### Rotating an embed id by mistake

Not recoverable from Lia. The old id is in the audit trail
(`press_widget.embed_id_rotated`, both ids recorded) but a rotated id cannot be
reinstated — `public_id` is uniquely indexed and the value is gone. Paste the
new snippet.

### Demo mode

The public embed works in demo mode, for the reason
`docs/review-widget.md` §10 records: the demo store lives on `globalThis`, so a
widget saved through the app is visible to the route handler in the same
process. The seeded organization has three news articles from three real
publishers, none of which is in the logo registry — so demo mode exercises the
text fallback, which is the production rendering.

## 13. Deployment

Three migrations, in order:

| File | What it does |
| --- | --- |
| `20260821000100_press_widget.sql` | `monitoring_queries_id_org`, the table, `press_widget_render`, the `press_widget` entity type |
| `20260821000200_press_widget_rls.sql` | RLS, policies, grants, revokes |
| `20260821000300_press_widget_audit_vocabulary.sql` | restates `audit_events_known_event_type` (generated) |

The first adds a unique constraint to `monitoring_queries` and contains a
composite foreign key that will fail if any existing widget row pointed
cross-tenant — there are none, because the table is created in the same
migration.

`20260821000300` is the usual audit-vocabulary hazard: it restates the whole
event list, so a branch merged after it whose own vocabulary migration sorts
later will silently drop these five names.
`tests/audit-vocabulary-migrations.test.ts` is what catches it; the repair is a
new generated migration, never a hand-merge.

Per the deploy runbook, the migrations reach hosted **before** the merge that
deploys the code.

### Rollback

Postgres enums cannot have values removed and a check constraint's previous
definition is not recoverable from the catalog, so rolling back
`20260821000300` means a forward-repair migration restating the prior list;
`press_widget` simply stops being written to `audit_entity_type`.

`20260821000100` and `20260821000200` drop cleanly:

```sql
drop table public.press_widgets cascade;
drop function public.press_widget_render(text);
alter table public.monitoring_queries drop constraint monitoring_queries_id_org;
```

— but every snippet in every customer website stops resolving at that moment,
and unlike a rotation there is no new code to paste. Switch the widgets off and
tell the customers first.

## 14. What is not built

- **Automated logo discovery or ingestion.** No crawler, no favicon fetch, no
  logo API, no customer upload. Adding a publication is a deliberate,
  licence-checked code change. This is the single largest deferred piece and it
  is deferred on purpose: every automated route to a logo is a route to a
  request the customer's page makes to somebody else's server.
- **Article photographs.** The provider supplies an `image` URL and Lia stores
  it in `sourceMetadata`; rendering it would be a publisher-controlled request
  on the customer's page, which is the whole thing §3 exists to prevent.
  Bringing them in needs Lia-hosted copies, a rights position, and a moderation
  path — none of which is scoped.
- **Manual pinning and per-story exclusion.** See the runbook above.
- **Carousels, arbitrary HTML, custom colours, and branding removal.** All four
  were named as out of scope, and each is a way for a widget to stop looking
  like the thing that was tested.
- **More than one press widget per organization**
  (`press_widgets_one_per_organization`). When a customer genuinely needs a
  dark one in the footer and a light one on a press page, drop the constraint
  and add a `name` column.
- **Impressions, clicks, or any analytics.** An empty events table is how a
  product acquires a metric nobody asked for and a retention obligation nobody
  scoped.
- **A second layout.** `recent_press_list` is the only value `layout` accepts;
  the check constraint is the seam a grid or a single featured story arrives
  through.
