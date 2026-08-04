/**
 * Creates a login for each seeded user.
 *
 * The seed populates `public.users`, which is a profile mirror — it holds no
 * credentials and grants no access. Signing in requires a row in `auth.users`,
 * and the two must share an id: every RLS policy resolves through
 * `auth.uid() = memberships.user_id`, and `memberships.user_id` references
 * `public.users.id`. An auth account with a fresh id would authenticate
 * perfectly and then see nothing at all, which is a confusing way to spend an
 * afternoon.
 *
 * So each account is created with the seeded UUID explicitly.
 *
 * Development only. These are fictional people with `@example.com` addresses
 * and one shared, published password — the point is to exercise the seven-role
 * permission matrix with a real session, not to model a real sign-up. The
 * script refuses to run against NODE_ENV=production.
 *
 * Idempotent, and that is load-bearing rather than tidy: re-running **resets
 * every seeded account's password** to the value below. That is the recovery
 * path for these users, because the real one cannot work for them — a reset
 * link would be emailed to an `@example.com` address that does not exist.
 *
 * Run with: npm run auth:seed
 */

import { createClient } from "@supabase/supabase-js";
import { SEED_DATASET } from "@/lib/seed/dataset";

/**
 * The shared development password.
 *
 * Deliberately in the source rather than the environment. It protects nothing
 * — it unlocks fictional accounts in a development database — and putting it in
 * `.env` would imply it is a secret, which invites someone to reuse the same
 * value somewhere it matters.
 */
const DEV_PASSWORD = "lia-dev-password";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Set it in .env before running this script.`);
    process.exit(1);
  }
  return value;
}

if (process.env.NODE_ENV === "production") {
  console.error(
    "Refusing to run in production: this creates shared-password accounts for fictional users.",
  );
  process.exit(1);
}

const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Membership roles per user, so the output says what each login is for. */
const roleByUserId = new Map<string, string[]>();
for (const membership of SEED_DATASET.memberships) {
  const roles = roleByUserId.get(membership.userId) ?? [];
  roles.push(membership.role);
  roleByUserId.set(membership.userId, roles);
}

let created = 0;
let updated = 0;
let failed = 0;

for (const user of SEED_DATASET.users) {
  const attributes = {
    email: user.email,
    password: DEV_PASSWORD,
    // Skips the confirmation email, which a new project cannot reliably send
    // anyway — its built-in SMTP is rate-limited to a handful an hour.
    email_confirm: true,
    user_metadata: { full_name: user.fullName },
  };

  // The id is the whole point: it must match public.users.id or RLS resolves
  // to a user with no memberships.
  const { error } = await admin.auth.admin.createUser({
    ...attributes,
    id: user.id,
  });

  if (!error) {
    created += 1;
    continue;
  }

  // Already exists — reset it to a known state so a re-run is a no-op in
  // effect rather than a failure.
  const alreadyExists =
    error.status === 422 || /already|exists|registered/i.test(error.message);

  if (!alreadyExists) {
    console.error(`  ✗ ${user.email}: ${error.message}`);
    failed += 1;
    continue;
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    user.id,
    attributes,
  );

  if (updateError) {
    console.error(`  ✗ ${user.email}: ${updateError.message}`);
    failed += 1;
  } else {
    updated += 1;
  }
}

console.log(`\nSeeded logins — password for all of them: ${DEV_PASSWORD}\n`);
for (const user of SEED_DATASET.users) {
  const roles = roleByUserId.get(user.id) ?? ["no membership"];
  console.log(`  ${user.email.padEnd(32)} ${roles.join(", ")}`);
}

console.log(
  `\n${created} created, ${updated} reset, ${failed} failed.` +
    (failed > 0 ? "\nSome accounts could not be created — see the errors above." : ""),
);

if (updated > 0) {
  console.log(
    "\nRe-running this is how you recover a seeded login: the password reset\n" +
      "flow emails these @example.com addresses, which do not exist.",
  );
}

if (failed > 0) process.exit(1);
