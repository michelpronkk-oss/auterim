import { z } from "zod";
import { getWorkspaceRole } from "@/lib/billing/server";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };
const workspaceIdSchema = z.string().uuid();
const addMemberSchema = z
  .object({ workspaceId: z.string().uuid(), email: z.string().trim().email().max(254) })
  .strict();

function forbidden() {
  return Response.json({ error: "forbidden" }, { status: 403, headers: PRIVATE_NO_STORE });
}

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const parsed = workspaceIdSchema.safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!parsed.success)
    return Response.json(
      { error: "invalid_workspace_id" },
      { status: 400, headers: PRIVATE_NO_STORE },
    );

  const role = await getWorkspaceRole(auth.client, parsed.data, auth.user.id).catch(() => null);
  if (role !== "owner" && role !== "admin") return forbidden();

  const service = createSupabaseServerClient();
  const { data, error } = await service.rpc("list_workspace_members_for_admin", {
    p_workspace_id: parsed.data,
    p_actor_user_id: auth.user.id,
  });
  if (error)
    return Response.json(
      { error: error.code === "42501" ? "forbidden" : "members_unavailable" },
      { status: error.code === "42501" ? 403 : 503, headers: PRIVATE_NO_STORE },
    );

  return Response.json({ members: data ?? [] }, { headers: PRIVATE_NO_STORE });
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const parsedBody = await request.json().catch(() => null);
  const parsed = addMemberSchema.safeParse(parsedBody);
  if (!parsed.success)
    return Response.json(
      { error: "invalid_member_request" },
      { status: 400, headers: PRIVATE_NO_STORE },
    );

  const role = await getWorkspaceRole(auth.client, parsed.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin") return forbidden();

  const service = createSupabaseServerClient();
  const { error } = await service.rpc("add_existing_workspace_member", {
    p_workspace_id: parsed.data.workspaceId,
    p_actor_user_id: auth.user.id,
    p_email: parsed.data.email.toLowerCase(),
  });
  if (error) {
    if (error.code === "42501") return forbidden();
    return Response.json(
      { error: error.code === "22023" ? "invalid_member_request" : "member_add_unavailable" },
      { status: error.code === "22023" ? 400 : 503, headers: PRIVATE_NO_STORE },
    );
  }

  // Same response for an unknown account and an existing/already-member account.
  return Response.json(
    { processed: true, message: "If an existing Auterim account matches, access is available." },
    { headers: PRIVATE_NO_STORE },
  );
}
