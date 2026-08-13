import type { Metadata } from "next";
import { LegalPage } from "@/components/site/prose";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Lia collects, why, and what we do not do with it.",
};

/**
 * PLACEHOLDER COPY. Written to describe the system honestly and to fill the
 * footer's link — not reviewed by a lawyer. The design document lists legal
 * review as a pre-launch blocker.
 *
 * The "Google user data" section is the exception to "placeholder": Google's
 * OAuth verification reviewers read this page and check it against what the
 * `business.manage` grant actually does, so it describes the real code path —
 * `src/lib/crypto/token-vault.ts` for the credential handling, and
 * `src/lib/responses/drafting-context.ts` for what leaves for model inference.
 * It also carries the Limited Use affirmation, which the Google API Services
 * User Data Policy requires to appear in the policy verbatim. Changing what
 * the product does with Google data means changing that section in the same
 * commit, and re-submitting if the grant's shape changed.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy"
      updated="13 August 2026"
      intro="This page describes what Lia collects from visitors to this website and from customers using the product. It is written to be read rather than to be survived."
      sections={[
        {
          heading: "What this website collects",
          paragraphs: [
            "If you submit the contact form, we store the email address you enter, plus the business name and page you submitted from when those are provided. That is the entire record.",
            "We use it to reply to you. We do not sell it, and we do not add it to a marketing list you did not ask for.",
          ],
        },
        {
          heading: "What the product collects",
          paragraphs: [
            "Lia reads public content — reviews, posts, comments, and articles — from the platforms a customer connects, using credentials that customer grants and can revoke.",
            "Customer account data covers the people in an organization, their roles, and what they did in the product. Actions that change customer data are recorded in an audit trail.",
            "Platform credentials are encrypted and stored separately from the records that reference them. They are never returned to a browser.",
          ],
        },
        {
          heading: "Google user data",
          paragraphs: [
            "When a customer connects a Google Business Profile, Lia asks Google for one permission: business.manage. Google does not offer a narrower, read-only version of it. We do not ask for the customer's Google profile, email address, Gmail, or Drive.",
            "That permission lets Lia read the Business Profile accounts and locations the signed-in Google user administers, and the reviews on the locations they choose to connect. From each review we store Google's identifier for it, the star rating, the review text, the reviewer's display name and avatar as Google supplies them, the timestamps, and any reply the business has already posted. We store nothing Google does not return, and we invent nothing it leaves blank.",
            "We use that data to show reviews in the product, to draft replies for a person to approve, and to produce reputation reporting for the customer who connected the profile. We do not use it for advertising, we do not sell it, and we do not use one customer's Google data to build features for another.",
            "Drafting a reply sends the review text, its star rating, and the reviewer's display name to Anthropic's API, which generates the draft. Nothing is sent until someone asks for a draft, and Anthropic does not train models on data submitted through its API. No other third party receives Google user data.",
            "The credentials Google issues are encrypted with AES-256-GCM before they reach our database, and the key is held in the environment rather than in the database, so a copy of the database alone decrypts nothing. Credentials are never returned to a browser.",
            "A customer can revoke Lia's access at any time, either by disconnecting the profile in Lia or from their Google account's permissions page. Disconnecting deletes the stored credentials. Reviews already imported are deleted with the rest of the customer's data on request, and otherwise at the end of the account.",
            "Lia's use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
          ],
        },
        {
          heading: "What we do not do",
          paragraphs: [
            "We do not publish anything on a customer's behalf without a person approving it.",
            "We do not use one customer's content to train models for another.",
            "We do not sell personal data.",
          ],
        },
        {
          heading: "Retention and deletion",
          paragraphs: [
            "Contact-form records are kept until you ask us to delete them, or until the conversation they belong to is closed.",
            "Customer data is retained for the life of the account. On request we delete it, subject to records we are legally required to keep.",
          ],
        },
        {
          heading: "Getting in touch",
          paragraphs: [
            "To ask what we hold about you, or to have it deleted, use the contact page. We will confirm what we did.",
          ],
        },
      ]}
    />
  );
}
