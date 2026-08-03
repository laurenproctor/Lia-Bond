import "server-only";

import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveDataSourceKind } from "@/lib/env";
import { SEED_DATASET, USER_KATE } from "@/lib/seed/dataset";

/**
 * Session resolution.
 *
 * There is no authentication provider yet. This module hides that fact behind
 * one signature so membership checks, permission checks, and audit attribution
 * are written against a real session shape today and keep working unchanged
 * when a provider lands.
 *
 * `server-only` is imported at the top: if a client component ever imports this
 * file, the build fails rather than shipping session logic to the browser.
 */

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
}

/** Lets local development exercise each role without a login screen. */
const DEMO_USER_COOKIE = "lia_demo_user";

async function resolveDemoSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const requestedId = store.get(DEMO_USER_COOKIE)?.value;

  const user =
    SEED_DATASET.users.find((row) => row.id === requestedId) ??
    SEED_DATASET.users.find((row) => row.id === USER_KATE);

  if (!user) return null;
  return { id: user.id, email: user.email, fullName: user.fullName };
}

async function resolveSupabaseSession(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const metadata = data.user.user_metadata as { full_name?: unknown } | null;
  const fullName =
    typeof metadata?.full_name === "string" ? metadata.full_name : data.user.email;

  return {
    id: data.user.id,
    email: data.user.email ?? "",
    fullName: fullName ?? "",
  };
}

/** The signed-in user, or null. Never throws — callers decide what to do. */
export async function getSession(): Promise<SessionUser | null> {
  return resolveDataSourceKind() === "supabase"
    ? resolveSupabaseSession()
    : resolveDemoSession();
}

/**
 * The signed-in user, or an error.
 *
 * Use this in server actions, where proceeding without an identity would mean
 * writing an unattributable audit event.
 */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new Error("Not authenticated");
  return session;
}

export const DEMO_USER_COOKIE_NAME = DEMO_USER_COOKIE;
