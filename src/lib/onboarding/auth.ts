import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/env/schema";

export type OnboardingAuthResult =
  { ok: true; client: SupabaseClient; user: User } | { ok: false; response: Response };

export async function authenticateOnboardingRequest(
  request: Request,
): Promise<OnboardingAuthResult> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) {
    return {
      ok: false,
      response: Response.json({ error: "authentication_required" }, { status: 401 }),
    };
  }

  try {
    const { url, publishableKey } = getSupabasePublicConfig();
    const client = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user || data.user.is_anonymous) {
      return {
        ok: false,
        response: Response.json({ error: "authentication_required" }, { status: 401 }),
      };
    }
    return { ok: true, client, user: data.user };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "authentication_unavailable" }, { status: 503 }),
    };
  }
}

export function jsonBody(request: Request): Promise<unknown> {
  return request.json();
}

export function onboardingError(error: unknown): Response {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const message =
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  if (code === "42501") return Response.json({ error: "forbidden" }, { status: 403 });
  if (message === "unsupported_dependency") {
    return Response.json({ error: "unsupported_dependency" }, { status: 422 });
  }
  if (code === "P0002") return Response.json({ error: "not_found" }, { status: 404 });
  if (code === "22023" || code === "23514") {
    return Response.json({ error: "invalid_onboarding_operation" }, { status: 400 });
  }
  return Response.json({ error: "onboarding_operation_failed" }, { status: 500 });
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { code: "22023" });
  }
}

export type OnboardingClient = SupabaseClient;
