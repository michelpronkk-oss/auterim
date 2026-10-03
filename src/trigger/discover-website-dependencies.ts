import { schemaTask } from "@trigger.dev/sdk";
import { discoverWebsiteDependenciesPayloadSchema } from "@/lib/discovery/schema";
import { runWebsiteDependencyDiscovery } from "@/lib/discovery/run";

export const discoverWebsiteDependenciesTask = schemaTask({
  id: "discover-website-dependencies",
  schema: discoverWebsiteDependenciesPayloadSchema,
  queue: { concurrencyLimit: 2 },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload, { ctx }) =>
    runWebsiteDependencyDiscovery({
      ...payload,
      triggerRunId: ctx.run.id,
      attemptNumber: ctx.attempt.number,
    }),
});
