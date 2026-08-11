"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  MENTION_SOURCE_TYPES,
  MENTION_STATUSES,
  PLATFORMS,
  RISK_LEVELS,
  SENTIMENTS,
  type RuleCondition,
} from "@/domain";
import {
  MENTION_STATUS_LABELS,
  PLATFORM_LABELS,
  RISK_LEVEL_LABELS,
  SENTIMENT_LABELS,
  SOURCE_TYPE_LABELS,
} from "@/lib/labels";
import { CONDITION_FIELDS } from "@/lib/rules/fields";
import { cn } from "@/lib/cn";

export interface LocationOption {
  id: string;
  name: string;
}

/** Shared control styling for every select/input the builder rows use. */
export const SELECT_CLASS =
  "h-9 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400";

/** Shared styling for the reorder/remove icon buttons on a builder row. */
export const ICON_BUTTON_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-40";

export interface ConditionEditorProps {
  value: RuleCondition;
  index: number;
  count: number;
  onChange: (value: RuleCondition) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  locations: LocationOption[];
  /** Disables every control — used to render active/archived rules read-only. */
  disabled?: boolean;
}

/**
 * Build the first fully-valid condition for a field: its first operator (per
 * `CONDITION_FIELDS`) paired with a sensible default value.
 *
 * Used both to seed a freshly-added condition and to reset a row when its
 * field changes, so a condition is never left in a half-valid shape between
 * those two moments — exactly the same discipline `automationRuleConfigSchema`
 * enforces server-side, just applied a step earlier.
 */
export function buildDefaultCondition(
  field: RuleCondition["field"],
  locations: LocationOption[],
): RuleCondition {
  const meta = CONDITION_FIELDS.find((entry) => entry.field === field);
  const operator = meta?.operators[0]?.value;

  switch (field) {
    case "platform":
      return {
        field,
        operator: (operator as "is" | "is_not") ?? "is",
        value: "google_business_profile",
      };
    case "source_type":
      return {
        field,
        operator: (operator as "is" | "is_not") ?? "is",
        value: "google_review",
      };
    case "sentiment":
      return { field, operator: (operator as "is" | "is_not") ?? "is", value: "positive" };
    case "risk_level":
      return {
        field,
        operator: (operator as "is" | "is_not" | "at_least" | "at_most") ?? "is",
        value: "low",
      };
    case "rating":
      return {
        field,
        operator: (operator as "is" | "greater_than" | "less_than") ?? "is",
        value: 3,
      };
    case "relevance_score":
      return {
        field,
        operator: (operator as "greater_than" | "less_than") ?? "greater_than",
        value: 0.5,
      };
    case "location":
      return {
        field,
        operator: (operator as "is" | "is_not") ?? "is",
        value: locations[0]?.id ?? "",
      };
    case "mention_status":
      return { field, operator: (operator as "is" | "is_not") ?? "is", value: "new" };
  }
}

export function ConditionEditor({
  value,
  index,
  count,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  locations,
  disabled = false,
}: ConditionEditorProps) {
  const meta = CONDITION_FIELDS.find((entry) => entry.field === value.field);
  const position = index + 1;

  function setValue(next: string | number) {
    onChange({ ...value, value: next } as RuleCondition);
  }

  let valueControl: ReactNode = null;
  const valueLabel = `Condition ${position} value`;

  switch (meta?.input) {
    case "platform":
      valueControl = (
        <select
          aria-label={valueLabel}
          className={SELECT_CLASS}
          value={String(value.value)}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        >
          {PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {PLATFORM_LABELS[platform]}
            </option>
          ))}
        </select>
      );
      break;
    case "source_type":
      valueControl = (
        <select
          aria-label={valueLabel}
          className={SELECT_CLASS}
          value={String(value.value)}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        >
          {MENTION_SOURCE_TYPES.map((type) => (
            <option key={type} value={type}>
              {SOURCE_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      );
      break;
    case "sentiment":
      valueControl = (
        <select
          aria-label={valueLabel}
          className={SELECT_CLASS}
          value={String(value.value)}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        >
          {SENTIMENTS.map((sentiment) => (
            <option key={sentiment} value={sentiment}>
              {SENTIMENT_LABELS[sentiment]}
            </option>
          ))}
        </select>
      );
      break;
    case "risk_level":
      valueControl = (
        <select
          aria-label={valueLabel}
          className={SELECT_CLASS}
          value={String(value.value)}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        >
          {RISK_LEVELS.map((risk) => (
            <option key={risk} value={risk}>
              {RISK_LEVEL_LABELS[risk]}
            </option>
          ))}
        </select>
      );
      break;
    case "mention_status":
      valueControl = (
        <select
          aria-label={valueLabel}
          className={SELECT_CLASS}
          value={String(value.value)}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        >
          {MENTION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {MENTION_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      );
      break;
    case "location":
      valueControl = (
        <select
          aria-label={valueLabel}
          className={SELECT_CLASS}
          value={String(value.value)}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        >
          {locations.length === 0 ? <option value="">No locations</option> : null}
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      );
      break;
    case "rating":
      valueControl = (
        <input
          aria-label={valueLabel}
          type="number"
          min={0}
          max={5}
          step={0.5}
          value={Number(value.value)}
          disabled={disabled}
          onChange={(event) =>
            setValue(Number.isNaN(event.target.valueAsNumber) ? 0 : event.target.valueAsNumber)
          }
          className={cn(SELECT_CLASS, "w-20")}
        />
      );
      break;
    case "relevance_score":
      valueControl = (
        <input
          aria-label={valueLabel}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={Number(value.value)}
          disabled={disabled}
          onChange={(event) =>
            setValue(Number.isNaN(event.target.valueAsNumber) ? 0 : event.target.valueAsNumber)
          }
          className={cn(SELECT_CLASS, "w-20")}
        />
      );
      break;
    default:
      valueControl = null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-2.5">
      <select
        aria-label={`Condition ${position} field`}
        className={SELECT_CLASS}
        value={value.field}
        disabled={disabled}
        onChange={(event) =>
          onChange(buildDefaultCondition(event.target.value as RuleCondition["field"], locations))
        }
      >
        {CONDITION_FIELDS.map((field) => (
          <option key={field.field} value={field.field}>
            {field.label}
          </option>
        ))}
      </select>

      <select
        aria-label={`Condition ${position} operator`}
        className={SELECT_CLASS}
        value={value.operator}
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...value, operator: event.target.value } as RuleCondition)
        }
      >
        {meta?.operators.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>

      {valueControl}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Move condition ${position} up`}
          className={ICON_BUTTON_CLASS}
          disabled={disabled || index === 0}
          onClick={onMoveUp}
        >
          <ChevronUp className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Move condition ${position} down`}
          className={ICON_BUTTON_CLASS}
          disabled={disabled || index === count - 1}
          onClick={onMoveDown}
        >
          <ChevronDown className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Remove condition ${position}`}
          className={ICON_BUTTON_CLASS}
          disabled={disabled}
          onClick={onRemove}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
