import { randomUUID } from "node:crypto";
import { claimPublicRateLimit } from "@/lib/public/rate-limit";
import { cliSecretHash, deriveCliCredential, newPollSecret, newUserCode } from "@/lib/cli/security";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import { readBoundedTextBody } from "@/lib/http/bounded-body";

const poll = async (request: Request) => {
  const result = await claimPublicRateLimit(request, "cli_connect", { allowLocalLoopback: true });
  if (result.status === "limited")
    return { response: privateJson({ error: "rate_limited" }, { status: 429 }) };
  if (result.status === "unavailable")
    return { response: privateJson({ error: "temporarily_unavailable" }, { status: 503 }) };
  return {};
};

function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  return Response.json(body, { ...init, headers });
}

export async function POST(request: Request) {
  try {
    await readBoundedTextBody(request.body, 0);
  } catch {
    return privateJson({ error: "invalid_request" }, { status: 400 });
  }
  const limit = await poll(request);
  if (limit.response) return limit.response;
  const sessionId = randomUUID();
  const userCode = newUserCode();
  const pollSecret = newPollSecret();
  const credential = deriveCliCredential(sessionId, pollSecret);
  try {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("create_cli_connect_session", {
      p_session_id: sessionId,
      p_user_code_hash: cliSecretHash(userCode, "user-code"),
      p_poll_secret_hash: cliSecretHash(pollSecret, "poll-secret"),
      p_credential_hash: cliSecretHash(credential, "ingestion"),
    });
    if (error || !Array.isArray(data) || data.length !== 1) throw new Error("create_failed");
    const row = data[0] as { session_id?: string; expires_at?: string };
    if (row.session_id !== sessionId || typeof row.expires_at !== "string")
      throw new Error("create_failed");
    const url = new URL("/app/cli/connect", getEnvironment().NEXT_PUBLIC_APP_URL);
    url.searchParams.set("code", userCode);
    return privateJson(
      {
        sessionId,
        userCode: `${userCode.slice(0, 5)}-${userCode.slice(5)}`,
        pollSecret,
        verificationUrl: url.toString(),
        expiresAt: row.expires_at,
        intervalSeconds: 3,
      },
      { status: 201 },
    );
  } catch {
    return privateJson({ error: "cli_connect_unavailable" }, { status: 503 });
  }
}
