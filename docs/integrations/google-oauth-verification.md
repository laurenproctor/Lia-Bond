# Google OAuth verification

Everything in this file happens in the Google Cloud Console, not in the
repository. It is written down because none of it is discoverable from the
code, all of it blocks real customers, and the failure modes arrive as opaque
consent-screen errors rather than as anything a log will tell you.

Companion to `google-business-profile.md` §16, which covers creating the
project, enabling the three APIs, and issuing the OAuth client. Start there.
This file picks up once a client exists and the question becomes who is allowed
to use it.

## 1. There are two approvals, and they are not the same one

Conflating these costs weeks, because each is invisible while you wait on the
other.

| | What it gates | Where |
| --- | --- | --- |
| **OAuth verification** | Whether users see a scary warning, and how many may ever consent | Google Auth Platform → Verification |
| **Business Profile API access** | Whether the endpoints return data at all | [Prerequisites form](https://developers.google.com/my-business/content/prereqs) |

Passing OAuth verification with no API access approval leaves you with a clean
consent screen and an API that refuses to serve reviews. The reverse leaves you
with working endpoints nobody can reach. Submit both in the same sitting.

## 2. Publishing status decides more than it looks like it does

The *Audience* page offers **Testing** and **In production**. It reads like a
label. It is not.

**Testing.** Up to 100 manually-added test users. Anyone not on the list gets
`Error 403: access_denied` — "has not completed the Google verification
process". The consequential part is elsewhere, though: for an external user
type in Testing, **every refresh token expires after 7 days**.

That last one is worth dwelling on, because it presents as a product bug rather
than as a console setting. Lia holds a refresh token so it can sync without the
customer present. Under Testing, Google invalidates it weekly. The code already
handles this correctly and visibly — `invalid_grant` is recognised in
`client.ts`, the connection moves to `action_required` in `google-service.ts`,
and reconnecting sets `prompt=consent` so a genuinely new refresh token is
issued rather than a silent re-approval that returns none. So the symptom is an
honest "action required" every seven days, not silent data loss. It is still
not something to ship to a customer.

**In production.** Anyone with a Google Account may consent, and the 7-day
expiry is gone. Publishing is one click and does *not* require verification
first. Until verification completes, two things persist:

- The **unverified app screen** — users must click *Advanced → Go to lia.bond
  (unsafe)* to continue. Survivable internally. Not something to put in front of
  a restaurant group.
- A cap of **100 new users, for the lifetime of the project**. Google's wording
  is that it "cannot be reset or changed". There is no form, no support
  escalation, and no paid tier. One connected Google account is one slot.

Do not attempt to reset the cap with a fresh Cloud project. Google states
plainly that this does not bypass the limitation, and for Lia it would be
actively destructive: stored credentials are encrypted refresh tokens bound to
one client id, so rotating the client invalidates every one of them and sends
every connected location to `action_required` at once.

The only thing that removes the cap is verification.

## 3. Submitting

The order matters, and not for tidiness: each step unlocks the next, and one of
them starts a clock.

**Step 0 — verify the domain.** In [Google Search
Console](https://search.google.com/search-console), verify `lia.bond` from an
account holding **Owner or Editor** on the property — and it must be the same
Google account that owns the Cloud project. A domain verified under a different
account does not count, and nothing downstream will tell you that is the
problem.

**Step 1 — Branding, then Verify Branding.** *Google Auth Platform → Branding*:
app name, 120×120 logo, user support email, developer contact email, app
homepage, privacy policy link, terms link. The app name must match what the
homepage calls itself. Then click **Verify Branding**.

This is an automated check that usually returns within minutes and leaves the
status at "Ready to publish". That status **expires after 7 days**, after which
it has to be re-verified — so do not run it until ready to carry on through the
remaining steps.

**Step 2 — publish.** *Audience → Publish app*. The submission path opens once
the app is in production; see §2 for what publishing changes.

**Step 3 — declare the scope.** *Data Access → Add or remove scopes* → add
`https://www.googleapis.com/auth/business.manage` → **Update**. The console
sorts it into the sensitive table by itself.

**Step 4 — submit.** In the **OAuth Verification Center**, click **Submit for
verification**. The dialog wants:

- a justification for each sensitive scope, *and* a separate explanation of why
  a narrower scope is insufficient — a required field, not a courtesy. §4.
- the demo video URL, unlisted on YouTube. §5.
- up to three documentation links for the related features, if any exist.

**Step 5 — the other approval.** Submit the [Business Profile API access
request](https://developers.google.com/my-business/content/prereqs). §1.

### Afterwards

Google's own documentation says verification "can take up to 10 days". Treat
that as the figure to plan against and anything longer as slippage rather than
as the expectation — third-party write-ups quoting four to six weeks are
describing bad cases, often self-inflicted ones.

Correspondence arrives by email, to the developer contact address *and* the
support email on the consent screen. Watch both, and watch the Verification
Center status page. This is where the elapsed time actually goes: a request for
clarification sitting unanswered for a week adds a week, and that is the usual
reason a ten-day review becomes a month.

`business.manage` is *sensitive*, not *restricted*, so it does not trigger a
CASA Tier 2 security assessment — the 2–6 month path that applies to Gmail and
Drive content scopes, which Lia deliberately does not request.

## 4. Scope justification

One scope is requested: `https://www.googleapis.com/auth/business.manage`.

The canonical justification lives in code, at
`src/integrations/google-business-profile/scopes.ts`, in
`GOOGLE_SCOPE_RATIONALE` and `GOOGLE_SCOPES_DELIBERATELY_OMITTED`. It is kept
there rather than only here because the same text renders on the integration
detail screen, so a customer's administrator reads the identical justification
the reviewer did. **Copy it from there at submission time** rather than from
this file, which will drift.

The shape of the argument, for whoever is filling in the form:

- **Why this scope, and why nothing narrower.** These are two separate fields on
  the form, and the second is where submissions get sent back. Google gates
  account discovery, location discovery, and review management behind one scope;
  there is no read-only variant; requesting less is not an option Google offers.
  Say that plainly rather than leaving the reviewer to establish it. The answer
  to "could you have asked for less" is "no", and it is defensible.
- **What it is used for.** Listing the Business Profile accounts the user
  administers; listing locations under a selected account; importing reviews for
  a connected location; confirming the grant is still valid during a health
  check. Four operations, all of them user-initiated or on the customer's
  behalf.
- **What is not requested.** `openid`, `userinfo.email`, `userinfo.profile`, and
  the deprecated `plus.business.manage`. The connected Google identity is
  established from the Business Profile account listing itself, so an identity
  scope would add access without adding capability. Reviewers respond well to a
  developer who can name what they chose not to ask for.

## 5. Demo video

Recorded to YouTube; unlisted is fine. This is the item most often sent back,
and almost always for the same omission.

Must be in English, and must show:

1. **The homepage at `lia.bond`**, briefly — establishes that the app in the
   video is the app on the form.
2. **The consent screen, with the browser URL bar visible and legible.** The
   reviewer is checking that the `client_id` in the URL matches the client under
   review. A recording cropped to the consent dialog gets rejected. This is the
   omission.
3. **The scope being granted** — the `business.manage` permission as Google
   phrases it on the screen.
4. **The granted data in use inside Lia.** Land back on the setup screen,
   map a location, sync reviews, and show the imported reviews on the mentions
   or review detail screen. The question being answered is "what does this app
   do with the access", and only this part answers it.

A single unbroken screen recording of connecting one location and syncing its
reviews covers 2 through 4. Roughly two minutes.

## 6. Privacy policy

`src/app/(site)/privacy/page.tsx`, served at `https://lia.bond/privacy` and
linked from the site footer via `src/lib/site/routes.ts`.

Reviewers check the policy against the grant, and a generic policy that never
names Google is the most common rejection. The **Google user data** section
exists for this and must keep saying what the product actually does: what
`business.manage` reads, which review fields are stored, that review text, star
rating, and reviewer display name are sent to Anthropic's API when someone asks
for a draft, that refresh tokens are AES-256-GCM encrypted before storage with
the key outside the database, and how a customer revokes.

It ends with the Limited Use affirmation, which the Google API Services User
Data Policy requires to appear in the policy itself:

> Lia's use and transfer of information received from Google APIs to any other
> app will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

Do not delete that sentence to tidy the page. Change what Lia does with Google
data and that section changes in the same commit — and if the shape of the
grant changed, the app is re-submitted.

The rest of the page is still placeholder copy pending legal review.

## 7. Redirect URIs

Every environment's callback must be registered on the OAuth client, exactly,
and must match `GOOGLE_OAUTH_REDIRECT_URI` in that environment's configuration.
Google compares strings: scheme, host, port, and path, with no trailing slash.

| Environment | URI |
| --- | --- |
| Local | `http://localhost:3000/api/integrations/google-business-profile/callback` |
| Production | `https://lia.bond/api/integrations/google-business-profile/callback` |

Register the apex only. `www.lia.bond` redirects to the apex, and a redirect
landing mid-callback would arrive on a host the session cookie does not cover.

Two things make this harder to debug than it should be. The redirect URI is
stored as a *sensitive* variable in Vercel, so `vercel env pull` returns it
empty and the configured value cannot be read back — the only reliable evidence
of what production is sending is the `redirect_uri=` Google echoes in the error
page. And an env change requires a redeploy: `vercel redeploy <production-url>`
rebuilds the existing deployment against current values, which is what you want
here. `vercel --prod` would upload the local working tree instead.

Moving the app to a custom domain means changing the redirect URI in *two*
places that have no knowledge of each other — the hosting environment and the
Google client. Changing `APP_URL` alone does not move the callback.

## 8. Consent-screen errors

| Screen says | Cause | Fix |
| --- | --- | --- |
| `Error 400: redirect_uri_mismatch` | The `redirect_uri` sent is not registered on the client. Google echoes the offending value in *Request details* — read it, it is definitive. | Register it, or correct `GOOGLE_OAUTH_REDIRECT_URI` and redeploy. §7. |
| `Error 403: access_denied`, "has not completed the Google verification process" | App is in Testing and this account is not a test user. | Add the account under *Audience → Test users*, or publish. §2. |
| "Google hasn't verified this app" | Published, sensitive scope, verification not yet granted. | Expected. *Advanced → Go to lia.bond (unsafe)* until verification lands. §2. |
| Connections all move to `action_required` weekly | The Testing-mode 7-day refresh token expiry. | Publish. §2. |
