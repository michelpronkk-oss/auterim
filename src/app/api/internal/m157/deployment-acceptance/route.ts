import { getWorkspaceRole } from "@/lib/billing/server";
import { isM157CurrentAcceptanceComplete } from "@/lib/m15/deployment-acceptance";
import { runM157InternalAcceptance } from "@/lib/m15/internal-acceptance";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";

const TARGET_WORKSPACE_ID = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function safeFailureCategory(error: unknown) {
  if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message))
    return error.message.slice("m157_acceptance_".length);
  return "unknown_safe";
}

async function hasNonEmptyBody(request: Request): Promise<boolean> {
  const body = request.body;
  if (!body) return false;

  const reader = body.getReader();
  let emptyChunks = 0;
  try {
    while (emptyChunks < 4) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("body_read_timeout")), 1_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (result.done) return false;
      if (result.value.byteLength > 0) {
        void reader.cancel().catch(() => undefined);
        return true;
      }
      emptyChunks += 1;
    }
    return true;
  } catch {
    void reader.cancel().catch(() => undefined);
    return true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The request stream may already have been closed by the runtime.
    }
  }
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;

  let role: Awaited<ReturnType<typeof getWorkspaceRole>>;
  try {
    role = await getWorkspaceRole(auth.client, TARGET_WORKSPACE_ID, auth.user.id);
  } catch {
    return response({ error: "workspace_authorization_unavailable" }, 503);
  }
  if (role !== "owner" && role !== "admin") return response({ error: "forbidden" }, 403);

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return response({ error: "invalid_internal_acceptance_request" }, 400);
  }
  if (url.search || (await hasNonEmptyBody(request)))
    return response({ error: "invalid_internal_acceptance_request" }, 400);

  try {
    if (await isM157CurrentAcceptanceComplete()) return response({ status: "already_completed" });
    return response(await runM157InternalAcceptance(auth.user.id));
  } catch (error) {
    return response({ error: "m157_acceptance_failed", category: safeFailureCategory(error) }, 503);
  }
}
