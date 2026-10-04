import { logger, schemaTask } from "@trigger.dev/sdk";
import { discoverWebsiteDependenciesPayloadSchema } from "@/lib/discovery/schema";
import { runWebsiteDependencyDiscovery } from "@/lib/discovery/run";

export const discoverWebsiteDependenciesTask = schemaTask({
  id: "discover-website-dependencies",
  schema: discoverWebsiteDependenciesPayloadSchema,
  queue: { concurrencyLimit: 1 },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload, { ctx, signal }) => {
    const result = await runWebsiteDependencyDiscovery({
      ...payload,
      triggerRunId: ctx.run.id,
      attemptNumber: ctx.attempt.number,
      signal,
      runtimeEnabled: process.env.AUTERIM_DISCOVERY_RUNTIME_ENABLED === "1",
    });
    logger.log("Discovery scan coverage", {
      outcome: result.outcome,
      candidateCount: result.candidateCount,
      staticQuality: result.coverage.staticCoverage.quality,
      staticDurationMs: result.coverage.staticCoverage.durationMs,
      staticBytes: result.coverage.html.bytesRead,
      staticReferences: result.coverage.html.referencesExtracted,
      staticScriptsFetched: result.coverage.javascript.scriptsFetched,
      runtimeAttempted: result.coverage.runtime.attempted,
      runtimeDurationMs: result.coverage.runtime.durationMs,
      runtimeRequests: result.coverage.runtime.requestsObserved,
      runtimeHosts: result.coverage.runtime.uniqueHosts,
      runtimeMatches: result.coverage.runtime.providerMatches,
      runtimeBlocked: result.coverage.runtime.blockedUnsafeRequests,
      totalDurationMs: result.coverage.durationMs,
    });
    return result;
  },
});
