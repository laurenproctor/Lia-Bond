import type { Metadata } from "next";
import { Ban, CheckCircle2, Eye, Save } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { BRAND_VOICE_PROFILE } from "@/lib/fixtures/brand-voice";

export const metadata: Metadata = { title: "Brand voice" };

/**
 * Brand voice configuration.
 *
 * Reads a typed fixture rather than the database: there is no brand-voice table
 * yet, and inventing one before the AI workflow decides what generation
 * actually needs would mean migrating it twice. The shape is settled here so
 * that becomes a repository change, not a screen rewrite.
 */
export default function BrandVoicePage() {
  const profile = BRAND_VOICE_PROFILE;

  return (
    <PageBody>
      <PageHeader
        title="Brand voice"
        description="Set how Lia writes so every response reflects your brand."
        actions={
          <>
            <Button icon={Eye}>Preview responses</Button>
            <Button variant="primary" icon={Save}>
              Save changes
            </Button>
          </>
        }
      />

      <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700">
        These settings are not stored yet. They take effect when response
        generation arrives, and they will move into the database with it.
      </p>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <Card>
            <CardHeader
              title="1. How should Lia sound?"
              description="Five paired sliders set the register of every generated response."
            />
            <ul className="mt-4 space-y-4">
              {profile.axes.map((axis) => (
                <li key={axis.key} className="grid grid-cols-[7rem_1fr_7rem] items-center gap-3">
                  <span className="text-[13px] font-medium text-gray-950">
                    {axis.leftLabel}
                  </span>
                  <span className="relative block h-1.5 rounded-full bg-gray-200">
                    <span
                      className="absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-white bg-purple-600 shadow-card"
                      style={{ left: `calc(${axis.value}% - 0.4375rem)` }}
                      aria-hidden
                    />
                    <span className="sr-only">
                      {axis.leftLabel} to {axis.rightLabel}: {axis.value} of 100
                    </span>
                  </span>
                  <span className="text-right text-[13px] text-gray-500">
                    {axis.rightLabel}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="2. Use these phrases"
              description="Phrases Lia may include in responses."
            />
            <ul className="mt-4 flex flex-wrap gap-2">
              {profile.approvedPhrases.map((phrase) => (
                <li
                  key={phrase}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-100 px-2.5 py-1.5 text-[13px] text-green-600"
                >
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  {phrase}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="3. Avoid these phrases"
              description="Phrases Lia will never write."
            />
            <ul className="mt-4 flex flex-wrap gap-2">
              {profile.prohibitedPhrases.map((phrase) => (
                <li
                  key={phrase}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-100 px-2.5 py-1.5 text-[13px] text-red-600"
                >
                  <Ban className="size-3.5" aria-hidden />
                  {phrase}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="4. Where Lia will respond"
              description="The channels this voice applies to."
            />
            <ul className="mt-4 flex flex-wrap gap-2">
              {profile.channels.map((channel) => (
                <li
                  key={channel}
                  className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] text-gray-700"
                >
                  {channel}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          <SectionPlaceholder
            title="5. Live preview"
            description="A real mention answered in the current voice, updating as the sliders move."
            shape="lines"
          />

          <Card>
            <CardHeader
              title="6. Voice summary"
              description="The same settings in plain language, so anyone can check them."
            />
            <ul className="mt-4 space-y-2">
              {profile.summary.map((line) => (
                <li key={line} className="flex items-center gap-2 text-[13px] text-gray-700">
                  <CheckCircle2 className="size-4 shrink-0 text-green-600" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}
