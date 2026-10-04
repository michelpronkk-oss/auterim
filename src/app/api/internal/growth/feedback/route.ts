import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { searchConsoleAdminEmails } from "@/lib/growth-v2/search-console";
import {
  evaluateGrowthFeedback,
  getGrowthFeedbackReadModel,
  syncSearchConsole,
} from "@/lib/growth-v2/feedback";
import { isAllowedVerifiedGrowthAdmin } from "@/lib/growth-v2/contract";

type AuthorizationResult = { ok: true } | { ok: false; response: Response };

async function authorized(request: Request): Promise<AuthorizationResult> {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return { ok: false, response: auth.response };
  if (
    !isAllowedVerifiedGrowthAdmin(
      auth.user.email,
      auth.user.email_confirmed_at,
      searchConsoleAdminEmails(),
    )
  )
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true };
}

export async function GET(request: Request) {
  const auth = await authorized(request);
  if (!auth.ok) return auth.response;
  try {
    return Response.json(await getGrowthFeedbackReadModel(), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "growth_feedback_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (!auth.ok) return auth.response;
  try {
    const input = (await request.json()) as { operation?: unknown };
    if (input.operation === "sync")
      return Response.json(await syncSearchConsole(), { headers: { "cache-control": "no-store" } });
    if (input.operation === "evaluate")
      return Response.json(await evaluateGrowthFeedback(), {
        headers: { "cache-control": "no-store" },
      });
    return Response.json({ error: "invalid_operation" }, { status: 400 });
  } catch {
    return Response.json({ error: "growth_feedback_operation_failed" }, { status: 503 });
  }
}
