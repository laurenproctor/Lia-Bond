# Website review widget

One Google review, on the customer's own website, from a copy-and-paste
snippet.

```html
<div data-lia-review-widget="rw_XlCDLpc78pKlEkL0e5-q"></div>
<script async src="https://lia.bond/embed/review-widget.js"></script>
```

Configured at `/integrations/review-widget`, reached from **Website widgets**
in the sidebar.

---

## 0. Why this feature is different from every other one in Lia

Everything else in this codebase describes something Lia **read** from
somewhere else — a review, a thread, an article. This is the first thing Lia
**publishes**, on a domain it does not own, in front of people deciding whether
to book a table.

That inversion is the reason behind most of the decisions below, and it is
worth stating once at the top because it explains why some of them look
paranoid relative to the rest of the product:

- a mistake here is visible to the customer's customers, not to their staff;
- the audience has no session, no account, and no way to report a problem;
- the artefact — a snippet in a page's source — outlives every deploy, every
  refactor, and quite possibly the agency that pasted it.

## 1. What it shows, and what it deliberately does not

**Shows:** Google attribution, the star rating, the review text, the
reviewer's display name, a relative date, a "Read on Google" link where one can
be trusted, and a "Powered by Lia" line.

**Does not show, in this version:** photographs, video, a carousel, a grid, an
aggregate rating, or more than one review at a time. Those are named in the
product brief as future work and the configuration is shaped so they can arrive
without a migration — `review_widgets.layout` is a check-constrained text
column at one value, `single_review_text`, which is the seam. Nothing else in
the schema assumes there is only one layout.

**No photographs also means no reviewer avatar image.** The disc carries
initials derived from the display name. Google does return
`reviewer.profilePhotoUrl`, and Lia stores it — but rendering it would put a
`googleusercontent.com` request on the customer's page, which is a third-party
request their consent banner has an opinion about and a broken image on any
page with a strict content policy.

### "Read on Google" points at the location, not the review

Google publishes **no per-review permalink**. `normalizeReview` in
`src/integrations/google-business-profile/reviews.ts` records this and stores
`source_url: null` for every imported review rather than fabricating a deep
link that 404s. So the destination is the location's own Google profile — the
`mapsUri` captured when the listing was mapped — validated against an explicit
allowlist of Google hosts (`src/integrations/google-business-profile/urls.ts`)
at the moment it becomes an anchor.

When Lia holds no trusted URL, the control **disappears** rather than
degrading. A dead "Read on Google" link on a restaurant's homepage is worse
than no link.

## 2. Which reviews are eligible

The rules live in one place, `src/lib/widgets/eligibility.ts`, as a named list
rather than a boolean expression. Every one reuses a meaning the repository
already has; none invents a new review state.

| Rule | Condition | Why |
| --- | --- | --- |
| `location` | belongs to the widget's location | never silently substitute another restaurant's review |
| `source` | `source_type = 'google_review'` | it says Google on it |
| `text` | non-empty `content` | a rating-only review renders as an empty quotation |
| `rating` | a rating exists | the widget draws stars |
| `not_dismissed` | `status <> 'dismissed'` | the existing "dealt with and put away" |
| `not_escalated` | `status <> 'escalated'` | Lia routed it to a person as a risk |
| `present_at_source` | `source_removed_at is null` | withdrawn content stops being republished |
| `provider_returned` | `capture_method = 'provider_api'` | a typed review is unverifiable by construction |
| `minimum_rating` | `rating >= widget.minimum_rating` | configuration, not review state |

Two deserve the argument in full.

**`not_escalated`** reuses an existing meaning rather than inventing one: an
escalation is Lia's record that a mention was routed to a person as a risk, and
"needs handling" and "put this on the homepage" cannot both be true. A review
later resolved leaves `escalated` through the normal lifecycle and becomes
eligible again on its own.

**`provider_returned`** excludes manually typed reviews — the Yelp capture
path. Republishing one publicly as a Google review would be Lia asserting a
customer's words that no provider ever returned. No Google review is manually
captured today, which is exactly why the rule is cheap to hold now and
expensive to add after the first one ships.

### The minimum rating is not in the product brief

It was added deliberately. "Most recent eligible review" with no floor puts
whatever arrived last on a restaurant's homepage, and what arrives last is as
likely to be one star as five. The default is 4, not 5, because five-only is
how a widget goes blank for a month at a well-run restaurant with a couple of
fours.

It governs **automatic selection only**. Somebody who deliberately pins a
three-star review meant it, and a floor that overrode an explicit choice would
be the product second-guessing a decision a person made on purpose. All three
implementations — the SQL function, the demo adapter, and the preview — make
the same exception the same way.

### The rules exist twice, and that is forced

The anonymous render path cannot run TypeScript. An embed request carries no
session, so `auth.uid()` is null and no policy on `mentions` would return a
row; the render goes through `public.review_widget_render`, a `SECURITY
DEFINER` function whose `where` clauses are a hand-written mirror of the table
above.

The duplication is documented at both ends, the rule identifiers appear as
trailing comments on each SQL clause, and
`tests/review-widget-eligibility.test.ts` fails if the migration stops naming
one. It is the only place in this feature where two implementations of one
decision are permitted to exist. **Change both or neither.**

## 3. Unavailable states

Four, and each is a different sentence, because collapsing them makes the most
common support question — "why is my widget empty" — unanswerable from the page
itself.

| Reason | What the visitor reads |
| --- | --- |
| `unknown_widget` | the snippet points at a widget that was removed or had its code regenerated |
| `disabled` | the widget is switched off |
| `selected_review_unavailable` | the pinned review can no longer be shown — **and no other review is shown in its place** |
| `no_eligible_review` | nothing at this location qualifies yet |

None of them mentions eligibility, statuses, or dismissals: a restaurant guest
may be the first person to load the page, and Lia's internal vocabulary is not
for them. All four are quiet grey text. A red error box on somebody's homepage
is worse for them than a small line.

The third is the one the product brief singles out, and it is why
`selected_mention_id` is `on delete set null` with **no** paired check
constraint: a deleted review must leave the widget pinned to nothing, so the
renderer can say so.

## 4. Embed architecture

```
customer's page
  └─ <div data-lia-review-widget="rw_…">
  └─ <script async src="/embed/review-widget.js">      ← loader, ES5, ~2 KB
       └─ <iframe src="/embed/review-widget/rw_…">     ← self-contained document
            └─ postMessage height ──▶ loader sizes the frame
```

### Three routes

| Route | Audience | Notes |
| --- | --- | --- |
| `/embed/review-widget.js` | anonymous | Loader. Origin baked in at request time, so a preview deployment points at itself. |
| `/embed/review-widget/[publicId]` | anonymous | The document. Always 200 with something drawable. |
| `/embed/review-widget/preview` | signed in, `review_widget.manage` | Same renderer, unsaved configuration, `frame-ancestors 'self'`, `no-store`. |
| `/embed/review-widget/preview?sample=1` | anyone | The empty state's teaser. An invented review, no tenant data, so it answers before the organization context is resolved. See §9. |

None is a page. A page under `src/app/` inherits the root layout,
`globals.css`, Tailwind's preflight, and the React runtime — every one of which
is a liability inside an iframe on somebody else's website. The document is a
string with inlined CSS, one inline script, and **no network request of any
kind** after itself.

### The loader is written as ES5 in a template literal

Deliberately, and it is the one place in this repository where "not idiomatic"
is the right answer. A bundled entry point would be built for whatever browser
target the framework has that quarter and fingerprinted into a URL that cannot
appear in a snippet already pasted into a thousand websites. This file's job is
to still work in five years on a page nobody has touched since.
`tests/review-widget-embed.test.ts` asserts it contains no `const`, `let`,
arrow function, or template literal.

### Auto-height

An iframe cannot size itself. The document measures with `ResizeObserver` and
posts `{source: "lia-review-widget", type: "height", …}` to the parent; the
loader listens.

In-app, `useWidgetFrameHeight` is the listening half for both framed screens.
It does one thing the public loader does not need to: it also measures the
frame directly on `load`. A frame in server-rendered HTML starts loading with
the page and can post its height *before* React has hydrated and attached any
listener — `postMessage` has no replay and `ResizeObserver` never fires again,
so the frame silently keeps its initial height and clips the review. The
teaser lost that race every time. Measuring `contentDocument` works only
because these two frames are same-origin, which is exactly what the public
loader cannot assume.

Two things make that channel safe:

- the loader checks `event.origin === ORIGIN` before reading anything; and
- it matches the message to a frame by `contentWindow === event.source`, not by
  the id in the message — an id is readable in the page's HTML, a window handle
  is not, so a hostile frame cannot resize a sibling by claiming its id.

The frame carries `sandbox="allow-scripts allow-same-origin allow-popups
allow-popups-to-escape-sandbox"`. `allow-same-origin` alongside
`allow-scripts` is usually a warning sign and is correct here: the danger is a
frame same-origin *with its embedder*, and this document is served from Lia and
embedded on the customer's domain. Without it the frame gets an opaque origin,
every message arrives as origin `"null"`, and the check above has nothing to
check against.

### Caching

The document is cached at the edge for 60 seconds with a five-minute stale
window. A widget on a busy homepage would otherwise run a query per page view
for a review that changes weekly, and a saved change still appears within a
minute. The `unknown_widget` response is `no-store`, because it is exactly what
somebody sees immediately after rotating an embed id and caching it would keep
the *new* snippet showing the old answer.

The loader is `max-age=300, s-maxage=3600, stale-while-revalidate=86400`: short
in the browser because the URL can never carry a build hash, long in the shared
cache because it almost never changes.

## 5. The public id

`rw_` plus 20 base64url characters — 15 random bytes.

**It is an identifier, not a secret**, and the schema says so in a comment
because the next person to read it will assume otherwise. It is pasted into
public HTML by design; hashing it, as `invitations.token_hash` and
`oauth_states.state_hash` are hashed, would protect nothing. It is random
rather than sequential for one narrow reason: a sequential id would let anybody
walk the range and produce a list of every restaurant using Lia, with a live
review from each.

**Rotation is the revoke.** A customer who wants an already-published snippet
to stop resolving has no other lever — they do not control every page their
agency pasted it into. It is irreversible, it is confirmed in the interface,
and the retired id is shown once afterwards so they know what to search their
site for. Lia cannot know which pages carry it.

`status = 'disabled'` is the reversible option and keeps the id.

## 6. Domain restriction

Approved domains become a `Content-Security-Policy: frame-ancestors` directive
on the document. That is a real control on a public URL: the **visitor's
browser** refuses to paint the frame elsewhere.

- Empty means unrestricted. Closed-by-default would mean every widget was
  broken until somebody found the setting, and the commonest deployment — one
  restaurant, one site, pasted once — would never work first try.
- A non-empty list always keeps `'self'`, so a customer never has to add
  `lia.bond` to their own allowlist to see the preview.
- Both `https://` and `http://` sources are emitted per host. Restaurant
  websites are not universally on TLS and a widget that silently fails to paint
  is a ticket that reads "it does not work".

`Referer` is **not** consulted: absent under `no-referrer`, absent on many
privacy configurations, and trivially forged by anything that is not a browser,
so a server-side check would refuse legitimate visitors and stop nobody.
`X-Frame-Options` is not sent: it cannot express a list, and `ALLOW-FROM` was
removed from every current browser.

**What this is not.** It does not make the review private — it is on Google
already. It stops somebody framing *your* widget on *their* page. The settings
screen says so in as many words, because a control that implied otherwise would
be selling a guarantee the web cannot give.

## 7. "Powered by Lia"

The product brief asks for this to be "controlled by the customer's plan or
existing product rules". **Lia has neither.** There is no billing model, no
subscription record, and no entitlement anywhere in the schema —
`src/lib/site/content/pricing.ts` publishes a price list and nothing reads it.

So the honest implementation of "controlled by the plan" today is a single
decision point, `resolveWidgetAttribution()`, that answers *always shown*, plus
the seam for the answer to change:
`review_widgets.attribution_suppressed` exists, nothing writes it, and that
function is its only reader. The same posture `monitoring_queries.postal_code`
takes toward the provider upgrade it is waiting on.

The alternative — a checkbox anyone could clear — would not be an
implementation of the brief. It would be giving the paid feature away and
calling it configuration. The settings screen states this in a sentence rather
than showing a disabled toggle, because a control that can never be enabled
invites clicking and implies the capability is one permission away.

## 8. Security and tenancy

```
signed-in path                       anonymous path
──────────────                       ──────────────
server action                        route handler
 └─ authorize("review_widget.manage")  └─ (no session at all)
     └─ OrganizationScope                  └─ review_widget_render(public_id)
         └─ RLS policies                       └─ SECURITY DEFINER, 11 columns
```

### Permissions

`review_widget.manage` — owner, admin, communications_lead. The same three
roles as `brand_voice.update` and `automation_rule.manage`, and it belongs with
them rather than with the integration permissions: all three decide what the
product says without a person in the loop. There is no external account here,
nothing to authorise, nothing to disconnect.

**Location managers are absent**, and this is the one place their absence needs
an argument, because a widget carries a location and `canForLocation` could
scope them to it. Two reasons: `has_organization_role` — which the RLS policies
use to restate this list — cannot express "and only for their own locations",
so the scoping would live in application code alone, and for a surface the
public can see that is not the last line; and a group's marketing site is one
artefact even when the review on it is one restaurant's. If that becomes wrong,
the fix is a policy joining `locations` on `manager_user_id`, not a wider list.

### The anonymous surface is bounded by a type

`ReviewWidgetRenderRow` holds widget configuration and six review fields. No
status, no sentiment, no risk level, no raw payload, no organization id. A
caller cannot widen it, so what anonymous traffic can see is a property of the
type rather than of care at the call site.

`anon` has SELECT on nothing. `review_widget_render` is the entire anonymous
surface, it takes one argument, and section 13 of
`supabase/tests/rls-verification.sql` proves a direct select returns zero rows
while the function returns one. That check exists because adding a permissive
select policy is the obvious wrong repair for the symptom "the widget shows
nothing when signed out".

### No delete policy

"Revoke" is a rotation and "switch off" is a status; both leave the row, and
therefore the record that a widget existed and what it showed. Deleting it
would erase that at exactly the moment somebody is asking why a review
disappeared from their website — the posture `automation_rules` takes with
`archived_at`. A deleted **location** still removes its widget, through the
cascade.

### Escaping

A reviewer's words are attacker-controlled text from a third-party API rendered
into a page on the customer's domain — the textbook shape of a stored XSS, and
the iframe's origin limits the blast radius without removing it. Everything
goes through one `escapeHtml`, both quote forms included because the same
helper writes attribute values.

## 9. The in-app preview, and what it costs

The preview must show a theme somebody just clicked against a review they just
picked, before either has reached the database — so it cannot go through
`reviewWidgets.render()`, and it resolves the review in TypeScript using the
shared eligibility predicate.

**Stated plainly:** on a Supabase deployment the public embed resolves in SQL
and the preview resolves in TypeScript. Both mirror the same rule list, but
they are two implementations, so a preview is a faithful rendering of the
*predicate* rather than a byte-for-byte replay of the public response. What
cannot differ is how it looks: both go through the same
`resolveRenderedWidget` → `renderReviewWidgetDocument`, so a divergence could
only ever be *which* review appears.

The alternative was framing the live public URL, which would be exact and would
also mean a customer could not see a theme change until after they had
published it.

### The empty state shows the widget, not a description of it

An organization with no locations cannot be shown its own review, and the
screen that says so is the screen where somebody decides whether the feature is
worth connecting a Google account for. So `/integrations/review-widget` draws
both themes filled with an invented review (`src/lib/widgets/sample.ts`),
framed through the same route the live preview uses in its `sample` mode — the
teaser is rendered by the code that renders the real embed, and so cannot
promise a card the product does not ship.

Three things this costs, and why each is paid:

- **The sample branch answers before `getOrganizationContext()`.** It reads no
  location, no mention, no profile. The empty state is shown to every member of
  a new organization, including the ones who will never hold
  `review_widget.manage`, and gating a fixed string of fiction behind a
  permission check on data it never touches would blank the frame for them for
  nothing. Headers are unchanged: `frame-ancestors 'self'`, `no-store`,
  `noindex`.
- **A fabricated review exists in the codebase.** It is generic by
  construction — no cuisine, no city, no business name — it is never served
  under a public id, and the card underneath it says in plain text that it is
  an example. That sentence is not small print; it is the reason the rest of
  this feature's care about real reviews stays credible.
- **"Read on Google" points at Google Maps itself.** The footer is part of what
  the widget looks like, so the teaser draws it, and a fabricated `?cid=` would
  be a link to a business that does not exist.

The same screen's empty state also routes somebody onward rather than leaving
them at a dead end: the Google OAuth form when no account is connected and they
may connect one, location selection when an account is connected, and the
integrations screen otherwise. A button that lands on a screen saying *you
cannot do this here* is worse than no button.

## 10. Operational runbook

### "My widget shows nothing"

In order:

1. Is the widget switched off? The card says so on the page itself.
2. Was the embed code regenerated? The page will say "no longer available" —
   copy the current code.
3. Has the location got a Google review that passes §2? The configuration
   screen lists every review with the reason each ineligible one was refused.
4. Is the site's domain on the approved list, or is the list empty? A blocked
   frame leaves a `frame-ancestors` violation in the browser console.

### "The widget is the wrong height"

The loader sizes it from a message the document posts. If the frame is stuck at
its 220px placeholder, the message is not arriving: check that the host page's
console shows no CSP error, and that `APP_URL` on the deployment matches the
origin the snippet points at — the loader ignores messages from any other
origin, by design.

### Rotating an embed id by mistake

Not recoverable from Lia. The old id is in the audit trail
(`review_widget.embed_id_rotated`, both ids recorded) but a rotated id cannot
be reinstated — `public_id` is uniquely indexed and the value is gone. Paste
the new snippet.

### Demo mode

The public embed works in demo mode. It did not until the demo store moved onto
`globalThis`: Next compiles pages, server actions, and route handlers into
separate module graphs, each with its own copy of every module, so a widget
saved through the app was invisible to the route handler in the same process
seconds later. See the comment on `STORE_KEY` in
`src/lib/data/demo/store.ts` — this feature is simply the first with a public
route handler reading rows the app writes.

## 11. Verifying it

```
npm run verify                    # lint, typecheck, 2300+ vitest, build
npm run db:verify-review-widget   # migrations + RLS + the eligibility harness
```

The second matters more than it looks. `public.review_widget_render` is a
hand-written mirror of a TypeScript predicate and **nothing in the vitest suite
can execute it** — `tests/review-widget-eligibility.test.ts` can only prove the
migration *names* each rule in a comment.
`supabase/tests/review-widget-verification.sql` is the other half: it builds
eight reviews at one location, each newer than the control and each failing
exactly one rule, and asserts the control still wins. A rule missing from the
SQL loses that contest.

It also pins what the function may return (eleven named columns), that a
disabled widget still returns its row, that a pinned review that stops
qualifying serves *nothing* rather than a substitute, and — at the two
different layers that actually apply — that `anon` holds no grant on
`review_widgets` while `mentions` is closed by RLS with the grant still in
place. That last distinction is why the migration writes an explicit
`revoke all ... from anon` instead of trusting the absence of a policy:
Supabase grants both roles broad table privileges on `public` by default.

Section 13 of `supabase/tests/rls-verification.sql` covers the policies:
cross-tenant reads, the write role set, `anon` executing the function, and the
absence of any delete path.

## 12. Rollback

Postgres enums cannot have values removed and a check constraint's previous
definition is not recoverable from the catalog, so rolling back
`20260820000400_review_widget_audit_vocabulary.sql` means a forward-repair
migration restating the prior list; `review_widget` simply stops being written
to `audit_entity_type`.

`20260820000200` and `20260820000300` drop cleanly (`drop table
public.review_widgets cascade; drop function public.review_widget_render(text);`)
— but every snippet in every customer website stops resolving at that moment,
and unlike a rotation there is no new code to paste. Switch the widgets off and
tell the customers first.

## 13. What is not built

- Photo and video layouts. `layout` is the seam; nothing else assumes one.
- More than one widget per location (`review_widgets_one_per_location`). When
  a customer genuinely needs a light one and a dark one, drop the constraint
  and add a `name` column — strictly smaller than un-picking the ambiguity a
  nameless second row would create.
- Impressions, clicks, or any analytics. An empty events table is how a product
  acquires a metric nobody asked for and a retention obligation nobody scoped.
- Any source but Google. The eligibility rule `source` is one line.
