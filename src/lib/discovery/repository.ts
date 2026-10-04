import "server-only";
import { z } from "zod";
import type {
  DiscoveryCandidate,
  DiscoveryEvidence,
  UrlDiscoveryResult,
} from "@/lib/discovery/discovery";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error("Supabase URL discovery operation failed.");
}

export class SupabaseUrlDiscoveryRepository {
  private readonly client = createSupabaseServerClient();

  async begin(input: {
    workspaceId: string;
    companyId: string;
    websiteUrl: string;
    triggerRunId: string;
    attemptNumber: number;
    deep: boolean;
  }): Promise<string> {
    const company = await this.client
      .from("companies")
      .select("id")
      .eq("id", input.companyId)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    throwOnError(company.error);
    if (!company.data)
      throw new Error("Discovery company is not available in the requested workspace.");

    const { data, error } = await this.client
      .from("dependency_discovery_runs")
      .insert({
        workspace_id: input.workspaceId,
        company_id: input.companyId,
        website_url: input.websiteUrl,
        trigger_run_id: input.triggerRunId,
        attempt_number: input.attemptNumber,
        deep_pass_requested: input.deep,
      })
      .select("id")
      .single();
    throwOnError(error);
    return z.string().uuid().parse(data?.id);
  }

  async complete(
    runId: string,
    workspaceId: string,
    companyId: string,
    result: UrlDiscoveryResult,
  ) {
    if (result.evidence.length > 500 || result.candidates.length > 100) {
      throw new Error("Discovery result exceeded its storage bounds.");
    }
    const { error } = await this.client.rpc("complete_url_dependency_discovery_run", {
      p_run_id: runId,
      p_workspace_id: workspaceId,
      p_company_id: companyId,
      p_status: result.status,
      p_error_category: result.failureCategory ?? null,
      p_deep_pass_requested: result.deepPass.requested,
      p_deep_scripts_fetched: result.deepPass.scriptsFetched,
      p_deep_bytes_fetched: result.deepPass.bytesFetched,
      p_coverage: {
        ...result.coverage,
        ...(result.companyCoverage ? { company: result.companyCoverage } : {}),
      },
      p_evidence: result.evidence.map(evidenceRpcRow),
      p_candidates: result.candidates.map(candidateRpcRow),
    });
    throwOnError(error);
  }

  async fail(runId: string, workspaceId: string, category: string) {
    const safeCategory = /^[a-z_]{1,80}$/.test(category) ? category : "discovery_failed";
    const { error } = await this.client.rpc("fail_url_dependency_discovery_run", {
      p_run_id: runId,
      p_workspace_id: workspaceId,
      p_error_category: safeCategory,
    });
    throwOnError(error);
  }
}

function evidenceRpcRow(item: DiscoveryEvidence) {
  return {
    provider_slug: item.providerSlug,
    signature_key: item.signatureKey,
    signal_type: item.signalType,
    strength: item.strength,
    source_origin: item.sourceOrigin,
    surface_type: item.surfaceType,
    surface_host: item.surfaceHost,
  };
}

function candidateRpcRow(candidate: DiscoveryCandidate) {
  return {
    provider_slug: candidate.providerSlug,
    confidence: candidate.confidence,
    confidence_label: candidate.confidenceLabel,
    evidence_summary: evidenceSummary(candidate.evidence),
  };
}

function evidenceSummary(evidence: DiscoveryEvidence[]) {
  return evidence
    .slice(0, 50)
    .map(({ signatureKey, signalType, strength, sourceOrigin, surfaceType, surfaceHost }) => ({
      signatureKey,
      signalType,
      strength,
      sourceOrigin,
      surfaceType,
      surfaceHost,
    }));
}
