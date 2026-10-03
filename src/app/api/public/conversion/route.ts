import { randomUUID } from "node:crypto";
import { publicClientKey, consumePublicRateLimit } from "@/lib/public/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";

const browserEvents = [
  "homepage_view",
  "stack_scan_started",
  "stack_scan_completed",
  "scan_result_continue",
  "signup_started",
  "github_connect_started",
] as const;
const inputSchema = z
  .object({
    event: z.enum(browserEvents),
    attribution: z
      .object({
        utmSource: z.string().max(100).optional(),
        utmMedium: z.string().max(100).optional(),
        utmCampaign: z.string().max(100).optional(),
        landingPath: z.string().max(160).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function POST(request: Request) {
  const rate = consumePublicRateLimit(`conversion:${publicClientKey(request)}`, {
    limit: 30,
    windowMs: 15 * 60_000,
  });
  if (!rate.allowed)
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSeconds) } },
    );
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2000) return Response.json({ error: "invalid_event" }, { status: 413 });
  let body: unknown = null;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "invalid_event" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2000) {
        await reader.cancel();
        return Response.json({ error: "invalid_event" }, { status: 413 });
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    body = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return Response.json({ error: "invalid_event" }, { status: 400 });
  }
  const input = inputSchema.safeParse(body);
  if (!input.success) return Response.json({ error: "invalid_event" }, { status: 400 });
  const safeAttribution = Object.fromEntries(
    Object.entries(input.data.attribution ?? {}).map(([key, value]) => [
      key,
      value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value) ? value : undefined,
    ]),
  );
  const landingPath = input.data.attribution?.landingPath;
  const validLandingPath =
    landingPath && /^\/[a-zA-Z0-9/_-]{1,160}$/.test(landingPath) ? landingPath : null;
  const client = createSupabaseServerClient();
  const { data: writeAllowed, error: limitError } = await client.rpc(
    "claim_growth_public_conversion_event",
  );
  if (limitError) return Response.json({ error: "event_unavailable" }, { status: 503 });
  if (!writeAllowed) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { error } = await client.from("growth_first_party_events").insert({
    event_id: randomUUID(),
    event_type: input.data.event,
    event_source: "browser",
    utm_source: safeAttribution.utmSource ?? null,
    utm_medium: safeAttribution.utmMedium ?? null,
    utm_campaign: safeAttribution.utmCampaign ?? null,
    landing_path: validLandingPath,
    attribution_confidence: "unknown",
  });
  if (error) return Response.json({ error: "event_unavailable" }, { status: 503 });
  return Response.json({ accepted: true }, { status: 202 });
}
