/**
 * Home page copy.
 *
 * The six stages are the product's own workflow, named the same way it names
 * them internally (`manifest.json`), so the marketing promise and the product
 * vocabulary do not drift apart.
 */

export interface Stage {
  name: string;
  description: string;
}

export const HOME_STAGES: readonly Stage[] = [
  {
    name: "Detect",
    description:
      "Reviews, Reddit threads, press, and supported article comments arrive in one place, matched to the right brand and location.",
  },
  {
    name: "Understand",
    description:
      "Every mention is read for sentiment, topic, relevance, and risk — so a slow Tuesday service and a food-safety claim are never the same task.",
  },
  {
    name: "Decide",
    description:
      "Lia recommends whether to respond at all. Not everything deserves a reply, and saying so is part of the job.",
  },
  {
    name: "Respond",
    description:
      "Drafts come back in your voice, shaped for the platform they are going to, ready for a person to approve.",
  },
  {
    name: "Escalate",
    description:
      "Anything sensitive routes to the people who should see it first, with the full thread and a clear reason attached.",
  },
  {
    name: "Learn",
    description:
      "Recurring complaints surface as patterns across locations, so the same problem stops arriving one review at a time.",
  },
] as const;

export const HOME_JUDGMENT = {
  eyebrow: "Our approach",
  heading: "The judgment is the product.",
  body: [
    "Drafting a reply is the easy part. Knowing which reviews deserve one, which need a manager before anything is published, and which are better left alone — that is the work, and it is where a generic assistant does damage.",
    "So Lia is approval-first by construction. Sensitive mentions are held, never auto-sent. Every connector declares what it can actually do, and the interface never offers to publish somewhere it cannot. When a platform has no reply surface, Lia says so rather than pretending.",
  ],
  points: [
    {
      title: "Nothing publishes itself",
      body: "Drafts wait for a person. Approval is the default, not a setting you remember to switch on.",
    },
    {
      title: "Capabilities are explicit",
      body: "Each platform declares whether Lia can read, draft, or publish. You are never shown a button that will not work.",
    },
    {
      title: "Everything is on the record",
      body: "Who drafted, who approved, what changed, and when. The audit trail is not an add-on.",
    },
  ],
} as const;
