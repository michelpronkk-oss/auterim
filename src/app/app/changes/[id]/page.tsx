import { DashboardPage } from "../../dashboard-pages";

export default async function ChangeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DashboardPage kind="change" id={id} />;
}
