import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import { resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";
import { redactSecretShapedContent, type RepositoryTarget } from "@/lib/preflight/preflight";
import { validatePatchInDocker } from "@/lib/preflight/docker-validation";
import { getEnvironment } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isRepositoryProtectedForProduct } from "@/lib/repositories/product-repository-protection";
import {
  logM15LocalTaskOutcome,
  shouldInjectM15PostCommitRetry,
  waitForM15LocalAcceptancePreClaimGate,
  waitForM15LocalAcceptancePostWorkGate,
} from "@/lib/m15/local-trigger-proof";

const schema = z.object({
  queueId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  proposalId: z.string().uuid(),
  patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().min(1).max(5),
});

type QueueIdentity = {
  workspace_id: string;
  remediation_proposal_id: string;
  patch_fingerprint: string;
  status: string;
  attempt_count: number;
};

type Proposal = {
  id: string;
  workspace_id: string;
  patch: string | null;
  patch_fingerprint: string | null;
  patch_validation_status: string;
  base_commit_sha: string | null;
  workspace_dependency_id: string | null;
  product_id: string;
  generation_metadata: Record<string, unknown>;
};

function code(error: unknown) {
  const message = error instanceof Error ? error.message : "validation_failed";
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : "validation_failed";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryMetadata(value: unknown) {
  return z
    .object({
      id: z.string().uuid(),
      owner: z.string().min(1).max(100),
      name: z.string().min(1).max(100),
      commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    })
    .parse(value);
}

async function repositorySnapshot(input: {
  workspaceId: string;
  workspaceDependencyId: string | null;
  productId: string;
  metadata: unknown;
  baseCommitSha: string;
  internalQaOnly: boolean;
}) {
  const localQa =
    process.env.NODE_ENV !== "production" &&
    process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1" &&
    input.internalQaOnly;
  if (localQa) {
    const fixture = path.resolve(process.cwd(), "tests/fixtures/m15-money-path");
    return { directory: fixture, cleanup: async () => {} };
  }
  const metadata = repositoryMetadata(input.metadata);
  if (metadata.commitSha !== input.baseCommitSha) throw new Error("repository_commit_mismatch");
  const client = createSupabaseServerClient();
  const { data: repository, error: repositoryError } = await client
    .from("repositories")
    .select(
      "id,workspace_id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
    )
    .eq("id", metadata.id)
    .eq("workspace_id", input.workspaceId)
    .eq("status", "available")
    .maybeSingle();
  if (repositoryError || !repository || !input.workspaceDependencyId)
    throw new Error("validation_repository_unavailable");
  const { data: productMappings, error: mappingError } = await client
    .from("workspace_product_repositories")
    .select("repository_id,protected_product_id,status")
    .eq("workspace_id", input.workspaceId)
    .eq("repository_id", metadata.id);
  if (mappingError) throw new Error("validation_repository_unavailable");
  const { data: accessEdges, error: accessError } = await client
    .from("workspace_repository_access")
    .select("workspace_dependency_id")
    .eq("workspace_id", input.workspaceId)
    .eq("repository_id", metadata.id);
  if (accessError) throw new Error("validation_repository_unavailable");
  const attributedDependencyIds = [
    ...new Set((accessEdges ?? []).map((edge) => edge.workspace_dependency_id as string)),
  ];
  const { data: attributedDependencies, error: attributedDependenciesError } =
    attributedDependencyIds.length
      ? await client
          .from("workspace_dependencies")
          .select("id,protected_product_id")
          .eq("workspace_id", input.workspaceId)
          .in("id", attributedDependencyIds)
      : { data: [], error: null };
  if (attributedDependenciesError) throw new Error("validation_repository_unavailable");
  const dependencyProductIds = [
    ...new Set(
      (attributedDependencies ?? []).map((dependency) => dependency.protected_product_id as string),
    ),
  ];
  if (
    !isRepositoryProtectedForProduct({
      selectedForProtection: repository.selected_for_protection === true,
      productId: input.productId,
      mappings: productMappings ?? [],
      dependencyProductIds,
    })
  ) {
    throw new Error("validation_product_repository_unavailable");
  }
  if (
    !(accessEdges ?? []).some(
      (edge) => edge.workspace_dependency_id === input.workspaceDependencyId,
    )
  )
    throw new Error("validation_repository_access_required");
  const { data: connection, error: connectionError } = await client
    .from("repository_connections")
    .select("installation_id,status")
    .eq("id", repository.connection_id)
    .eq("workspace_id", input.workspaceId)
    .eq("status", "connected")
    .maybeSingle();
  if (connectionError || !connection) throw new Error("validation_repository_connection_required");
  const target: RepositoryTarget = {
    id: metadata.id,
    workspaceId: input.workspaceId,
    owner: String(repository.owner),
    name: String(repository.name),
    defaultBranch: String(repository.default_branch),
    externalId: Number(repository.external_id),
    installationId: Number(connection.installation_id),
  };
  if (
    target.owner.toLowerCase() !== metadata.owner.toLowerCase() ||
    target.name.toLowerCase() !== metadata.name.toLowerCase() ||
    !Number.isSafeInteger(target.installationId) ||
    target.installationId <= 0
  ) {
    throw new Error("validation_repository_identity_mismatch");
  }
  const environment = getEnvironment();
  const provider = new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
  const scratchRoot = path.resolve("node_modules/.cache/m15-validation/checkouts");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, "repo-"));
  try {
    await provider.materializeRepository(target, input.baseCommitSha, directory);
    return {
      directory,
      cleanup: async () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const validateRemediationTask = schemaTask({
  id: "validate-remediation",
  schema,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 15_000,
    factor: 2,
    randomize: true,
  },
  queue: { concurrencyLimit: 2 },
  run: async (payload, context) => {
    const ctx = context?.ctx;
    const report = async (outcome: string) => {
      if (ctx) {
        await logM15LocalTaskOutcome({
          taskId: "validate-remediation",
          runId: ctx.run.id,
          queueId: payload.queueId,
          queueAttempt: payload.attempt,
          triggerAttempt: ctx.attempt.number,
          outcome,
        });
      }
    };
    const client = createSupabaseServerClient();
    const { data: queue, error: queueError } = await client
      .from("remediation_validation_queue")
      .select("workspace_id,remediation_proposal_id,patch_fingerprint,status,attempt_count")
      .eq("id", payload.queueId)
      .maybeSingle();
    if (queueError) throw new Error("validation_queue_read_failed");
    const identity = queue as QueueIdentity | null;
    if (
      !identity ||
      identity.workspace_id !== payload.workspaceId ||
      identity.remediation_proposal_id !== payload.proposalId ||
      identity.patch_fingerprint !== payload.patchFingerprint ||
      identity.attempt_count !== payload.attempt
    ) {
      throw new AbortTaskRunError("Validation queue identity is invalid.");
    }
    if (identity.status === "validated" || identity.status === "validation_failed") {
      await report("replayed");
      return { status: "replayed" as const };
    }
    if (identity.status === "denied" || identity.status === "canceled") {
      await report(identity.status);
      return { status: identity.status as "denied" | "canceled" };
    }
    if (identity.status !== "dispatched" && identity.status !== "running") {
      await report("not_current");
      return { status: "not_current" as const };
    }
    await waitForM15LocalAcceptancePreClaimGate({
      taskId: "validate-remediation",
      queueId: payload.queueId,
    });
    const { data: claimToken, error: claimError } = await client.rpc(
      "claim_remediation_validation",
      { p_queue_id: payload.queueId, p_attempt: payload.attempt },
    );
    if (claimError) throw new Error("validation_claim_failed");
    if (typeof claimToken !== "string") {
      await report("denied");
      return { status: "denied" as const };
    }

    const entitlements = await resolveWorkspaceEntitlementsForService(payload.workspaceId);
    if (
      !entitlements.capabilities.generateFix ||
      entitlements.usage.remediationRuns >= entitlements.limits.remediationRuns
    ) {
      const { error: completionError } = await client.rpc("complete_remediation_validation", {
        p_queue_id: payload.queueId,
        p_claim_token: claimToken,
        p_outcome: "denied",
        p_error_category: "generate_fix_not_entitled",
        p_commands: [],
        p_diagnostics:
          "Validation was denied because current workspace entitlements do not allow it.",
        p_duration_ms: 0,
      });
      if (completionError) throw new Error("validation_completion_persist_failed");
      await report("denied");
      return { status: "denied" as const };
    }

    const { data: proposalData, error: proposalError } = await client
      .from("remediation_proposals")
      .select(
        "id,workspace_id,patch,patch_fingerprint,patch_validation_status,base_commit_sha,workspace_dependency_id,product_id,generation_metadata",
      )
      .eq("id", payload.proposalId)
      .eq("workspace_id", payload.workspaceId)
      .maybeSingle();
    if (proposalError || !proposalData) throw new Error("validation_proposal_read_failed");
    const proposal = proposalData as Proposal;
    const metadata = proposal.generation_metadata;
    const evidenceId = metadata.replacementEvidenceId;
    const repository = metadata.repository;
    const internalQaOnly = metadata.internalQaOnly === true;
    if (
      proposal.patch_validation_status !== "validating" ||
      !proposal.patch ||
      !proposal.base_commit_sha ||
      !proposal.patch_fingerprint ||
      typeof evidenceId !== "string" ||
      proposal.patch_fingerprint !==
        digest(`${digest(`${proposal.base_commit_sha}\n${proposal.patch}`)}\n${evidenceId}`) ||
      proposal.patch_fingerprint !== payload.patchFingerprint
    ) {
      const { error: completionError } = await client.rpc("complete_remediation_validation", {
        p_queue_id: payload.queueId,
        p_claim_token: claimToken,
        p_outcome: "denied",
        p_error_category: "patch_identity_mismatch",
        p_commands: [],
        p_diagnostics: "The persisted patch no longer matches its queued identity.",
        p_duration_ms: 0,
      });
      if (completionError) throw new Error("validation_completion_persist_failed");
      await report("denied");
      return { status: "denied" as const };
    }

    let snapshot: Awaited<ReturnType<typeof repositorySnapshot>> | null = null;
    let validation: Awaited<ReturnType<typeof validatePatchInDocker>>;
    try {
      snapshot = await repositorySnapshot({
        workspaceId: payload.workspaceId,
        workspaceDependencyId: proposal.workspace_dependency_id,
        productId: proposal.product_id,
        metadata: repository,
        baseCommitSha: proposal.base_commit_sha,
        internalQaOnly,
      });
      validation = await validatePatchInDocker({
        repositoryDirectory: snapshot.directory,
        patch: proposal.patch,
        timeoutMs: 120_000,
      });
    } catch (error) {
      validation = {
        state: "VALIDATION_FAILED",
        category: code(error),
        commands: [],
        output: "Validation could not complete safely.",
        durationMs: 0,
      };
    } finally {
      await snapshot?.cleanup();
    }
    const outcome = validation.state === "VALIDATED" ? "validated" : "validation_failed";
    const safeDiagnostics = redactSecretShapedContent(validation.output).slice(0, 4000);
    await waitForM15LocalAcceptancePostWorkGate({
      taskId: "validate-remediation",
      queueId: payload.queueId,
    });
    const { error: completionError } = await client.rpc("complete_remediation_validation", {
      p_queue_id: payload.queueId,
      p_claim_token: claimToken,
      p_outcome: outcome,
      p_error_category: validation.state === "VALIDATED" ? null : validation.category,
      p_commands: validation.commands.slice(0, 10),
      p_diagnostics: safeDiagnostics,
      p_duration_ms: Math.min(Math.max(validation.durationMs, 0), 120_000),
    });
    if (completionError) throw new Error("validation_completion_persist_failed");
    const { data: persistedCompletion, error: persistedCompletionError } = await client
      .from("remediation_validation_queue")
      .select("status,error_category")
      .eq("id", payload.queueId)
      .maybeSingle();
    if (
      persistedCompletionError ||
      !persistedCompletion ||
      !["validated", "validation_failed", "denied"].includes(persistedCompletion.status)
    ) {
      throw new Error("validation_completion_outcome_unavailable");
    }
    const persistedOutcome = persistedCompletion.status as
      "validated" | "validation_failed" | "denied";
    if (persistedOutcome === "denied") {
      await report("denied");
      return { status: "denied" as const };
    }
    if (persistedOutcome !== outcome) {
      throw new Error("validation_completion_outcome_mismatch");
    }
    const injectRetry = shouldInjectM15PostCommitRetry({
      taskId: "validate-remediation",
      queueId: payload.queueId,
      triggerAttempt: ctx?.attempt.number,
    });
    await report(injectRetry ? "persisted_before_retry" : outcome);
    if (injectRetry) throw new Error("m15_local_acceptance_post_commit_retry:validate-remediation");
    return { status: outcome };
  },
});
