import "server-only";

import { resolveDataSourceKind } from "@/lib/env";
import { createDemoDataSource } from "@/lib/data/demo";
import { createSupabaseDataSource } from "@/lib/data/supabase";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";
import type { LiaDataSource } from "@/lib/data/types";

/**
 * Data source factory.
 *
 * The one place that decides which adapter is in play. Everything downstream
 * takes a `LiaDataSource` and never asks which one it got — that is what lets
 * the same repository tests cover both, and what makes provisioning a database
 * a configuration change rather than a code change.
 */

let demoSingleton: LiaDataSource | null = null;

export async function getDataSource(): Promise<LiaDataSource> {
  if (resolveDataSourceKind() === "supabase") {
    // Built per request: it carries the caller's session, so it must not be
    // cached across requests.
    return createSupabaseDataSource(await createSupabaseServerClient());
  }

  // Demo mode is process-wide so mutations survive between requests in dev.
  demoSingleton ??= createDemoDataSource();
  return demoSingleton;
}

/**
 * The privileged data source. Bypasses row-level security entirely.
 *
 * `getDataSource()` builds its Supabase client from the caller's session
 * (`createSupabaseServerClient`), and a scheduled job has no session — every
 * policy resolving through `auth.uid()` would reject the write. This is the
 * only sanctioned way around that.
 *
 * Only the cron path may call this. Every caller therefore carries its own
 * tenancy discipline: nothing downstream of this function is checking
 * membership on its behalf (D70). The poll service is the one caller today,
 * and it enforces that discipline by constructing an `OrganizationScope` from
 * each row's own `organizationId` rather than trusting an ambient one.
 */
export async function getServiceDataSource(): Promise<LiaDataSource> {
  if (resolveDataSourceKind() === "supabase") {
    return createSupabaseDataSource(createSupabaseServiceClient());
  }

  demoSingleton ??= createDemoDataSource();
  return demoSingleton;
}

export type { LiaDataSource } from "@/lib/data/types";
export * from "@/lib/data/errors";
