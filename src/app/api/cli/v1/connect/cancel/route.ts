import { z } from "zod";
import { cliSecretHash } from "@/lib/cli/security";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readBoundedTextBody } from "@/lib/http/bounded-body";

const schema = z
  .object({ sessionId: z.string().uuid(), pollSecret: z.string().min(32).max(100) })
  .strict();

export async function POST(request: Request) {
  try {
    const raw = await readBoundedTextBody(request.body, 2048);
    if (Buffer.byteLength(raw, "utf8") > 2048) throw new Error("invalid");
    const input = schema.parse(JSON.parse(raw));
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("cancel_cli_connect_session", {
      p_session_id: input.sessionId,
      p_poll_secret_hash: cliSecretHash(input.pollSecret, "poll-secret"),
    });
    if (error) throw new Error("cancel_failed");
    return Response.json(
      { cancelled: data === true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      { error: "cancel_unavailable" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
