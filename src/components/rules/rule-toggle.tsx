"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { setAutomationRuleEnabledAction } from "@/app/actions/automation";
import { cn } from "@/lib/cn";
import type { AutomationRule } from "@/domain";

export interface RuleToggleProps {
  rule: AutomationRule;
  /** True when the caller's role cannot change automation. */
  disabled?: boolean;
}

/**
 * Enable or disable an automation rule.
 *
 * The switch is optimistic in appearance only — the server action re-checks the
 * role, applies the transition, and writes an audit event. If it refuses, the
 * switch snaps back and says why.
 */
export function RuleToggle({ rule, disabled = false }: RuleToggleProps) {
  const [enabled, setEnabled] = useState(rule.status === "active");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A draft rule has never been simulated, so it cannot be switched on here.
  const blocked = disabled || rule.status === "draft";

  function toggle() {
    const next = !enabled;
    setError(null);
    setEnabled(next);

    startTransition(async () => {
      const result = await setAutomationRuleEnabledAction({
        automationRuleId: rule.id,
        enabled: next,
      });

      if (!result.ok) {
        setEnabled(!next);
        setError(result.error);
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? "Disable" : "Enable"} ${rule.name}`}
        disabled={blocked || pending}
        onClick={toggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          enabled ? "bg-purple-600" : "bg-gray-300",
          (blocked || pending) && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 rounded-full bg-white transition-transform",
            enabled ? "translate-x-4.5" : "translate-x-0.5",
          )}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin text-purple-600" aria-hidden />
          ) : null}
        </span>
      </button>

      {error ? (
        <span role="alert" className="max-w-48 text-right text-[11px] text-red-600">
          {error}
        </span>
      ) : null}
    </span>
  );
}
