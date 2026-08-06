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
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy"
      updated="4 August 2026"
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
