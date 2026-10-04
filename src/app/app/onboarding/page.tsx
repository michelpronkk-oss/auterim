import { AccountPanel } from "../account-panel";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ websiteUrl?: string }>;
}) {
  const { websiteUrl = "" } = await searchParams;
  return (
    <AccountPanel initialWebsiteUrl={websiteUrl.length <= 2048 ? websiteUrl : ""} onboardingMode />
  );
}
