import type { ReactNode } from "react";
import type { PlatformConnection } from "@/domain";
import { Card, CardHeader } from "@/components/ui/card";
import { GOOGLE_SCOPE_RATIONALE } from "@/integrations/google-business-profile/scopes";
import { formatDateTime, formatRelativeLong } from "@/lib/format";

/**
 * What Lia holds for one Google connection.
 *
 * Presentational: it renders the connection row it is handed and queries
 * nothing. Extracted from the integration page when review sync pushed that
 * page past the size limit in `CLAUDE.md` — the page now composes cards, which
 * is what it should have been doing.
 *
 * Nothing here can render a credential. `PlatformConnection` carries none, by
 * design: tokens live in a separate service-role-only table, and
 * `platformConnectionSchema.parse()` strips anything that leaked onto the row.
 */

export interface ConnectionSummaryProps {
  connection: PlatformConnection;
  organizationName: string;
  /** Resolved from the membership list; null when the person has left. */
  connectedByName: string | null;
  mappedProfileCount: number;
  unmappedProfileCount: number;
  importedReviewCount: number;
  /** Test and disconnect controls. Omitted when the connection is not live. */
  actions?: ReactNode;
}

export function ConnectionSummary({
  connection,
  organizationName,
  connectedByName,
  mappedProfileCount,
  unmappedProfileCount,
  importedReviewCount,
  actions,
}: ConnectionSummaryProps) {
  return (
    <Card className="xl:col-span-2">
      <CardHeader
        title="Connection"
        description="What Lia holds for this Google account."
      />

      <dl className="mt-4 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
        <Detail label="Google account" value={connection.externalAccountName} />
        <Detail label="Google account id" value={connection.externalAccountId} mono />
        <Detail label="Lia organization" value={organizationName} />
        <Detail label="Connected by" value={connectedByName} />
        <Detail
          label="Connected at"
          value={connection.connectedAt ? formatDateTime(connection.connectedAt) : null}
        />
        <Detail
          label="Access token expires"
          value={
            connection.tokenExpiresAt
              ? formatRelativeLong(connection.tokenExpiresAt)
              : null
          }
          hint="Renewed automatically while a refresh token is held."
        />
        <Detail
          label="Last health check"
          value={
            connection.lastHealthCheckAt
              ? formatRelativeLong(connection.lastHealthCheckAt)
              : null
          }
        />
        <Detail
          label="Last successful Google request"
          value={
            connection.lastHealthStatus === "healthy" && connection.lastHealthCheckAt
              ? formatRelativeLong(connection.lastHealthCheckAt)
              : null
          }
          hint="The most recent request Google accepted."
        />
        <Detail label="Connected locations" value={String(mappedProfileCount)} />
        <Detail
          label="Discovered but unmapped"
          value={String(unmappedProfileCount)}
          hint="Profiles Lia knows about that are not tied to a Lia location."
        />
        <Detail
          label="Imported reviews"
          value={String(importedReviewCount)}
          hint="Google reviews now in the unified inbox, across every connected location."
        />
      </dl>

      <div className="mt-5 border-t border-gray-200 pt-4">
        <h3 className="text-[13px] font-semibold text-gray-950">
          Granted Google permissions
        </h3>
        {connection.grantedScopes.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-gray-500">
            None recorded. Reauthorize to refresh them.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {connection.grantedScopes.map((scopeUrl) => {
              const rationale = GOOGLE_SCOPE_RATIONALE.find(
                (entry) => entry.scope === scopeUrl,
              );

              return (
                <li key={scopeUrl}>
                  <p className="font-mono text-[11.5px] break-all text-gray-700">
                    {scopeUrl}
                  </p>
                  {/*
                    The justification is shown in-product, not only in the docs:
                    an administrator should be able to check what Lia asked for
                    and why without taking a consent screen on trust.
                  */}
                  {rationale ? (
                    <p className="mt-0.5 text-[12.5px] text-gray-500">
                      {rationale.whyLiaNeedsIt}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {actions ? (
        <div className="mt-5 border-t border-gray-200 pt-4">{actions}</div>
      ) : null}
    </Card>
  );
}

function Detail({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string | null;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-gray-500">{label}</dt>
      <dd
        className={
          mono
            ? "mt-0.5 font-mono text-[12px] break-all text-gray-950"
            : "mt-0.5 text-[13px] font-medium text-gray-950"
        }
      >
        {value ?? <span className="font-normal text-gray-400">—</span>}
      </dd>
      {hint ? <p className="mt-0.5 text-[12px] text-gray-500">{hint}</p> : null}
    </div>
  );
}
