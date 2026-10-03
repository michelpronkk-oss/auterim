import { DashboardPage } from "../../dashboard-pages";

export default async function DependencyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DashboardPage kind="dependency" id={id} />;
}
