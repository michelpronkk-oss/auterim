import "server-only";
import { discoverWebsiteDependencies, normalizePublicWebsiteUrl } from "@/lib/discovery/discovery";
import { SupabaseUrlDiscoveryRepository } from "@/lib/discovery/repository";

export async function runWebsiteDependencyDiscovery(
  input: {
    workspaceId: string;
    companyId: string;
    websiteUrl: string;
    deep: boolean;
    triggerRunId: string;
    attemptNumber: number;
  },
  dependencies: {
    repository?: Pick<SupabaseUrlDiscoveryRepository, "begin" | "complete" | "fail">;
    discover?: typeof discoverWebsiteDependencies;
  } = {},
) {
  const websiteUrl = normalizePublicWebsiteUrl(input.websiteUrl);
  const repository = dependencies.repository ?? new SupabaseUrlDiscoveryRepository();
  const runId = await repository.begin({ ...input, websiteUrl });
  try {
    const discover = dependencies.discover ?? discoverWebsiteDependencies;
    const result = await discover(websiteUrl, { deep: input.deep });
    await repository.complete(runId, input.workspaceId, input.companyId, result);
    return {
      runId,
      status: result.status,
      candidateCount: result.candidates.length,
      evidenceCount: result.evidence.length,
      deepPass: result.deepPass,
      failureCategory: result.failureCategory ?? null,
    };
  } catch (error) {
    await repository.fail(runId, input.workspaceId, "discovery_failed");
    throw error;
  }
}
