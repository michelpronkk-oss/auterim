import { z } from "zod";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const inputSchema = z
  .object({
    workspaceName: z.string().trim().min(1).max(120),
    companyName: z.string().trim().min(1).max(160),
    websiteUrl: z.string().trim().url().max(2048),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await parseJsonBody(request));
    const url = new URL(input.websiteUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return Response.json({ error: "invalid_company_url" }, { status: 400 });
    }
    const websiteDomain = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    url.search = "";
    url.pathname = "/";
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("start_workspace_onboarding", {
      p_actor_user_id: auth.user.id,
      p_workspace_name: input.workspaceName,
      p_company_name: input.companyName,
      p_website_url: url.toString(),
      p_website_domain: websiteDomain,
      p_idempotency_key: input.idempotencyKey,
      p_workspace_id: null,
    });
    if (error) {
      if (error.code === "42501") return Response.json({ error: "forbidden" }, { status: 403 });
      if (error.code === "23505" || error.code === "22023")
        return Response.json({ error: "invalid_onboarding_request" }, { status: 400 });
      return Response.json({ error: "workspace_setup_failed" }, { status: 503 });
    }
    return Response.json(data, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_onboarding_request" }, { status: 400 });
    return Response.json({ error: "workspace_setup_failed" }, { status: 400 });
  }
}
