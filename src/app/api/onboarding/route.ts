import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { normalizePublicWebsiteUrl } from "@/lib/discovery/discovery";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";
import type { discoverWebsiteDependenciesTask } from "@/trigger/discover-website-dependencies";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const workspaceIdSchema = z.string().uuid();
const startSchema = z
  .object({
    workspaceId: workspaceIdSchema.optional(),
    workspaceName: z.string().trim().min(1).max(120),
    companyName: z.string().trim().min(1).max(160),
    websiteUrl: z.string().trim().min(1).max(2048),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  const parsed = workspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) return Response.json({ error: "invalid_workspace_id" }, { status: 400 });
  const { data, error } = await auth.client.rpc("get_onboarding_status", {
    p_workspace_id: parsed.data,
  });
  if (error) return onboardingError(error);
  return Response.json(data);
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = startSchema.parse(await parseJsonBody(request));
    const websiteUrl = normalizePublicWebsiteUrl(input.websiteUrl);
    const websiteDomain = new URL(websiteUrl).hostname.toLowerCase();
    const dispatchClient = createSupabaseServerClient();
    const { data, error } = await dispatchClient.rpc("start_workspace_onboarding", {
      p_actor_user_id: auth.user.id,
      p_workspace_name: input.workspaceName,
      p_company_name: input.companyName,
      p_website_url: websiteUrl,
      p_website_domain: websiteDomain,
      p_idempotency_key: input.idempotencyKey,
      p_workspace_id: input.workspaceId ?? null,
    });
    if (error) return onboardingError(error);
    const started = z
      .object({
        workspaceId: z.string().uuid(),
        companyId: z.string().uuid(),
        state: z.string(),
        replayed: z.boolean(),
      })
      .parse(data);

    if (started.state === "company_created") {
      const claim = await dispatchClient.rpc("claim_onboarding_discovery_dispatch", {
        p_actor_user_id: auth.user.id,
        p_workspace_id: started.workspaceId,
        p_company_id: started.companyId,
      });
      if (claim.error) return onboardingError(claim.error);
      const dispatch = z
        .object({ dispatch: z.boolean(), attempt: z.number().int() })
        .parse(claim.data);
      if (dispatch.dispatch) {
        try {
          const idempotencyKey = await idempotencyKeys.create(
            `onboarding-discovery:${started.companyId}:${dispatch.attempt}`,
            { scope: "global" },
          );
          const handle = await tasks.trigger<typeof discoverWebsiteDependenciesTask>(
            "discover-website-dependencies",
            {
              workspaceId: started.workspaceId,
              companyId: started.companyId,
              websiteUrl,
              deep: false,
            },
            { idempotencyKey },
          );
          const marked = await dispatchClient.rpc("mark_onboarding_discovery_started", {
            p_actor_user_id: auth.user.id,
            p_workspace_id: started.workspaceId,
            p_company_id: started.companyId,
            p_trigger_task_id: handle.id,
          });
          if (marked.error) throw marked.error;
          return Response.json(
            { ...started, state: marked.data, discoveryQueued: true },
            { status: 202 },
          );
        } catch {
          await dispatchClient.rpc("release_onboarding_discovery_dispatch", {
            p_actor_user_id: auth.user.id,
            p_workspace_id: started.workspaceId,
            p_company_id: started.companyId,
            p_attempt: dispatch.attempt,
          });
          return Response.json(
            {
              error: "discovery_dispatch_unavailable",
              workspaceId: started.workspaceId,
              companyId: started.companyId,
            },
            { status: 503 },
          );
        }
      }
    }
    return Response.json({ ...started, discoveryQueued: false }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_onboarding_input" }, { status: 400 });
    return onboardingError(error);
  }
}
