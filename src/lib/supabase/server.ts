import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * Supabase clients.
 *
 * Two of them, and the difference matters:
 *
 * - `createSupabaseServerClient` runs as the signed-in user. Every query it
 *   makes is filtered by row-level security. This is what the application uses.
 * - `createSupabaseServiceClient` bypasses row-level security entirely. It is
 *   for background jobs and migrations only, and it reads a key that must never
 *   reach the browser.
 *
 * `server-only` makes importing either one from a client component a build
 * error rather than a leaked credential.
 */

function requireConfig(): { url: string; anonKey: string } {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return { url, anonKey };
}

/** Request-scoped client carrying the user's session. RLS applies. */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, anonKey } = requireConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies. Session refresh happens in
          // middleware or a route handler; ignoring here is the documented
          // @supabase/ssr pattern rather than a swallowed failure.
        }
      },
    },
  });
}

/**
 * Privileged client. Bypasses row-level security.
 *
 * Only for trusted server-side work: sync jobs, seeding, administrative
 * backfills. Never construct this in response to a user request without
 * deciding, explicitly, which organization the work is scoped to.
 */
export function createSupabaseServiceClient(): SupabaseClient {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Service-role client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
