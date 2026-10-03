import { AccountPanel } from "../account-panel";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ websiteUrl?: string }>;
}) {
  const { websiteUrl = "" } = await searchParams;
  return <AccountPanel initialWebsiteUrl={websiteUrl.length <= 2048 ? websiteUrl : ""} />;
}
