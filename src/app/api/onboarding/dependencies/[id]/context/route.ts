import { z } from "zod";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";

const dependencyCriticalitySchema = z.enum(["critical", "important", "normal"]);
const dependencyUsageSchema = z.enum([
  "customer-facing product",
  "authentication",
  "billing",
  "email",
  "AI processing",
  "verification",
  "internal workflows",
  "analytics",
  "infrastructure",
  "database",
  "other",
]);
const dependencyUsageMetadataSchema = z
  .object({
    modelNames: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    endpointNames: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    workflowNames: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    monthlyRequestVolume: z
      .number()
      .int()
      .nonnegative()
      .max(1_000_000_000_000)
      .nullable()
      .optional(),
  })
  .strict();

const inputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    criticality: dependencyCriticalitySchema.optional(),
    productionCritical: z.boolean().optional(),
    usedFor: z.array(dependencyUsageSchema).max(12).optional(),
    contextNote: z.string().trim().max(2000).optional(),
    usageMetadata: dependencyUsageMetadataSchema.optional(),
  })
  .strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await context.params;
    const workspaceDependencyId = z.string().uuid().parse(id);
    const input = inputSchema.parse(await parseJsonBody(request));
    const { data, error } = await auth.client.rpc("set_onboarding_dependency_context", {
      p_workspace_id: input.workspaceId,
      p_workspace_dependency_id: workspaceDependencyId,
      p_criticality: input.criticality ?? null,
      p_production_critical: input.productionCritical ?? null,
      p_used_for: input.usedFor ?? null,
      p_context_note: input.contextNote ?? null,
      p_usage_metadata: input.usageMetadata ?? null,
    });
    if (error) return onboardingError(error);
    return Response.json(data);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_dependency_context" }, { status: 400 });
    return onboardingError(error);
  }
}
