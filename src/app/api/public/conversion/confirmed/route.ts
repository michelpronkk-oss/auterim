import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { recordGrowthFirstPartyEvent } from "@/lib/growth-v2/feedback";

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const createdAt = Date.parse(auth.user.created_at ?? "");
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 7 * 86_400_000)
    return Response.json({ error: "signup_event_not_eligible" }, { status: 409 });
  try {
    await recordGrowthFirstPartyEvent({
      eventType: "signup_completed",
      stableKey: auth.user.id,
    });
    return Response.json({ accepted: true }, { status: 202 });
  } catch {
    return Response.json({ error: "event_unavailable" }, { status: 503 });
  }
}
