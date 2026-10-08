import { z } from "zod";
import { claimPublicRateLimit } from "@/lib/public/rate-limit";
import { cliSecretHash } from "@/lib/cli/security";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readBoundedTextBody } from "@/lib/http/bounded-body";

const inputSchema = z
  .object({
    userCode: z
      .string()
      .trim()
      .regex(/^[A-Fa-f0-9-]{10,12}$/),
    workspaceId: z.string().uuid(),
    companyId: z.string().uuid(),
    productId: z.string().uuid(),
  })
  .strict();

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return privateJson({ error: "authentication_required" }, 401);
  const limit = await claimPublicRateLimit(request, "cli_connect_approval", {
    allowLocalLoopback: true,
  });
  if (limit.status === "limited") return privateJson({ error: "rate_limited" }, 429);
  if (limit.status === "unavailable") return privateJson({ error: "temporarily_unavailable" }, 503);
  let input: z.infer<typeof inputSchema>;
  try {
    const text = await readBoundedTextBody(request.body, 2048);
    if (Buffer.byteLength(text, "utf8") > 2048)
      return privateJson({ error: "invalid_request" }, 400);
    input = inputSchema.parse(JSON.parse(text));
  } catch {
    return privateJson({ error: "invalid_request" }, 400);
  }
  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return privateJson({ error: "owner_or_admin_required" }, 403);
  try {
    const client = createSupabaseServerClient();
    const code = input.userCode.replaceAll("-", "").toUpperCase();
    const { data, error } = await client.rpc("approve_cli_connect_session", {
      p_user_code_hash: cliSecretHash(code, "user-code"),
      p_actor_user_id: auth.user.id,
      p_workspace_id: input.workspaceId,
      p_company_id: input.companyId,
      p_product_id: input.productId,
    });
    if (error || !Array.isArray(data) || data.length !== 1)
      return privateJson({ error: "cli_authorization_unavailable" }, 404);
    return privateJson({
      state: "approved",
      expiresAt: (data[0] as { expires_at: string }).expires_at,
    });
  } catch {
    return privateJson({ error: "cli_authorization_unavailable" }, 503);
  }
}
