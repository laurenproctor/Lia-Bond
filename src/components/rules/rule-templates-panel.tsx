import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { RULE_TEMPLATES } from "@/lib/rules/templates";

/**
 * Starter configurations for the new-rule flow.
 *
 * A template that needs a capability Lia doesn't have yet (auto-publish,
 * automated drafting) is shown but not usable — its "Use template" button is
 * disabled and the reason is printed underneath, rather than letting someone
 * instantiate a rule that can never actually run.
 */
export function RuleTemplatesPanel() {
  return (
    <Card>
      <CardHeader title="Templates" description="Start from a common pattern and adjust it." />
      <ul className="mt-4 flex flex-col gap-3">
        {RULE_TEMPLATES.map((template) => (
          <li key={template.id} className="rounded-lg border border-gray-200 p-3">
            <p className="text-[13px] font-medium text-gray-950">{template.name}</p>
            <p className="mt-0.5 text-[12.5px] text-gray-500">{template.description}</p>
            <div className="mt-2.5">
              {template.available ? (
                <ButtonLink href={`/rules/new?template=${template.id}`} size="sm" variant="secondary">
                  Use template
                </ButtonLink>
              ) : (
                <>
                  <Button size="sm" variant="secondary" disabled>
                    Use template
                  </Button>
                  {template.unavailableReason ? (
                    <p className="mt-1.5 text-[12px] text-gray-500">{template.unavailableReason}</p>
                  ) : null}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
