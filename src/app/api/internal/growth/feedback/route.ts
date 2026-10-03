import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { searchConsoleAdminEmails } from "@/lib/growth-v2/search-console";
import {
  evaluateGrowthFeedback,
  getGrowthFeedbackReadModel,
  syncSearchConsole,
} from "@/lib/growth-v2/feedback";

async function authorized(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return { response: auth.response };
  const email = auth.user.email?.trim().toLowerCase();
  if (!email || !searchConsoleAdminEmails().has(email))
    return { response: Response.json({ error: "forbidden" }, { status: 403 }) };
  return { userId: auth.user.id };
}

export async function GET(request: Request) {
  const auth = await authorized(request);
  if ("response" in auth) return auth.response;
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
  if ("response" in auth) return auth.response;
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
