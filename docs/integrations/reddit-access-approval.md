# Reddit access approval — Gate 0 record

**Status: not completed.** Nothing below is filled in, so
`REDDIT_ACCESS_APPROVAL_REF` must stay unset and `REDDIT_ROLLOUT_STAGE` must
stay `off` or unset. Every live Reddit code path in this repository is gated on
that variable and resolves to `off` without it — see `resolveRedditDeployment`
in `src/lib/env.ts`.

This is the owner's document, not Claude's. It records the outcome of a
conversation with Reddit that has to happen before Lia may call their API
commercially. It is filled in **from the signed agreement**, not from the help
centre, not from this repository's research notes, and not from what a
reasonable person would expect the terms to say.

**Nothing secret goes in this file.** No contract PDF, no client secret, no
Reddit contact's personal details, no signed copy. This file is committed to a
public repository. It records *that* an agreement exists and *what it permits*;
the agreement itself lives wherever the owner keeps contracts.

---

## 1. Why this gate exists

Reddit does not sell API access self-service to commercial users. Lia is
unambiguously commercial — a subscription product, acting on behalf of
businesses, for money — and that means access is granted by a negotiated
agreement rather than by registering an app.

The consequence for this codebase is that "we have a client id and secret" is
not the same fact as "we are allowed to make this call", which is a distinction
none of the other integrations here have to make. Google's gate is a
verification review; GNews's gate is a paid plan. Reddit's gate is a contract
whose terms decide, per feature, what Lia may do — and a deployment that gets
this wrong is not shipping a bug, it is breaching an agreement on a customer's
behalf, usually with the customer's own Reddit account.

So the approval marker is a first-class environment variable rather than a note
in a runbook, and the rollout stage fails to `off` rather than to `read_only`
when it is absent. Reading is covered by the same agreement as posting.

## 2. The record

Fill in every row. A row you cannot answer from the signed agreement is a row
that has not been agreed — leave it blank and do not turn the feature on.

| Field | Value |
| --- | --- |
| Approval date | _(YYYY-MM-DD, the date Reddit granted access)_ |
| Agreement reference | _(the contract's own identifier)_ |
| `REDDIT_ACCESS_APPROVAL_REF` | _(`YYYY-MM-DD:<reference>`, derived from the two rows above)_ |
| Reddit contact | _(role or team, not a personal address)_ |
| Renewal / review date | _(when this record stops being true)_ |

### Approved features

Each row is a separate permission. A feature not explicitly approved is not
approved by implication, and the corresponding capability stays off.

| Feature | Approved? | Terms or limits |
| --- | --- | --- |
| Post search by keyword | _(yes / no)_ | |
| Comment retrieval within matched threads | _(yes / no)_ | |
| Storage of post and comment content | _(yes / no)_ | |
| Display to the customer's own team | _(yes / no)_ | |
| AI inference — classification and risk | _(yes / no)_ | sets `REDDIT_AI_INFERENCE` |
| AI inference — draft generation | _(yes / no)_ | sets `REDDIT_AI_INFERENCE` |
| Human-approved comment submission | _(yes / no)_ | sets `REDDIT_ROLLOUT_STAGE=read_write` |
| Deletion of a reply Lia posted | _(yes / no)_ | |

`REDDIT_AI_INFERENCE=permitted` requires **both** inference rows to be yes.
They are one variable today because Lia has no use for classification without
drafting or the reverse; if the agreement splits them, split the variable
before shipping rather than rounding up.

### Account model

The question this section answers is the one most easily assumed wrong, and it
must be answered **in writing by Reddit** rather than inferred from OAuth
documentation:

| Question | Answer |
| --- | --- |
| May a restaurant's existing, customer-controlled Reddit account be connected? | |
| Does Reddit treat that account as an "app account"? | |
| What labelling or disclosure must appear on a reply Lia submits? | |
| Does the connected account need a developer profile of its own? | |

If labelling is required, it is a **product** change, not a formatting one: the
disclosure has to be visible to the approver in the composer before they
approve, because Lia never mutates approved text on its way to the provider.

### Scopes

Planned maximum is `identity read submit edit history`. Record what was
actually approved — the connector intersects configured capability, contract
permission, and scopes genuinely returned by the grant, so a scope withheld
here turns a capability off rather than producing a hopeful button.

| Scope | Approved? | Note |
| --- | --- | --- |
| `identity` | | Which account is connected, for the connection card. |
| `read` | | Posts and comments. |
| `submit` | | The approved reply. |
| `edit` | | Retraction only. Lia does not edit published text. |
| `history` | | Reconciling an uncertain publish against the account's own recent comments. |

### Rate and volume terms

There is no published universal commercial rate limit. Record what was
negotiated; do not carry over the free tier's 100 queries/minute, and do not
encode any figure from this repository's research notes as a product fact.

| Field | Value |
| --- | --- |
| Request limit | |
| Averaging window | |
| Permitted customer organizations | |
| Permitted subreddits or content classes | |
| Cost | |

### Retention and deletion

The number in the first row is the one Task 15 reads. It has no safe default —
a shorter window than agreed loses customer data, a longer one breaches the
agreement — so the configuration fails closed and the feature stops discovering
new content rather than exceeding the window.

| Field | Value |
| --- | --- |
| Maximum retention of Reddit content | |
| Deadline to honour a deletion upstream | |
| Whether deleted content must be purged or may be redacted | |
| Whether derived artefacts (analyses, draft context snapshots) are in scope | |
| Incident contact and notification obligation | |

### Launch scheduler

Reddit monitoring is only monitoring if it runs often enough to be worth the
name. The current Vercel Hobby configuration polls **once daily**, which is a
digest, not timely reputation monitoring, and it must be upgraded before this
feature is described to a customer as monitoring.

| Field | Value |
| --- | --- |
| Scheduler at launch | |
| Poll cadence | |
| Worst-case customer-facing latency | |

## 3. What Claude may build before this is signed

Tasks 1–5 of the Reddit plan, in deterministic mock mode: the deployment gates,
the domain vocabulary and capability model, the database schema, the ingest and
attribution contract, and the connector boundary with its fixture
implementation. None of it makes a network request to Reddit.

Everything after that — live OAuth, live polling, AI processing of Reddit
content, and posting — waits for this document. The stopping point is not a
matter of judgement at the time: `resolveRedditDeployment` returns `off` while
`REDDIT_ACCESS_APPROVAL_REF` is unset, so the live paths are unreachable rather
than merely discouraged.

## 4. Re-check before launch

These are the authorities. Read them again when this document is filled in, and
again immediately before the first live customer poll — the terms have changed
materially more than once, and this repository's summary of them is a snapshot,
not a source.

- [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)
- [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- [Data API Terms](https://redditinc.com/policies/data-api-terms)
- [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- [OAuth and endpoint documentation](https://www.reddit.com/dev/api/oauth/)

Background and the request process: `docs/integrations/reddit.md`.
