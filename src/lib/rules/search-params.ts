/**
 * URL search-param parsing for the rules list page.
 *
 * The status filter lives in the URL (`?status=active`) so the view is
 * shareable and survives a refresh, but the URL is untrusted input — anyone
 * can type `?status=archived` or `?status=ACTIVE`. Anything that isn't an
 * exact match against a real `AutomationRuleStatus` falls back to `"all"`
 * rather than throwing or silently matching the wrong rows.
 */

import { AUTOMATION_RULE_STATUSES, type AutomationRuleStatus } from "@/domain";

export function parseRuleStatusParam(
  value: string | undefined,
): AutomationRuleStatus | "all" {
  if (value && (AUTOMATION_RULE_STATUSES as readonly string[]).includes(value)) {
    return value as AutomationRuleStatus;
  }
  return "all";
}
