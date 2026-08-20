# Reddit — access, approval, and the shape of the integration

Companion to `docs/integrations/google-business-profile.md`. That one documents
a connector that exists; this one documents the paperwork that has to clear
before a Reddit connector may be *used*.

**Status: gated.** The deployment gates exist (`src/lib/env.ts`,
`tests/env-reddit.test.ts`) and resolve to `off` until Reddit's approval is
recorded. No connector, monitor, persistence, or poller exists yet, and
`getConnector("reddit")` still throws. `reddit` is platform-enum vocabulary,
seed fixtures, and the presentation route `/reddit/[id]`. See
`docs/architecture/current-state.md`.

**The approval record is `docs/integrations/reddit-access-approval.md`.** That
file, not this one, is what a live deployment is configured from. This one is
background: how the request works and what the terms are likely to demand.

**Verification note.** Reddit's help centre returns HTTP 403 to automated
fetches, so the specifics below were assembled from search summaries of the
official articles plus secondary reporting, on 2026-08-13. The shape of the
process — request, review, contract — is consistent across every source; the
numbers are not, and the numbers have been moved out of this document's
operational sections into §8, where they are labelled as what they are. Read
the live pages before acting on any of it.

---

## 0. What Lia can actually see

Pinned here because it is the single claim most likely to be overstated on a
marketing page, in a capability card, or in a sales conversation:

> Lia searches matching Reddit posts and monitors comments in those threads;
> it does not search every Reddit comment.

Reddit's `/search` endpoint searches posts — "links" — not the global comment
corpus. Lia discovers posts that match a monitor's terms, then refreshes the
comment trees *inside those posts*. A brand mentioned only in a comment on an
unrelated thread that no monitor matched is not discovered, and no amount of
tuning the monitors changes that. Any copy implying otherwise is wrong, and
`/reddit/[id]`'s capability text has to say the limitation out loud rather than
leaving a customer to infer coverage Lia does not have.

## 1. What Lia needs, and why it is the expensive kind of access

Two decisions set the terms.

**Lia reads and writes.** Reddit's client-credentials grant authenticates as
an application and cannot post. Writing is only possible in a user context, so
Reddit access takes the Google shape rather than the GNews shape: a **web
app**, an authorization-code handshake per organization, a refresh token
sealed in the existing vault, and replies that appear under whichever Reddit
account that organization connected. Pass `duration=permanent` on the
authorize URL or Reddit issues no refresh token and every connection expires
in an hour.

**Lia is commercial.** Reddit defines commercial purposes as any use by a
business, on behalf of a business, or as part of a monetized product or
service. A reputation tool sold to restaurant groups is all three. This is not
a tier you upgrade into later — it decides which queue the request enters on
day one.

## 2. Requesting access

Assume approval gates everything and plan the schedule around it. Whether
self-service registration still exists at all is disputed — see §8 — and it
does not change the plan either way: commercial use needs the agreement
regardless of how the OAuth client was created.

1. **Read the two policies first.** *Developer Platform & Accessing Reddit
   Data* and the *Responsible Builder Policy* (updated 2026-06-05), both in
   the Reddit help centre. Section 5 covers what the second one demands of a
   posting app.
2. **File the request** through Reddit's contact form, linked from the Data
   API wiki. Choose a category — developer, researcher, or moderator. Pick
   **developer**; commercial requests route from there to a separate
   commercial-partner path.
3. **Say plainly that the use is commercial.** Understating it to reach the
   free tier faster is the one move that reliably ends the conversation, and
   the contract terms make it a term breach rather than an oversight.
4. **Wait.** There is no dashboard that flips to active, no published response
   target, and multi-week silences are the common report.
5. **Expect a contract.** Commercial access is granted by agreement, not by a
   checkbox. Budget legal review time as well as calendar time.

### What to put in the request

Reddit asks for the use case, the technical architecture, and the data
handling. Answer as specifically as the repository allows:

| They ask | Lia's answer |
| --- | --- |
| Use case | Reputation monitoring for restaurant groups. Surfacing public discussion about a customer's brands and locations, and posting approved replies on their behalf. |
| Read or write | **Both.** Say so explicitly — a write app is reviewed differently from a monitor. |
| Data retained | Post and comment text, author handle, subreddit, score, timestamp, permalink — tenant-scoped, RLS-enforced. Decide the retention window before you file, because they will ask. |
| Volume | Derive it from the poll interval and query count, not from a guess. |
| Who posts | A Reddit account the customer connects and controls, never a Lia-owned account. |
| Redistribution | None. Reddit data is not sold, licensed, or shared onward. |

## 3. Redirect URIs

Plan for **one** redirect URI per Reddit app, where Google's client takes a
list — so local and production are two separate apps with two separate client
ids. Read the form before relying on this (§8). Register the apex only:
`www.lia.bond` is
redirected to it by `next.config.ts`, and a redirect landing mid-callback
arrives on a host the session cookie does not cover.

| Environment | URI | Where the value lives |
| --- | --- | --- |
| Local | `http://localhost:3000/api/integrations/reddit/callback` | `.env` |
| Production | `https://lia.bond/api/integrations/reddit/callback` | Vercel, sensitive |

Pointing the callback at `lia.bond` does not require anybody to arrive there.
It is a machine-to-machine return path — Reddit sends the browser back to it
mid-handshake — so it works whenever the app is deployed at that host, which
it is, and it is unaffected by where users are acquired.

## 4. Scopes

Request the narrowest set that supports read and write. The Responsible
Builder Policy asks for exactly this restraint, and an over-broad scope list
is a visible reason to reject a review.

| Scope | Why |
| --- | --- |
| `identity` | Which Reddit account the organization connected, for the connection card. |
| `read` | Read posts and comments. |
| `submit` | Post the approved reply. |
| `edit` | Edit or delete a reply Lia posted — required for retraction. |
| `history` | List the connected account's own posts and comments, to reconcile what Lia posted. |

Not `modmail`, not `privatemessages`, not `vote`. If a later feature needs
one, add it then, with a reason.

## 5. What write access obliges

The Responsible Builder Policy applies to bots, AI agents, and non-human
operated accounts. A posting integration inherits all of it:

- **Register the app and keep its developer profile accurate.** Reddit labels
  apps, and circumventing a label is a violation.
- **Disclose automation.** An unlabelled bot reply that reads as a person is
  the thing the policy exists to stop.
- **Subreddit rules bind before Reddit's do.** Many communities ban brand and
  promotional accounts outright, and a technically-permitted reply into one of
  those is still a ban — usually of the customer's account, not Lia's. The
  connector needs a per-subreddit posture, not a global "can post" flag.
- **Rate limits are enforced at IP level.** Exceeding them takes down the
  deployment, not one tenant.
- **All posted content follows the Reddit Rules and the Moderator Code of
  Conduct.**

Product consequence: the approval-first policy in `docs/product-spec.md` is
the floor, not the ceiling. `/reddit/[id]` currently promises "Lia never posts
to Reddit without a named approver", which remains true and sufficient — but
the capability model will also have to state where posting is possible at all,
in the honest register `src/lib/monitoring/capabilities.ts` already uses for
news.

## 6. Rate limits and cost

**There is no public commercial rate limit and no public commercial price.**
Both are negotiated, and both belong in
`docs/integrations/reddit-access-approval.md` once they are known. Do not plan
capacity, cost, or customer count against a figure from anywhere else — this
document included.

Two things are known well enough to build against:

- The free tier's published limit (100 queries/minute per OAuth client id,
  averaged over ten minutes) is **not available to Lia**, because it is
  non-commercial only. Its shape is still informative: the budget is per OAuth
  client, not per customer, so limits are consumed across every tenant at once
  and have to be enforced globally rather than per organization.
- A `User-Agent` in Reddit's requested form is required regardless of tier;
  generic, shared, or absent agents are throttled far harder than identified
  ones. Shape: `<platform>:<app id>:<version> (by /u/<username>)`. `env.ts`
  validates it at startup rather than letting a malformed one degrade into a
  429 in production.

## 7. Sources

- [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data) — Reddit Help
- [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) — Reddit Help, updated 2026-06-05
- [Reddit Data API Terms & Commercial Use (2026)](https://prowlo.com/blog/reddit-data-api) — secondary
- [Reddit Data API in 2026: How to Get Access](https://www.redditapis.com/blogs/reddit-data-api-2026) — secondary, and published by a vendor selling alternatives; weigh accordingly
- [Reddit locks down its public data, says use now requires a contract](https://techcrunch.com/2024/05/09/reddit-locks-down-its-public-data-in-new-content-policy-says-use-now-requires-a-contract) — TechCrunch, 2024

## 8. Research notes — unverified, not product facts

Kept because they were expensive to assemble and are a reasonable starting
point for a conversation with Reddit. **None of it is confirmed**, none of it
was read off an official page, and nothing here may be quoted to a customer,
used to size a roadmap, or encoded in code, tests, or capability copy. The
figures moved here from the operational sections above precisely because they
kept reading as settled when they are not.

| Claim | Sourcing | Status |
| --- | --- | --- |
| Commercial access starts around **$12,000/month** | Secondary reporting only, one of the sources a vendor selling alternatives | Unverified. The single number most worth checking before this feature is committed to a roadmap, and the one most likely to be stale. |
| Self-service app registration closed in late 2025 | Secondary reporting | Unverified. Does not change the plan: commercial use needs the agreement either way. |
| The registration form accepts exactly one redirect URI | Secondary reporting | Unverified. Check the live form; if it takes a list, one app can cover local and production. |

Replace this section with facts from the signed agreement, or delete it, once
`docs/integrations/reddit-access-approval.md` is filled in.
