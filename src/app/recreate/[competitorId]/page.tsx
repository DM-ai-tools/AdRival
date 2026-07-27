import { RecreatePageClient } from "./RecreatePageClient";

export default async function RecreatePage({
  params,
}: {
  params: Promise<{ competitorId: string }>;
}) {
  const { competitorId } = await params;
  return <RecreatePageClient competitorId={competitorId} />;
}
