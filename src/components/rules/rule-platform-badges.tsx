import { PlatformGlyph } from "@/components/ui/source-badge";
import { PLATFORM_LABELS, PLATFORM_SHORT_LABELS } from "@/lib/labels";
import { rulePlatformScope, type RulePlatformScope } from "@/lib/rules/platform-scope";
import { cn } from "@/lib/cn";
import type { RuleCondition } from "@/domain";

/**
 * Which platforms a rule affects, as badges.
 *
 * Reads `rulePlatformScope`, so what is shown is derived from the rule's own
 * conditions and cannot disagree with what the evaluator would do. The glyphs
 * are the existing `PlatformGlyph` from `SourceBadge` rather than a second set
 * of marks — a rule scoped to Google should carry the same blue "G" that every
 * Google mention in the product does.
 *
 * A server component. It renders no interactive state, so the rules list and
 * the detail page pay nothing for it; the builder wraps it in its own client
 * component to recompute while conditions are edited.
 *
 * The two empty cases are rendered as text rather than as an absence. A rule
 * that can never fire looks identical to one that fires everywhere if the
 * answer to "which platforms" is simply no badges at all.
 */

const EMPTY_SCOPE_TEXT: Record<
  Extract<RulePlatformScope, { kind: "none" }>["reason"],
  string
> = {
  // Deliberately about *matching*, not about platforms: the reason this rule
  // reaches no platform is that it reaches nothing, and pointing at the
  // conditions is the only actionable thing to say.
  no_conditions: "No conditions yet — matches nothing",
  contradictory: "Conditions conflict — matches nothing",
};

export interface RulePlatformBadgesProps {
  conditions: readonly RuleCondition[];
  /** Short labels ("Google", "News") for dense rows like the rules table. */
  short?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function RulePlatformBadges({
  conditions,
  short = false,
  size = "sm",
  className,
}: RulePlatformBadgesProps) {
  const scope = rulePlatformScope(conditions);

  if (scope.kind === "none") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[12px] font-medium text-gray-950",
          className,
        )}
      >
        {EMPTY_SCOPE_TEXT[scope.reason]}
      </span>
    );
  }

  if (scope.kind === "all") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[12px] font-medium text-gray-700",
          className,
        )}
      >
        All platforms
      </span>
    );
  }

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {scope.platforms.map((platform) => (
        <span
          key={platform}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 py-0.5 pr-1.5 pl-0.5"
        >
          <PlatformGlyph platform={platform} size={size} />
          {/*
            The glyph already carries the platform name as its accessible
            label, so this text is redundant to a screen reader and is hidden
            from it rather than read twice.
          */}
          <span className="text-[12px] font-medium text-gray-700" aria-hidden>
            {short ? PLATFORM_SHORT_LABELS[platform] : PLATFORM_LABELS[platform]}
          </span>
        </span>
      ))}
    </span>
  );
}
