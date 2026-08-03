import "server-only";

import { resolveDataSourceKind } from "@/lib/env";
import { createDemoDataSource } from "@/lib/data/demo";
import { createSupabaseDataSource } from "@/lib/data/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export type { LiaDataSource } from "@/lib/data/types";
export * from "@/lib/data/errors";
