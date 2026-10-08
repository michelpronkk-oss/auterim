import { z } from "zod";
import { getWorkspaceRole } from "@/lib/billing/server";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";

const surfaceSchema = z
  .object({
    surfaceType: z.enum(["website", "app", "docs", "api", "status", "other"]),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value) && !/^https?:\/\/[^/@]+@/i.test(value)),
  })
  .strict();

const createSchema = z
  .object({
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    surfaces: z.array(surfaceSchema).max(25).default([]),
    replaceProductId: z.string().uuid().optional(),
  })
  .strict();

function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

function createError(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  if (message.includes("product_quota_exceeded"))
    return Response.json({ error: "product_quota_exceeded" }, { status: 409 });
  if (message.includes("paid_plan_required"))
    return Response.json({ error: "paid_plan_required" }, { status: 402 });
  if (message.includes("product_not_found") || error.code === "P0002")
    return Response.json({ error: "product_not_found" }, { status: 404 });
  if (message.includes("invalid_product") || message.includes("invalid_product_surface"))
    return Response.json({ error: "invalid_product_input" }, { status: 400 });
  if (error.code === "42501") return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({ error: "products_unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!workspaceId.success) return privateJson({ error: "invalid_workspace_id" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id).catch(
    () => null,
  );
  if (!role) return privateJson({ error: "forbidden" }, { status: 403 });

  const [{ data: products, error: productsError }, { data: surfaces, error: surfacesError }] =
    await Promise.all([
      auth.client
        .from("workspace_products")
        .select("id,workspace_id,name,slug,status,is_default,protected_at,archived_at,created_at")
        .eq("workspace_id", workspaceId.data)
        .order("created_at", { ascending: true }),
      auth.client
        .from("workspace_product_surfaces")
        .select("id,product_id,surface_type,url,created_at")
        .eq("workspace_id", workspaceId.data)
        .order("created_at", { ascending: true }),
    ]);
  if (productsError || surfacesError)
    return privateJson({ error: "products_unavailable" }, { status: 503 });
  return privateJson({
    products: (products ?? []).map((product) => ({
      ...product,
      surfaces: (surfaces ?? []).filter((surface) => surface.product_id === product.id),
    })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await parseJsonBody(request));
  } catch {
    return privateJson({ error: "invalid_product_input" }, { status: 400 });
  }
  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return privateJson({ error: "owner_or_admin_required" }, { status: 403 });

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128)
    return privateJson({ error: "idempotency_key_required" }, { status: 400 });

  const { data, error } = await auth.client.rpc("create_workspace_product_idempotent", {
    p_workspace_id: input.workspaceId,
    p_name: input.name,
    p_surfaces: input.surfaces,
    p_replace_product_id: input.replaceProductId ?? null,
    p_idempotency_key: idempotencyKey,
  });
  if (error) {
    if (error.message?.includes("product_idempotency_key_reused"))
      return privateJson({ error: "idempotency_key_reused" }, { status: 409 });
    if (error.message?.includes("invalid_product_idempotency_key"))
      return privateJson({ error: "idempotency_key_required" }, { status: 400 });
    return createError(error);
  }
  return privateJson(data, { status: 201 });
}
