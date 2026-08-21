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
  /**
   * Further prefixes this item claims, for routes that are siblings in the URL
   * but children in the product.
   *
   * `Website widgets` lives at `/integrations/website-widgets` and owns
   * `/integrations/review-widget` and `/integrations/press-widget`, neither of
   * which is beneath it. The alternative was moving the two configurators
   * under the landing route — which would have broken every saved link to
   * `/integrations/review-widget`, a URL that has been in the product's
   * navigation and in customers' browser history since the review widget
   * shipped.
   */
  alsoMatches?: string[];
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
      //
      // `matchPrefix` is `/integrations/website-widgets` and the href points
      // at it, but the item must also light up on the two configurators
      // beneath it — which are siblings in the URL, not children. That is what
      // `alsoMatches` is for. Without it, opening the press configurator would
      // highlight `Integrations` instead, and the sidebar would be telling
      // somebody they are somewhere they are not.
      {
        label: "Website widgets",
        href: "/integrations/website-widgets",
        icon: Code2,
        alsoMatches: ["/integrations/review-widget", "/integrations/press-widget"],
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

/** Every prefix an item claims: its `matchPrefix` or href, plus `alsoMatches`. */
function navPrefixes(item: NavItem): string[] {
  return [item.matchPrefix ?? item.href, ...(item.alsoMatches ?? [])];
}

/** Every prefix in the sidebar, longest first. */
const NAV_PREFIXES: string[] = NAV_SECTIONS.flatMap((section) =>
  section.items.flatMap(navPrefixes),
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
 * website widgets there was no nested entry, so a plain prefix test was
 * sufficient — every item's prefix matched a disjoint set of routes. It is not
 * sufficient now: `Website widgets` lives beneath `Integrations`, and a plain
 * test lights up both. Two highlighted items is not a cosmetic problem — the
 * sidebar is the only thing telling somebody where they are, and it would be
 * saying two contradictory things.
 *
 * An item may claim several prefixes (`alsoMatches`), because the two widget
 * configurators are siblings of the landing route rather than children of it.
 * The longest-first sort still decides the winner; the item then asks whether
 * the winner is one of *its* claims rather than whether it equals its own
 * href.
 *
 * Resolved here rather than by giving the widget a top-level route, because
 * `CLAUDE.md` fixes that list; and here rather than in the sidebar component,
 * so anything else that asks "is this item current" gets the same answer.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const claimed = navPrefixes(item);
  if (!claimed.some((prefix) => matchesPrefix(pathname, prefix))) return false;

  // Sorted longest-first, so the first match is the most specific one.
  const winner = NAV_PREFIXES.find((candidate) => matchesPrefix(pathname, candidate));
  return winner !== undefined && claimed.includes(winner);
}
