import "server-only";
import { normalizePublicWebsiteUrl, type UrlDiscoveryResult } from "@/lib/discovery/discovery";
import { discoverCompanySurfaceDependencies } from "@/lib/discovery/company-surfaces";
import { SafeFetchError } from "@/lib/monitoring/fetcher";
import { SupabaseUrlDiscoveryRepository } from "@/lib/discovery/repository";

export async function runWebsiteDependencyDiscovery(
  input: {
    workspaceId: string;
    companyId: string;
    websiteUrl: string;
    deep: boolean;
    triggerRunId: string;
    attemptNumber: number;
    signal?: AbortSignal;
    runtimeEnabled?: boolean;
  },
  dependencies: {
    repository?: Pick<SupabaseUrlDiscoveryRepository, "begin" | "complete" | "fail">;
    discover?: typeof discoverCompanySurfaceDependencies;
  } = {},
) {
  const websiteUrl = normalizePublicWebsiteUrl(input.websiteUrl);
  const repository = dependencies.repository ?? new SupabaseUrlDiscoveryRepository();
  const runId = await repository.begin({ ...input, websiteUrl });
  const discover = dependencies.discover ?? discoverCompanySurfaceDependencies;
  let result: UrlDiscoveryResult;
  try {
    result = await discover(websiteUrl, {
      deep: input.deep,
      runtimeEnabled: input.deep && input.runtimeEnabled === true,
      signal: input.signal,
    });
  } catch (error) {
    const category =
      error instanceof SafeFetchError && /^[a-z_]{1,80}$/.test(error.category)
        ? error.category
        : "discovery_failed";
    try {
      await repository.fail(runId, input.workspaceId, category);
    } catch {
      // Preserve the original discovery error if the database is also unavailable.
    }
    throw error;
  }
  try {
    await repository.complete(runId, input.workspaceId, input.companyId, result);
  } catch (error) {
    try {
      await repository.fail(runId, input.workspaceId, "persistence_error");
    } catch {
      // Preserve the original persistence error if the database is also unavailable.
    }
    throw error;
  }
  return {
    runId,
    status: result.status,
    outcome: result.outcome,
    candidateCount: result.candidates.length,
    evidenceCount: result.evidence.length,
    companyCoverage: result.companyCoverage
      ? Object.fromEntries(
          Object.entries(result.companyCoverage).filter(
            ([key]) => key !== "technologyObservations",
          ),
        )
      : null,
    deepPass: result.deepPass,
    coverage: result.coverage,
    failureCategory: result.failureCategory ?? null,
  };
}
