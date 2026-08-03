import { notFound, redirect } from "next/navigation";
import { getDataSource } from "@/lib/data";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";

/** Opens the news and media workspace on the most recent article. */
export default async function MediaIndexPage() {
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  const [first] = await dataSource.mentions.list(scope, {
    sourceTypes: ["news_article"],
    limit: 1,
  });

  if (!first) notFound();
  redirect(`/media/${first.id}`);
}
