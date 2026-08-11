"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { MENTION_STATUSES, type RuleAction } from "@/domain";
import { MENTION_STATUS_LABELS } from "@/lib/labels";
import { ACTION_CAPABILITIES, type RuleActionType } from "@/lib/rules/capabilities";
import { ICON_BUTTON_CLASS, SELECT_CLASS } from "@/components/rules/condition-editor";

export interface ActionEditorProps {
  value: RuleAction;
  index: number;
  count: number;
  onChange: (value: RuleAction) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Disables every control — used to render active/archived rules read-only. */
  disabled?: boolean;
}

/**
 * Every action type the builder offers, in registry order. `assign` and
 * `tag` are absent because `showInBuilder` is false for both — nothing in
 * the product today has an assignee or a tag to set.
 */
const BUILDER_ACTION_TYPES = Object.values(ACTION_CAPABILITIES).filter(
  (capability) => capability.showInBuilder,
);

/**
 * Build the default shape for a freshly-selected action type.
 *
 * Only `set_status` and `escalate` are reachable through the type select
 * today (every other option is disabled — see `BUILDER_ACTION_TYPES`), but
 * this stays exhaustive over every action type so a rule loaded with a
 * legacy or seeded non-executable action never hits a missing case if its
 * type is ever re-selected.
 */
export function buildDefaultAction(type: RuleActionType): RuleAction {
  switch (type) {
    case "set_status":
      return { type, status: "dismissed" };
    case "escalate":
      return { type, assigneeUserId: null };
    case "generate_draft":
      return { type, voiceProfile: null };
    case "require_approval":
      return { type, approverUserId: null };
    case "notify":
      return { type, channel: "in_app" };
    case "auto_publish":
      return { type };
    case "assign":
      return { type, assigneeUserId: null };
    case "tag":
      return { type, label: "" };
  }
}

export function ActionEditor({
  value,
  index,
  count,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  disabled = false,
}: ActionEditorProps) {
  const capability = ACTION_CAPABILITIES[value.type];
  const position = index + 1;
  // A rule authored before `showInBuilder` existed (or seeded directly) can
  // carry a hidden action type like `assign`/`tag`. Without an option for it,
  // the select would silently fall back to showing the first listed type
  // instead of the truth — so a hidden current type gets its own disabled
  // option prepended.
  const currentTypeIsHidden = !BUILDER_ACTION_TYPES.some(
    (option) => option.type === value.type,
  );

  let extra: ReactNode = null;
  if (value.type === "set_status") {
    extra = (
      <select
        aria-label={`Action ${position} status`}
        className={SELECT_CLASS}
        value={value.status}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, status: event.target.value } as RuleAction)}
      >
        {MENTION_STATUSES.map((status) => (
          <option key={status} value={status}>
            {MENTION_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    );
  } else if (value.type === "escalate") {
    extra = (
      <p className="text-[12.5px] text-gray-500">
        An open escalation is created for a person to pick up.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Action ${position} type`}
          className={SELECT_CLASS}
          value={value.type}
          disabled={disabled}
          onChange={(event) => onChange(buildDefaultAction(event.target.value as RuleActionType))}
        >
          {currentTypeIsHidden ? (
            <option value={value.type} disabled>
              {capability.label}
            </option>
          ) : null}
          {BUILDER_ACTION_TYPES.map((option) => (
            <option key={option.type} value={option.type} disabled={!option.executable}>
              {option.label}
            </option>
          ))}
        </select>

        {extra}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label={`Move action ${position} up`}
            className={ICON_BUTTON_CLASS}
            disabled={disabled || index === 0}
            onClick={onMoveUp}
          >
            <ChevronUp className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Move action ${position} down`}
            className={ICON_BUTTON_CLASS}
            disabled={disabled || index === count - 1}
            onClick={onMoveDown}
          >
            <ChevronDown className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Remove action ${position}`}
            className={ICON_BUTTON_CLASS}
            disabled={disabled}
            onClick={onRemove}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {!capability.executable ? (
        <p className="text-[12px] text-amber-600">{capability.blockedReason}</p>
      ) : null}
    </div>
  );
}
