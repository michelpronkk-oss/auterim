import { createHash } from "node:crypto";
import { z } from "zod";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import { getEnvironment } from "@/lib/env/schema";
import { serverConnectors } from "@/lib/connectors/service";

const requestSchema = z.object({ workspaceId: z.string().uuid(), repositoryId: z.string().uuid() });
const PREFLIGHT_BASELINE_VERSION = "baseline-v1";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const productId = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!productId.success) return Response.json({ error: "invalid_product" }, { status: 400 });
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return Response.json({ error: "invalid_baseline_preflight_request" }, { status: 400 });
  const { workspaceId, repositoryId } = body.data;

  let role: string | null;
  try {
    role = await getWorkspaceRole(auth.client, workspaceId, auth.user.id);
  } catch {
    return Response.json({ error: "workspace_access_unavailable" }, { status: 503 });
  }
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });

  const [
    { data: product, error: productError },
    { data: repository, error: repositoryError },
    { data: mapping, error: mappingError },
  ] = await Promise.all([
    auth.client
      .from("workspace_products")
      .select("id,status")
      .eq("id", productId.data)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    auth.client
      .from("repositories")
      .select(
        "id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
      )
      .eq("id", repositoryId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    auth.client
      .from("workspace_product_repositories")
      .select("repository_id")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId.data)
      .eq("repository_id", repositoryId)
      .eq("status", "active")
      .maybeSingle(),
  ]);
  if (productError || repositoryError || mappingError)
    return Response.json({ error: "baseline_preflight_unavailable" }, { status: 503 });
  if (!product || !repository) return Response.json({ error: "not_found" }, { status: 404 });
  if (
    product.status !== "protected" ||
    !mapping ||
    repository.status !== "available" ||
    !repository.selected_for_protection
  )
    return Response.json({ error: "baseline_preflight_ineligible" }, { status: 409 });

  const { data: connection, error: connectionError } = await auth.client
    .from("repository_connections")
    .select("installation_id,status")
    .eq("id", repository.connection_id)
    .eq("workspace_id", workspaceId)
    .eq("status", "connected")
    .maybeSingle();
  if (connectionError)
    return Response.json({ error: "baseline_preflight_unavailable" }, { status: 503 });
  if (!connection) return Response.json({ error: "repository_unavailable" }, { status: 409 });

  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, workspaceId);
    if (
      !entitlements.capabilities.automaticPreflight ||
      entitlements.usage.preflightRuns >= entitlements.limits.preflightRuns
    )
      return Response.json({ error: "preflight_not_entitled" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }

  try {
    const environment = getEnvironment();
    const provider = new GitHubAppRepositoryProvider({
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
    });
    const target = {
      id: repository.id,
      workspaceId,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.default_branch,
      externalId: Number(repository.external_id),
      installationId: Number(connection.installation_id),
    };
    const commitSha = await provider.getHead(target);
    if (!/^[a-f0-9]{40,64}$/.test(commitSha))
      return Response.json({ error: "repository_verification_unavailable" }, { status: 503 });
    const repositorySetFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          mode: "baseline",
          productId: productId.data,
          repositoryId: repository.id,
          externalRepositoryId: target.externalId,
          owner: repository.owner.toLowerCase(),
          name: repository.name.toLowerCase(),
          defaultBranch: repository.default_branch,
          commitSha,
        }),
      )
      .digest("hex");
    const { data, error } = await serverConnectors().rpc("persist_baseline_preflight", {
      p_actor_id: auth.user.id,
      p_workspace_id: workspaceId,
      p_product_id: productId.data,
      p_repository_id: repository.id,
      p_external_repository_id: target.externalId,
      p_repository_owner: repository.owner,
      p_repository_name: repository.name,
      p_default_branch: repository.default_branch,
      p_commit_sha: commitSha,
      p_repository_set_fingerprint: repositorySetFingerprint,
      p_preflight_version: PREFLIGHT_BASELINE_VERSION,
    });
    if (error || !Array.isArray(data) || !data[0]) {
      if (error?.message?.startsWith("forbidden"))
        return Response.json({ error: "forbidden" }, { status: 403 });
      if (error?.message?.startsWith("baseline_preflight_ineligible"))
        return Response.json({ error: "baseline_preflight_ineligible" }, { status: 409 });
      return Response.json({ error: "baseline_preflight_persist_failed" }, { status: 503 });
    }
    const result = data[0] as {
      preflight_run_id: string;
      baseline_evidence_id: string;
      created: boolean;
      observed_at: string;
    };
    return Response.json(
      {
        preflightRunId: result.preflight_run_id,
        mode: "baseline",
        evidenceId: result.baseline_evidence_id,
        repositoryId: repository.id,
        repository: `${repository.owner}/${repository.name}`,
        verifiedCommitSha: commitSha,
        verificationState: "verified",
        observedAt: result.observed_at,
        replayed: !result.created,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json({ error: "repository_verification_unavailable" }, { status: 503 });
  }
}
