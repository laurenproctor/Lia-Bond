import type { IndustrySlug } from "@/lib/site/routes";

/**
 * Per-industry copy for `/for/[industry]`.
 *
 * The four pages differ only in language, so they share one template and this
 * record supplies everything variable. Adding a fifth vertical means an entry
 * here, an entry in `INDUSTRIES`, and nothing else.
 */

export interface IndustryContent {
  /** Sentence-case page heading. */
  heading: string;
  lede: string;
  /** Three pressures specific to the vertical. */
  pressures: readonly { title: string; body: string }[];
  /** One illustrative quote for the hero bubble. */
  quote: { text: string; attribution: string };
  metaDescription: string;
}

export const INDUSTRY_CONTENT: Record<IndustrySlug, IndustryContent> = {
  hotels: {
    heading: "Every stay ends in a review somebody else reads.",
    lede: "Hotel reputation is decided across Google, the booking sites, and a dozen review pages at once — usually while your front desk is busy with the guests already in the building.",
    pressures: [
      {
        title: "One bad night travels",
        body: "A single review about a room, a rate, or a late check-in outranks a hundred quiet good stays. Lia flags the ones with reach before they settle into your rating.",
      },
      {
        title: "Every property sounds different",
        body: "Regional managers write in their own register and it shows. A shared brand voice keeps the replies recognisably yours without scripting them.",
      },
      {
        title: "Some complaints are not reviews",
        body: "Accessibility, safety, and discrimination claims need a named person, not a template. Those route to someone before anything is published.",
      },
    ],
    quote: {
      text: "Every property sounds like us now.",
      attribution: "Group operations director",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for hotels and hotel groups, across Google and the review sites guests actually read.",
  },
  restaurants: {
    heading: "The dining room closes. The reviews do not.",
    lede: "Service ends and the posting starts — Google, Yelp, Reddit threads, and the local food press, all at once, usually after the manager has gone home.",
    pressures: [
      {
        title: "Volume beats attention",
        body: "A busy group can take hundreds of reviews a week. Lia reads all of them and tells you which twelve are worth your evening.",
      },
      {
        title: "Food safety is not a review",
        body: "An illness claim is a legal and operational event. It is held, escalated, and never answered by an automated draft.",
      },
      {
        title: "The same complaint, four locations",
        body: "When wait times spike across a region, that is an operations problem wearing a reviews costume. Lia surfaces the pattern.",
      },
    ],
    quote: {
      text: "Five stars, genuinely earned.",
      attribution: "Restaurant guest · Yelp",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for restaurants and restaurant groups, across Google, Yelp, Reddit, and local press.",
  },
  "salons-and-barbershops": {
    heading: "Your chair is booked on your reviews.",
    lede: "Most new clients read three reviews before they book, and almost all of them are about one stylist rather than the shop.",
    pressures: [
      {
        title: "Reviews name individuals",
        body: "A complaint about one stylist reads as a complaint about the shop. Replies need to answer the guest without publicly disciplining staff.",
      },
      {
        title: "Small teams, no comms person",
        body: "Nobody on the floor has an afternoon for drafting. Lia writes the reply; you approve it between clients.",
      },
      {
        title: "Results are subjective",
        body: "A colour that did not land is a genuine disappointment and not necessarily a mistake. That distinction belongs in the reply.",
      },
    ],
    quote: {
      text: "Replies go out the same day now.",
      attribution: "Salon owner",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for salons and barbershops, built for small teams without a communications person.",
  },
  "med-spas": {
    heading: "Regulated care, reviewed in public.",
    lede: "Clients discuss outcomes, pricing, and side effects in the open — and your reply is subject to rules that do not apply to a restaurant.",
    pressures: [
      {
        title: "Privacy limits what you can say",
        body: "Confirming that someone was a client at all can be a disclosure. Lia drafts replies that respond without acknowledging treatment.",
      },
      {
        title: "Outcome claims carry risk",
        body: "A reply promising a result is a claim someone can hold you to. Sensitive threads escalate to a named reviewer before anything publishes.",
      },
      {
        title: "Trust is the whole funnel",
        body: "Prospective clients read how you handle criticism more closely than they read the praise. Consistency matters more than speed.",
      },
    ],
    quote: {
      text: "Careful replies, without the wait.",
      attribution: "Practice manager",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for med spas, with privacy-aware drafts and escalation before anything is published.",
  },
};
