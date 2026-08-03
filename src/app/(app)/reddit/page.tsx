import { notFound, redirect } from "next/navigation";
import { getDataSource } from "@/lib/data";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";

/** Opens the Reddit workspace on the most recent thread. */
export default async function RedditIndexPage() {
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  const [first] = await dataSource.mentions.list(scope, {
    sourceTypes: ["reddit_post"],
    limit: 1,
  });

  if (!first) notFound();
  redirect(`/reddit/${first.id}`);
}
