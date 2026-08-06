import type { Metadata } from "next";
import { PageBody } from "@/components/shell/app-shell";
import { ChannelScope } from "@/components/brand-voice/channel-scope";
import { VoiceForm } from "@/components/brand-voice/voice-form";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { PLATFORM_LABELS } from "@/lib/labels";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import {
  DEFAULT_BRAND_VOICE,
  type PlatformConnection,
  type UpdateBrandVoiceInput,
} from "@/domain";

export const metadata: Metadata = { title: "Brand voice" };

/**
 * Display names of the platforms this organization has actually connected.
 *
 * Reads `PLATFORM_LABELS` rather than a second mapping, and only includes
 * connections whose `status` is `"connected"` — a pending or errored row must
 * not appear here, since this list is what tells someone where Lia will
 * respond.
 */
function connectedPlatformNames(connections: PlatformConnection[]): string[] {
  return connections
    .filter((connection) => connection.status === "connected")
    .map((connection) => PLATFORM_LABELS[connection.platform]);
}

/**
 * Brand voice configuration.
 *
 * An organization with no saved profile is the normal case, not an error:
 * provisioning does not create one, so the defaults are rendered and the first
 * save inserts the row.
 */
export default async function BrandVoicePage() {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();

  const [profile, connections] = await Promise.all([
    dataSource.brandVoice.get(context.scope),
    dataSource.platformConnections.list(context.scope),
  ]);

  const initial: UpdateBrandVoiceInput = profile
    ? {
        name: profile.name,
        axes: profile.axes,
        approvedPhrases: profile.approvedPhrases,
        prohibitedPhrases: profile.prohibitedPhrases,
      }
    : DEFAULT_BRAND_VOICE;

  const readOnly = !can(context.role, "brand_voice.update");

  return (
    <PageBody>
      <PageHeader
        title="Brand voice"
        description="Set how Lia writes so every response reflects your brand."
      />

      {readOnly ? (
        <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700">
          You can read this configuration but not change it. Ask an owner, an
          admin, or your communications lead.
        </p>
      ) : null}

      <VoiceForm
        initial={initial}
        readOnly={readOnly}
        channels={<ChannelScope connected={connectedPlatformNames(connections)} />}
        preview={
          <SectionPlaceholder
            title="5. Live preview"
            description="A real mention answered in this voice. Available once response drafting arrives."
            shape="lines"
          />
        }
      />
    </PageBody>
  );
}
