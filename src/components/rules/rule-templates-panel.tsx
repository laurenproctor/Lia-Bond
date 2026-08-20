import { Check } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { RulePlatformBadges } from "@/components/rules/rule-platform-badges";
import { RULE_TEMPLATES } from "@/lib/rules/templates";
import { cn } from "@/lib/cn";

export interface RuleTemplatesPanelProps {
  /**
   * Id of the template currently seeded into the builder, from `?template=`.
   * Null when the builder started blank.
   */
  appliedTemplateId?: string | null;
  /**
   * Whether the viewer may actually create a rule.
   *
   * Defaults to true because the builder only renders this panel after its own
   * permission check. The rules list is the caller that needs it: it shows this
   * panel to everybody who can see an empty rules screen, and a reader whose
   * role cannot create rules would otherwise get five buttons leading to a page
   * that tells them so. Matches the treatment the list's own "New rule" button
   * already gets.
   */
  canManage?: boolean;
}

/**
 * Starter configurations for the new-rule flow.
 *
 * A template that needs a capability Lia doesn't have yet (auto-publish,
 * automated drafting) is shown but not usable — its "Use template" button is
 * disabled and the reason is printed underneath, rather than letting someone
 * instantiate a rule that can never actually run.
 *
 * The applied template is called out here because the builder it fills sits in
 * a separate column: without the marker, "Use template" reads as a click that
 * did nothing.
 */
export function RuleTemplatesPanel({
  appliedTemplateId = null,
  canManage = true,
}: RuleTemplatesPanelProps) {
  return (
    <Card>
      <CardHeader
        title="Templates"
        description="Start from a common pattern and adjust it."
        actions={
          appliedTemplateId ? (
            <ButtonLink href="/rules/new" size="sm" variant="ghost">
              Start blank
            </ButtonLink>
          ) : null
        }
      />

      {appliedTemplateId ? (
        <p className="mt-3 rounded-lg border border-purple-600/20 bg-purple-50 px-3 py-2 text-[12.5px] text-gray-950">
          The template is loaded into the builder. Change anything you like, then
          save it as a draft — picking another template replaces what is there.
        </p>
      ) : null}

      <ul className="mt-4 flex flex-col gap-3">
        {RULE_TEMPLATES.map((template) => {
          const applied = template.id === appliedTemplateId;
          return (
            <li
              key={template.id}
              className={cn(
                "rounded-lg border p-3",
                applied ? "border-purple-600 bg-purple-50/40" : "border-gray-200",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[13px] font-medium text-gray-950">{template.name}</p>
                {applied ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-600/10 px-2 py-0.5 text-[11.5px] font-medium text-purple-600">
                    <Check className="size-3" aria-hidden />
                    In the builder
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-[12.5px] text-gray-500">{template.description}</p>
              {/*
                Which platforms this template would watch, derived from its own
                conditions. Three of the five scope themselves by `source_type`
                rather than by `platform`, so this is the only place the
                difference between "Google reviews" and "everything" is visible
                before instantiating the rule.
              */}
              <RulePlatformBadges
                conditions={template.config.conditions}
                short
                className="mt-2"
              />
              {/*
                The applied template gets no button: it would link to the URL
                already open, so pressing it is a no-op navigation that resets
                nothing. "Start blank" in the header is the way back out.
              */}
              {applied || !canManage ? null : (
                <div className="mt-2.5">
                  {template.available ? (
                    <ButtonLink
                      href={`/rules/new?template=${template.id}`}
                      size="sm"
                      variant="secondary"
                    >
                      Use template
                    </ButtonLink>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" disabled>
                        Use template
                      </Button>
                      {template.unavailableReason ? (
                        <p className="mt-1.5 text-[12px] text-gray-500">
                          {template.unavailableReason}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
