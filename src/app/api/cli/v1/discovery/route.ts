import { cliSecretHash } from "@/lib/cli/security";
import { parseCliDiscoveryPayload, payloadDigest } from "@/lib/cli/payload";
import { readBoundedTextBody } from "@/lib/http/bounded-body";
import { claimPublicRateLimit } from "@/lib/public/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MAX_PAYLOAD_BYTES = 512 * 1024;

function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Pragma: "no-cache" },
  });
}

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const credential = authorization?.match(/^Bearer\s+(acli_[A-Za-z0-9_-]{40,80})$/)?.[1];
  if (!credential) return privateJson({ error: "ingestion_credential_required" }, 401);
  const limit = await claimPublicRateLimit(request, "cli_discovery", { allowLocalLoopback: true });
  if (limit.status === "limited") return privateJson({ error: "rate_limited" }, 429);
  if (limit.status === "unavailable") return privateJson({ error: "temporarily_unavailable" }, 503);
  let raw: string;
  let payload: ReturnType<typeof parseCliDiscoveryPayload>;
  try {
    raw = await readBoundedTextBody(request.body, MAX_PAYLOAD_BYTES);
    payload = parseCliDiscoveryPayload(JSON.parse(raw));
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof Error && error.message === "payload_too_large"
            ? "payload_too_large"
            : "invalid_cli_payload",
      },
      400,
    );
  }
  const slugs = [
    ...new Set(
      payload.observations.flatMap((item) =>
        item.providerCandidate.status === "known" ? [item.providerCandidate.providerSlug] : [],
      ),
    ),
  ];
  try {
    const client = createSupabaseServerClient();
    const matches: Array<{ observationId: string; dependencyId: string }> = [];
    if (slugs.length) {
      const { data, error } = await client
        .from("dependency_catalog")
        .select("id,slug")
        .eq("enabled", true)
        .in("slug", slugs)
        .limit(500);
      if (error) return privateJson({ error: "ingestion_temporarily_unavailable" }, 503);
      const bySlug = new Map((data ?? []).map((row) => [row.slug, row.id]));
      for (const item of payload.observations) {
        if (item.providerCandidate.status !== "known") continue;
        const providerId = bySlug.get(item.providerCandidate.providerSlug);
        if (providerId) matches.push({ observationId: item.id, dependencyId: providerId });
      }
    }
    const { data, error } = await client.rpc("ingest_cli_discovery", {
      p_credential_hash: cliSecretHash(credential, "ingestion"),
      p_payload_digest: payloadDigest(raw),
      p_payload: payload,
      p_provider_matches: matches,
    });
    if (error) {
      if (error.message?.includes("cli_scan_id_conflict"))
        return privateJson({ error: "scan_id_conflict" }, 409);
      if (
        error.message?.includes("cli_credential_unavailable") ||
        error.message?.includes("cli_product_unavailable")
      )
        return privateJson({ error: "ingestion_credential_unavailable" }, 401);
      if (error.message?.includes("cli_submission_limit"))
        return privateJson({ error: "submission_limit_reached" }, 409);
      return privateJson({ error: "ingestion_temporarily_unavailable" }, 503);
    }
    const result = (Array.isArray(data) ? data[0] : data) as {
      runId?: string;
      scanId?: string;
      idempotent?: boolean;
      observations?: number;
    } | null;
    if (!result?.runId || !result.scanId || typeof result.idempotent !== "boolean")
      return privateJson({ error: "ingestion_temporarily_unavailable" }, 503);
    return privateJson(
      {
        accepted: true,
        scanId: result.scanId,
        idempotent: result.idempotent,
        observationCount: result.observations ?? 0,
      },
      201,
    );
  } catch {
    return privateJson({ error: "ingestion_temporarily_unavailable" }, 503);
  }
}
