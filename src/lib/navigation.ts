import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
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

/** True when `pathname` should light up `item` in the sidebar. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const prefix = item.matchPrefix ?? item.href;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
