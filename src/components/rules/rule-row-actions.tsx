"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Copy } from "lucide-react";
import {
  archiveAutomationRuleAction,
  duplicateAutomationRuleAction,
} from "@/app/actions/automation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AutomationRule } from "@/domain";

export interface RuleRowActionsProps {
  rule: AutomationRule;
  /** True when the caller's role can manage rules. Hides this component entirely when false. */
  canManage: boolean;
}

/**
 * Duplicate and archive controls for a single rule.
 *
 * Duplicating always succeeds regardless of the rule's own state (draft,
 * inactive, active, even archived) — the copy always starts fresh, so there
 * is nothing about the source rule's status that could block it. Archiving
 * is narrower: only offered for rules that are not active and not already
 * archived, matching the same guard the server enforces.
 */
export function RuleRowActions({ rule, canManage }: RuleRowActionsProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canManage) return null;

  const canArchive = rule.status !== "active" && rule.archivedAt === null;

  function duplicate() {
    setError(null);
    startTransition(async () => {
      const result = await duplicateAutomationRuleAction({ automationRuleId: rule.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/rules/${result.data.id}`);
    });
  }

  function archive() {
    startTransition(async () => {
      const result = await archiveAutomationRuleAction({ automationRuleId: rule.id });
      setConfirmOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/rules");
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" icon={Copy} onClick={duplicate} disabled={pending}>
        Duplicate
      </Button>

      {canArchive ? (
        <Button
          variant="secondary"
          size="sm"
          icon={Archive}
          onClick={() => setConfirmOpen(true)}
          disabled={pending}
        >
          Archive
        </Button>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Archive this rule?"
        description="It keeps its history and can be restored by support, but it disappears from this list."
        confirmLabel="Archive"
        destructive={false}
        onConfirm={archive}
        onCancel={() => setConfirmOpen(false)}
      />

      {error ? (
        <span role="alert" className="text-[12px] text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
