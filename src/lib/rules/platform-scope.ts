import {
  PLATFORM_SOURCE_TYPES,
  PLATFORMS,
  // Already existed on `mention.ts` for grouping and routing. Reused rather
  // than restated: a second copy of "which platform owns a source type" is a
  // second thing to keep in step with the enum.
  SOURCE_TYPE_PLATFORM,
  type MentionSourceType,
  type Platform,
  type RuleCondition,
} from "@/domain";

/**
 * Which platforms a rule can actually affect.
 *
 * Derived from the rule's own conditions rather than stored, for the same
 * reason `summarizeBrandVoice` derives its summary: a stored answer is one that
 * can disagree with the rule the moment somebody edits a condition. Pure — no
 * I/O, no framework imports — so the badge can be computed on the server for a
 * saved rule and in the browser for one being edited, and the two cannot drift.
 *
 * Two condition types carry platform information, and both directions of each
 * matter:
 *
 * - `platform is/is_not` — the direct statement.
 * - `source_type is/is_not` — an indirect one, because every source type
 *   belongs to exactly one platform (`SOURCE_TYPE_PLATFORM`). Three of the five
 *   shipped templates scope themselves this way rather than by platform, so
 *   reading only `platform` conditions would report "every platform" for most
 *   of the templates on the screen.
 *
 * Conditions are **AND**ed (`matchesRule` in `evaluate.ts`), which is what
 * makes this a narrowing intersection rather than a union.
 */

/**
 * The answer, with its two empty cases kept distinct.
 *
 * They are different facts with different fixes, and collapsing them into "no
 * platforms" would leave somebody staring at a rule that does nothing with no
 * indication of why.
 */
export type RulePlatformScope =
  /** Every platform. The rule says nothing that narrows it. */
  | { kind: "all" }
  /** A specific set, in `PLATFORMS` order. Never empty. */
  | { kind: "some"; platforms: Platform[] }
  /**
   * Nothing, and why.
   *
   * `no_conditions` — the rule has no conditions at all. This is **not** the
   * same as "unrestricted": `matchesRule` returns false for an empty condition
   * list on purpose, so such a rule never fires. Rendering it as "all
   * platforms" would be the most misleading thing this module could do.
   *
   * `contradictory` — the conditions cannot all hold at once, so no mention of
   * any platform can satisfy them.
   */
  | { kind: "none"; reason: "no_conditions" | "contradictory" };

/** Conditions that say something about where a mention came from. */
function isScopingCondition(
  condition: RuleCondition,
): condition is Extract<RuleCondition, { field: "platform" | "source_type" }> {
  return condition.field === "platform" || condition.field === "source_type";
}

export function rulePlatformScope(
  conditions: readonly RuleCondition[],
): RulePlatformScope {
  // A rule with no conditions matches nothing at all — see `matchesRule`.
  if (conditions.length === 0) return { kind: "none", reason: "no_conditions" };

  const scoping = conditions.filter(isScopingCondition);
  if (scoping.length === 0) return { kind: "all" };

  // Gathered before anything is decided. An `is` narrows to one platform and an
  // `is_not` removes one, so applying them in encounter order would let a
  // removal land before the narrowing that made it redundant — same answer, but
  // only by luck. Collecting first makes the order irrelevant.
  const platformIs = new Set<Platform>();
  const platformIsNot = new Set<Platform>();
  const sourceTypeIs = new Set<MentionSourceType>();
  const sourceTypeIsNot = new Set<MentionSourceType>();

  for (const condition of scoping) {
    if (condition.field === "platform") {
      (condition.operator === "is" ? platformIs : platformIsNot).add(condition.value);
    } else {
      (condition.operator === "is" ? sourceTypeIs : sourceTypeIsNot).add(
        condition.value,
      );
    }
  }

  // Two different `is` values on the same field can never both hold. Caught
  // here rather than falling out of the intersection below, because two source
  // types on one platform ("is reddit_post" AND "is reddit_comment") would
  // otherwise intersect to Reddit and report a rule that can never fire as
  // affecting it.
  if (platformIs.size > 1 || sourceTypeIs.size > 1) {
    return { kind: "none", reason: "contradictory" };
  }

  // The same value required and forbidden. Also unsatisfiable, and also
  // invisible to the set arithmetic below.
  for (const value of platformIs) {
    if (platformIsNot.has(value)) return { kind: "none", reason: "contradictory" };
  }
  for (const value of sourceTypeIs) {
    if (sourceTypeIsNot.has(value)) return { kind: "none", reason: "contradictory" };
  }

  let candidates = new Set<Platform>(PLATFORMS);

  for (const platform of platformIs) {
    candidates = new Set(candidates.has(platform) ? [platform] : []);
  }
  for (const sourceType of sourceTypeIs) {
    const platform = SOURCE_TYPE_PLATFORM[sourceType];
    candidates = new Set(candidates.has(platform) ? [platform] : []);
  }

  for (const platform of platformIsNot) candidates.delete(platform);

  // Excluding a source type only excludes its platform when it takes the
  // platform's *last* one with it. `source_type is_not reddit_post` leaves
  // `reddit_comment`, so the rule still affects Reddit.
  if (sourceTypeIsNot.size > 0) {
    for (const platform of [...candidates]) {
      const remaining = PLATFORM_SOURCE_TYPES[platform].filter(
        (sourceType) => !sourceTypeIsNot.has(sourceType),
      );
      if (remaining.length === 0) candidates.delete(platform);
    }
  }

  if (candidates.size === 0) return { kind: "none", reason: "contradictory" };
  if (candidates.size === PLATFORMS.length) return { kind: "all" };

  // `PLATFORMS` order, not insertion order, so two rules naming the same
  // platforms always render their badges in the same sequence.
  return { kind: "some", platforms: PLATFORMS.filter((p) => candidates.has(p)) };
}
