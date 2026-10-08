import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return privateJson({ error: "authentication_required" }, 401);
  const { data: memberships, error: membershipError } = await auth.client
    .from("workspace_members")
    .select("workspace_id,role")
    .eq("user_id", auth.user.id)
    .in("role", ["owner", "admin"])
    .limit(50);
  if (membershipError) return privateJson({ error: "cli_options_unavailable" }, 503);
  const workspaceIds = (memberships ?? []).map((row) => row.workspace_id);
  if (!workspaceIds.length) return privateJson({ companies: [] });
  const { data: products, error: productsError } = await auth.client
    .from("workspace_products")
    .select("id,workspace_id,name,status")
    .in("workspace_id", workspaceIds)
    .in("status", ["draft", "protected"])
    .order("created_at", { ascending: true })
    .limit(200);
  if (productsError || !products?.length) return privateJson({ companies: [] });
  const productIds = products.map((product) => product.id);
  const { data: progress, error: progressError } = await auth.client
    .from("product_onboarding_progress")
    .select("workspace_id,product_id,company_id")
    .in("product_id", productIds)
    .limit(200);
  if (progressError) return privateJson({ error: "cli_options_unavailable" }, 503);
  const companyIds = [...new Set((progress ?? []).map((row) => row.company_id))];
  const { data: companies, error: companiesError } = companyIds.length
    ? await auth.client
        .from("companies")
        .select("id,workspace_id,name")
        .in("id", companyIds)
        .limit(200)
    : { data: [], error: null };
  if (companiesError) return privateJson({ error: "cli_options_unavailable" }, 503);
  const roleByWorkspace = new Map((memberships ?? []).map((row) => [row.workspace_id, row.role]));
  const productById = new Map((products ?? []).map((product) => [product.id, product]));
  const companyById = new Map((companies ?? []).map((company) => [company.id, company]));
  const result = (progress ?? []).flatMap((binding) => {
    const product = productById.get(binding.product_id);
    const company = companyById.get(binding.company_id);
    if (
      !product ||
      !company ||
      product.workspace_id !== binding.workspace_id ||
      company.workspace_id !== binding.workspace_id
    )
      return [];
    return [
      {
        workspaceId: binding.workspace_id,
        workspaceRole: roleByWorkspace.get(binding.workspace_id),
        company: { id: company.id, name: company.name },
        product: { id: product.id, name: product.name, status: product.status },
      },
    ];
  });
  return privateJson({ companies: result });
}
