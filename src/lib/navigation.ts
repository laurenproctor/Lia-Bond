import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  Code2,
  LayoutDashboard,
  LifeBuoy,
  MessageCircle,
  MessagesSquare,
  Newspaper,
  PencilLine,
  Plug,
  Settings,
  Sparkles,
  Star,
  Workflow,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Key into the badge counts supplied by the shell. */
  badgeKey?: "mentions" | "escalations";
  /** Highlight the item for any route beneath this prefix. */
  matchPrefix?: string;
}

export interface NavSection {
  id: string;
  label: string | null;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "work",
    label: "Work",
    items: [
      { label: "Overview", href: "/overview", icon: LayoutDashboard },
      {
        label: "Mentions",
        href: "/mentions",
        icon: MessageCircle,
        badgeKey: "mentions",
      },
      {
        label: "Reviews",
        href: "/reviews",
        icon: Star,
        matchPrefix: "/reviews",
      },
      {
        label: "Reddit",
        href: "/reddit",
        icon: MessagesSquare,
        matchPrefix: "/reddit",
      },
      {
        label: "News and media",
        href: "/media",
        icon: Newspaper,
        matchPrefix: "/media",
      },
      { label: "Responses", href: "/responses", icon: PencilLine },
      {
        label: "Escalations",
        href: "/escalations",
        icon: AlertTriangle,
        badgeKey: "escalations",
      },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    items: [
      { label: "Insights", href: "/insights", icon: BarChart3 },
      { label: "Locations", href: "/locations", icon: Building2 },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    items: [
      { label: "Brand voice", href: "/brand-voice", icon: Sparkles },
      { label: "Rules and automation", href: "/rules", icon: Workflow },
      { label: "Integrations", href: "/integrations", icon: Plug },
      // Nested under /integrations rather than given a route of its own,
      // because `CLAUDE.md` fixes the top-level route list. That nesting is
      // exactly why `isNavItemActive` prefers the most specific match — see
      // the note there.
      {
        label: "Website widgets",
        href: "/integrations/review-widget",
        icon: Code2,
      },
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
  {
    // Unlabelled and last, so it reads as a footer item rather than another
    // part of the product to configure.
    id: "support",
    label: null,
    items: [{ label: "Help", href: "/help", icon: LifeBuoy }],
  },
];

/** The prefix an item claims: its explicit `matchPrefix`, or its own href. */
function navPrefix(item: NavItem): string {
  return item.matchPrefix ?? item.href;
}

/** Every prefix in the sidebar, longest first. */
const NAV_PREFIXES: string[] = NAV_SECTIONS.flatMap((section) =>
  section.items.map(navPrefix),
).sort((left, right) => right.length - left.length);

function matchesPrefix(pathname: string, prefix: string): boolean {
  // Segment match, not `startsWith`: `/reviewsomething` shares a prefix with
  // `/reviews` and is not beneath it. The same rule `src/proxy.ts` applies.
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * True when `pathname` should light up `item` in the sidebar.
 *
 * **The most specific matching item wins, and only that one.** Before the
 * website widget there was no nested entry, so a plain prefix test was
 * sufficient — every item's prefix matched a disjoint set of routes. It is not
 * sufficient now: `Website widgets` lives at `/integrations/review-widget`,
 * which is beneath `Integrations`, and a plain test lights up both. Two
 * highlighted items is not a cosmetic problem — the sidebar is the only thing
 * telling somebody where they are, and it would be saying two contradictory
 * things.
 *
 * Resolved here rather than by giving the widget a top-level route, because
 * `CLAUDE.md` fixes that list; and here rather than in the sidebar component,
 * so anything else that asks "is this item current" gets the same answer.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const prefix = navPrefix(item);
  if (!matchesPrefix(pathname, prefix)) return false;

  // Sorted longest-first, so the first match is the most specific one.
  const winner = NAV_PREFIXES.find((candidate) => matchesPrefix(pathname, candidate));
  return winner === prefix;
}
