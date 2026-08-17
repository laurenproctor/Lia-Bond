import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CreateOrganizationForm } from "@/components/organizations/create-organization-form";
import { LogoMark } from "@/components/site/logo-mark";
import { requireSession } from "@/lib/auth/session";
import { getDataSource } from "@/lib/data";

/**
 * Create an organization.
 *
 * Two states, one page, decided by whether the caller already belongs to
 * anything:
 *
 * - **No memberships.** Somebody whose provisioning failed part-way, or an
 *   account that was removed from its last organization. Before this route
 *   existed they landed on `/overview`, where the shell threw `not_a_member`
 *   and the error boundary offered a Retry button that could only ever fail
 *   again. There is no escape hatch here on purpose: there is nowhere else in
 *   the product for them to be.
 *
 * - **Already a member of something.** The ordinary case — a second restaurant
 *   group, a separate entity for a new market. They get a way back, because
 *   arriving here by misclicking the switcher should cost one click to undo.
 *
 * No onboarding guard runs. There is no organization to have progress for, and
 * `redirectIfOnboarding` would have nothing to read.
 */
export const dynamic = "force-dynamic";

export default async function NewOrganizationPage() {
  const session = await requireSession();
  const dataSource = await getDataSource();
  const memberships = await dataSource.organizations.listForUser(session.id);
  const hasOrganizations = memberships.length > 0;

  return (
    <div
      // `data-surface="site"` scopes the marketing brand's focus ring and
      // selection colour, leaving the product's purple untouched elsewhere.
      data-surface="site"
      className="font-site min-h-dvh bg-site-tint text-site-body"
    >
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 py-10 sm:px-6">
        <header className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-site-ink">
            <LogoMark />
            <span className="sr-only">Lia</span>
          </p>
          {hasOrganizations ? (
            <Link
              href="/overview"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-site-muted transition-colors hover:text-site-ink"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back to Lia
            </Link>
          ) : null}
        </header>

        <main id="main" className="rounded-2xl border border-site-border bg-white p-6 sm:p-8">
          <h1 className="text-[22px] leading-tight font-semibold text-site-ink">
            {hasOrganizations ? "Create another organization" : "Create your organization"}
          </h1>
          <p className="mt-2 text-[14px] text-site-body">
            {hasOrganizations
              ? "A separate workspace, with its own locations, team, sources, and brand voice. Nothing is shared with the organizations you already belong to."
              : "Your account is not part of an organization yet. Create one to start monitoring your locations."}
          </p>

          <CreateOrganizationForm className="mt-6" />

          <p className="mt-6 border-t border-site-border pt-4 text-[13px] text-site-muted">
            You will be its owner, and the only member until you invite somebody.
            Setting it up takes five short steps.
          </p>
        </main>
      </div>
    </div>
  );
}
