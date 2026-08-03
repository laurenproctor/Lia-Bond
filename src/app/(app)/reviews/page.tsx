import { notFound, redirect } from "next/navigation";
import { getDataSource } from "@/lib/data";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";

/**
 * "Reviews" in the sidebar opens the review workspace on the most recent item
 * rather than an extra index screen — the queue lives inside the workspace.
 */
export default async function ReviewsIndexPage() {
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  const [first] = await dataSource.mentions.list(scope, {
    sourceTypes: ["google_review"],
    limit: 1,
  });

  if (!first) notFound();
  redirect(`/reviews/google/${first.id}`);
}
