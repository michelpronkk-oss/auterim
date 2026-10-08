import { z } from "zod";
import { claimPublicRateLimit } from "@/lib/public/rate-limit";
import { cliSecretHash, deriveCliCredential, equalHexDigest } from "@/lib/cli/security";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readBoundedTextBody } from "@/lib/http/bounded-body";

const pollSchema = z
  .object({ sessionId: z.string().uuid(), pollSecret: z.string().min(32).max(100) })
  .strict();

function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Pragma: "no-cache" },
  });
}

export async function POST(request: Request) {
  let input: z.infer<typeof pollSchema>;
  try {
    const raw = await readBoundedTextBody(request.body, 2048);
    if (Buffer.byteLength(raw, "utf8") > 2048)
      return privateJson({ error: "invalid_request" }, 400);
    input = pollSchema.parse(JSON.parse(raw));
  } catch {
    return privateJson({ error: "invalid_request" }, 400);
  }
  const limit = await claimPublicRateLimit(request, "cli_poll", { allowLocalLoopback: true });
  if (limit.status === "limited") return privateJson({ error: "rate_limited" }, 429);
  if (limit.status === "unavailable") return privateJson({ error: "temporarily_unavailable" }, 503);
  try {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("redeem_cli_connect_session", {
      p_session_id: input.sessionId,
      p_poll_secret_hash: cliSecretHash(input.pollSecret, "poll-secret"),
    });
    if (error?.message?.includes("cli_poll_too_frequent"))
      return privateJson({ error: "poll_too_frequent" }, 429);
    if (error || !Array.isArray(data) || data.length !== 1)
      return privateJson({ error: "authorization_unavailable" }, 404);
    const row = data[0] as {
      state: string;
      credential_hash: string | null;
      scope: string;
      expires_at: string | null;
    };
    if (row.state === "pending")
      return privateJson({ status: "pending", intervalSeconds: 3, expiresAt: row.expires_at });
    if (
      row.state === "approved" &&
      row.credential_hash &&
      row.scope === "submit_local_discovery" &&
      row.expires_at
    ) {
      const credential = deriveCliCredential(input.sessionId, input.pollSecret);
      if (!equalHexDigest(row.credential_hash, cliSecretHash(credential, "ingestion")))
        return privateJson({ error: "authorization_unavailable" }, 503);
      return privateJson({
        status: "approved",
        credential,
        scope: row.scope,
        expiresAt: row.expires_at,
      });
    }
    return privateJson({ status: row.state });
  } catch {
    return privateJson({ error: "authorization_unavailable" }, 503);
  }
}
