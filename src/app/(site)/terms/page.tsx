import type { Metadata } from "next";
import { LegalPage } from "@/components/site/prose";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms that apply to using Lia.",
};

/**
 * PLACEHOLDER COPY. See the note in the privacy page. Legal review is a
 * pre-launch blocker recorded in the design document.
 */
export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms"
      updated="4 August 2026"
      intro="These terms apply to the Lia website and to the Lia product during its launch period. They will be replaced with a reviewed agreement before general availability."
      sections={[
        {
          heading: "Launch period",
          paragraphs: [
            "During the launch period, Lia is provided as-is while we are still building it. Features may change, and we will tell you when they do in a way that affects you.",
            "Launch pricing is held for the first year of a paid subscription that begins during the launch period.",
          ],
        },
        {
          heading: "Your content and your accounts",
          paragraphs: [
            "You keep ownership of everything you connect and everything you publish. You grant Lia permission to read and process it in order to provide the service.",
            "You are responsible for having the authority to connect the platform accounts you connect, and for what is published from them after approval.",
          ],
        },
        {
          heading: "Approval and responsibility",
          paragraphs: [
            "Lia drafts responses. A person on your side approves them. Because publication follows a human decision, responsibility for what is published rests with the person who approved it.",
            "Lia is not legal, medical, or crisis-communications advice, and drafts should not be treated as any of those.",
          ],
        },
        {
          heading: "Billing",
          paragraphs: [
            "Paid plans are billed per location, monthly or annually. You can cancel at any time, effective at the end of the current billing period.",
          ],
        },
        {
          heading: "Ending the agreement",
          paragraphs: [
            "You can stop using Lia at any time and ask us to delete your data. We can end an account for non-payment or for use that breaks these terms, and we will tell you why.",
          ],
        },
      ]}
    />
  );
}
