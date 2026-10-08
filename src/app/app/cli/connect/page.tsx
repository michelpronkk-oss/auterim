import { CliConnectApproval } from "./panel";

export default async function CliConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  return <CliConnectApproval initialCode={code ?? ""} />;
}
