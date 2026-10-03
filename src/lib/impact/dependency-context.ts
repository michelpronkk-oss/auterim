import "server-only";
import { z } from "zod";
import {
  dependencyImpactContextSchema,
  type DependencyImpactContext,
  type DependencyUsageMetadata,
} from "@/lib/impact/impact";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const contextInputSchema = dependencyImpactContextSchema.extend({
  workspaceId: z.string().uuid(),
  workspaceDependencyId: z.string().uuid(),
});

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error("Workspace dependency context operation failed.");
}

/** Trusted server-side write boundary. Never expose this service-role function directly to clients. */
export async function setDependencyImpactContext(input: {
  workspaceId: string;
  workspaceDependencyId: string;
  criticality: DependencyImpactContext["criticality"];
  productionCritical: boolean;
  usedFor: DependencyImpactContext["usedFor"];
  contextNote: string;
  usageMetadata?: DependencyUsageMetadata;
}) {
  const value = contextInputSchema.parse(input);
  if (Buffer.byteLength(value.contextNote, "utf8") > 2000) {
    throw new Error("Dependency context note is too large.");
  }
  if (Buffer.byteLength(JSON.stringify(value.usageMetadata), "utf8") > 4000) {
    throw new Error("Dependency usage metadata is too large.");
  }
  const client = createSupabaseServerClient();
  const { data, error } = await client.rpc("upsert_dependency_impact_context", {
    p_workspace_id: value.workspaceId,
    p_workspace_dependency_id: value.workspaceDependencyId,
    p_criticality: value.criticality,
    p_production_critical: value.productionCritical,
    p_used_for: value.usedFor,
    p_context_note: value.contextNote,
    p_usage_metadata: value.usageMetadata,
  });
  throwOnError(error);
  return data;
}

/** Trusted server-side read boundary. Returns defaults for dependencies without saved context. */
export async function getDependencyImpactContext(input: {
  workspaceId: string;
  workspaceDependencyId: string;
}): Promise<DependencyImpactContext> {
  const ids = z
    .object({ workspaceId: z.string().uuid(), workspaceDependencyId: z.string().uuid() })
    .parse(input);
  const client = createSupabaseServerClient();
  const { data, error } = await client.rpc("get_dependency_impact_context", {
    p_workspace_id: ids.workspaceId,
    p_workspace_dependency_id: ids.workspaceDependencyId,
  });
  throwOnError(error);
  return dependencyImpactContextSchema.parse(data);
}
