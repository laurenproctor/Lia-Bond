"use client";

import { useId, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Plus } from "lucide-react";
import {
  createAutomationRuleAction,
  updateAutomationRuleAction,
} from "@/app/actions/automation";
import { ActionEditor, buildDefaultAction } from "@/components/rules/action-editor";
import {
  ConditionEditor,
  type LocationOption,
} from "@/components/rules/condition-editor";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { activationProblems } from "@/lib/rules/readiness";
import { ruleSentence } from "@/lib/rules/sentence";
import type {
  AutomationRule,
  AutomationRuleConfig,
  RuleAction,
  RuleCondition,
} from "@/domain";

export interface RuleBuilderProps {
  mode: "create" | "edit";
  /** Required in edit mode — the rule being edited. */
  rule?: AutomationRule;
  locations: LocationOption[];
  /** manage-holder AND rule not active/archived. False renders every control read-only. */
  editable: boolean;
  /**
   * Template instantiation via `/rules/new?template=<id>`. Ignored in edit
   * mode. Read once, at mount — the new-rule page keys this component on the
   * template id so a different template arrives as a fresh mount rather than
   * as a prop change this component would have to reconcile.
   */
  initialConfig?: AutomationRuleConfig;
  /** Name of the template `initialConfig` came from, for the seeded-from note. */
  templateName?: string | null;
}

const FIELD_CLASS =
  "h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500";

const TEXTAREA_CLASS =
  "min-h-20 w-full resize-y rounded-[10px] border border-gray-300 bg-white px-3 py-2 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500";

const EMPTY_CONFIG: AutomationRuleConfig = {
  name: "",
  description: null,
  priority: 100,
  conditions: [],
  actions: [],
};

function initialConfigFor(props: RuleBuilderProps): AutomationRuleConfig {
  if (props.rule) {
    return {
      name: props.rule.name,
      description: props.rule.description,
      priority: props.rule.priority,
      conditions: props.rule.conditions,
      actions: props.rule.actions,
    };
  }
  return props.initialConfig ?? EMPTY_CONFIG;
}

/** Move an array item by `delta` positions; returns the original array if the move is a no-op. */
function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item === undefined) return items;
  next.splice(target, 0, item);
  return next;
}

/**
 * Author or edit an automation rule.
 *
 * Fully controlled, client-side state — nothing reaches the server until
 * "Save draft" / "Save changes" is pressed. The live sentence and readiness
 * preview below the form update on every keystroke so a person can see what
 * they are about to save without submitting first.
 */
export function RuleBuilder(props: RuleBuilderProps) {
  const { mode, rule, locations, editable, templateName = null } = props;
  const router = useRouter();
  const nameId = useId();
  const descriptionId = useId();
  const priorityId = useId();

  const [initial] = useState(() => initialConfigFor(props));
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [priority, setPriority] = useState(initial.priority);
  const [conditions, setConditions] = useState<RuleCondition[]>(initial.conditions);
  const [actions, setActions] = useState<RuleAction[]>(initial.actions);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const locationNames = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations],
  );

  const sentence = ruleSentence({ conditions, actions }, { locationNames });

  // Unsaved rules have never been simulated, so `stale_simulation` would
  // always be present here and drown out every other signal. It is filtered
  // out and replaced with the explicit note below the list instead.
  const previewProblems = useMemo(
    () =>
      activationProblems({
        conditions,
        actions,
        revision: 1,
        simulatedRevision: null,
      }).filter((problem) => problem.code !== "stale_simulation"),
    [conditions, actions],
  );

  function markDirty() {
    setIsDirty(true);
  }

  function updateCondition(index: number, next: RuleCondition) {
    setConditions((current) => current.map((entry, i) => (i === index ? next : entry)));
    markDirty();
  }

  function removeCondition(index: number) {
    setConditions((current) => current.filter((_, i) => i !== index));
    markDirty();
  }

  function moveCondition(index: number, delta: number) {
    setConditions((current) => moveItem(current, index, delta));
    markDirty();
  }

  function addCondition() {
    setConditions((current) => [
      ...current,
      { field: "source_type", operator: "is", value: "google_review" },
    ]);
    markDirty();
  }

  function updateAction(index: number, next: RuleAction) {
    setActions((current) => current.map((entry, i) => (i === index ? next : entry)));
    markDirty();
  }

  function removeAction(index: number) {
    setActions((current) => current.filter((_, i) => i !== index));
    markDirty();
  }

  function moveAction(index: number, delta: number) {
    setActions((current) => moveItem(current, index, delta));
    markDirty();
  }

  function addAction() {
    setActions((current) => [...current, buildDefaultAction("set_status")]);
    markDirty();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable) return;

    setError(null);
    setFieldErrors({});

    const config: AutomationRuleConfig = {
      name: name.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
      priority,
      conditions,
      actions,
    };

    startTransition(async () => {
      if (mode === "create") {
        const result = await createAutomationRuleAction(config);
        if (!result.ok) {
          setError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          return;
        }
        router.push(`/rules/${result.data.id}`);
        return;
      }

      if (!rule) return;

      const result = await updateAutomationRuleAction({
        automationRuleId: rule.id,
        expectedRevision: rule.revision,
        config,
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setIsDirty(false);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {mode === "create" && templateName ? (
        <p className="rounded-lg border border-purple-600/20 bg-purple-50 px-3 py-2 text-[13px] text-gray-950">
          Filled in from the <span className="font-medium">{templateName}</span>{" "}
          template. Everything below is editable — adjust it and save it as a draft.
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="Details"
          description="What this rule is called and when it runs relative to others."
        />
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-[13px] font-medium text-gray-950">
              Name
            </label>
            <input
              id={nameId}
              value={name}
              disabled={!editable}
              required
              maxLength={160}
              onChange={(event) => {
                setName(event.target.value);
                markDirty();
              }}
              className={FIELD_CLASS}
            />
            {fieldErrors.name ? (
              <p className="text-[12px] text-red-600">{fieldErrors.name}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={descriptionId} className="text-[13px] font-medium text-gray-950">
              Description <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id={descriptionId}
              value={description}
              disabled={!editable}
              rows={2}
              maxLength={1000}
              onChange={(event) => {
                setDescription(event.target.value);
                markDirty();
              }}
              className={TEXTAREA_CLASS}
            />
            {fieldErrors.description ? (
              <p className="text-[12px] text-red-600">{fieldErrors.description}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5 sm:w-48">
            <label htmlFor={priorityId} className="text-[13px] font-medium text-gray-950">
              Priority
            </label>
            <input
              id={priorityId}
              type="number"
              min={0}
              max={1000}
              value={priority}
              disabled={!editable}
              onChange={(event) => {
                const next = event.target.valueAsNumber;
                setPriority(Number.isNaN(next) ? 0 : next);
                markDirty();
              }}
              className={FIELD_CLASS}
            />
            <p className="text-[12px] text-gray-500">Lower priority numbers run first.</p>
            {fieldErrors.priority ? (
              <p className="text-[12px] text-red-600">{fieldErrors.priority}</p>
            ) : null}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Match when all of the following are true" />
        <div className="mt-4 flex flex-col gap-2">
          {conditions.length === 0 ? (
            <p className="text-[13px] text-gray-500">
              No conditions yet — this rule would never match anything.
            </p>
          ) : null}
          {conditions.map((condition, index) => (
            <ConditionEditor
              key={index}
              value={condition}
              index={index}
              count={conditions.length}
              onChange={(next) => updateCondition(index, next)}
              onRemove={() => removeCondition(index)}
              onMoveUp={() => moveCondition(index, -1)}
              onMoveDown={() => moveCondition(index, 1)}
              locations={locations}
              disabled={!editable}
            />
          ))}
        </div>
        {editable ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={Plus}
            onClick={addCondition}
            className="mt-3"
          >
            Add condition
          </Button>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Then Lia will" />
        <div className="mt-4 flex flex-col gap-2">
          {actions.length === 0 ? (
            <p className="text-[13px] text-gray-500">No actions yet. Add at least one.</p>
          ) : null}
          {actions.map((action, index) => (
            <ActionEditor
              key={index}
              value={action}
              index={index}
              count={actions.length}
              onChange={(next) => updateAction(index, next)}
              onRemove={() => removeAction(index)}
              onMoveUp={() => moveAction(index, -1)}
              onMoveDown={() => moveAction(index, 1)}
              disabled={!editable}
            />
          ))}
        </div>
        {editable ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={Plus}
            onClick={addAction}
            className="mt-3"
          >
            Add action
          </Button>
        ) : null}
      </Card>

      <Card className="bg-gray-50">
        <p className="text-[13px] text-gray-700">{sentence}</p>
      </Card>

      <Card>
        <CardHeader title="Activation readiness" />
        <div className="mt-3">
          {previewProblems.length === 0 ? (
            <p className="flex items-center gap-2 text-[13px] text-green-600">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
              This rule looks ready.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {previewProblems.map((problem) => (
                <li
                  key={problem.code}
                  className="flex items-start gap-2 text-[13px] text-amber-600"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{problem.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12px] text-gray-500">Simulation happens after you save.</p>
        </div>
      </Card>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
          {error}
        </div>
      ) : null}

      {editable ? (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : mode === "create" ? "Save draft" : "Save changes"}
          </Button>
          <p className="text-[12px] text-gray-500">
            {isDirty ? "You have unsaved changes. " : ""}
            Changes are not saved until you save.
          </p>
        </div>
      ) : null}
    </form>
  );
}
