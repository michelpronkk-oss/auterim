import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { buildImpactGraph } from "@/lib/impact-graph/repository";

export const buildProviderImpactGraphTask = schemaTask({
  id: "build-provider-impact-graph",
  schema: z.object({
    routeIntentId: z.string().uuid(),
    analysisRunId: z.string().uuid(),
    productId: z.string().uuid(),
    repositoryId: z.string().uuid(),
  }),
  retry: { maxAttempts: 4, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  maxDuration: 300,
  concurrency: { total: 2 },
  run: async (payload) => buildImpactGraph(payload),
});
