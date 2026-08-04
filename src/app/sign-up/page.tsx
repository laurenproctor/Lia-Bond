import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

/**
 * Self-serve sign-up.
 *
 * Outside the `(app)` route group for the same reason `/sign-in` is: it renders
 * before the session it establishes exists, so a sidebar, an organization
 * switcher, and a user menu would all have nothing to read.
 *
 * Recorded as decision D54, extending the exception D46 opened. `CLAUDE.md`
 * fixes the route list and none of the auth routes appear on it — every route
 * there is a product screen for a signed-in user, and all of them are
 * unreachable without a way to become one.
 */
export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your account"
      description="Set up your company and start monitoring."
      footer={
        <p className="text-[12.5px] text-white/50">
          Already have an account?{" "}
          <Link
            href="/sign-in"
            className="text-white/80 underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <SignUpForm />

      {/*
        Stated before the form is submitted rather than after. Somebody
        expecting to join a colleague's organization would otherwise create a
        second, empty one and have no way to notice.
      */}
      <p className="mt-4 border-t border-gray-200 pt-4 text-[12.5px] text-gray-500">
        Joining a team that already uses Lia? Ask them to invite you instead —
        signing up here creates a separate organization.
      </p>
    </AuthShell>
  );
}
