"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ONBOARDING_V2_STAGES, type OnboardingV2Stage } from "@/lib/onboarding/v2";

type Product = {
  id: string;
  name: string;
  status: string;
  is_default: boolean;
  surfaces?: unknown[];
};
type Candidate = {
  candidateId: string;
  dependencyId: string;
  providerName: string;
  category: string;
  confidenceLabel: string;
  suggestedStatus: string;
  evidenceSummary: Array<{ signalType: string; strength: string; sourceOrigin: string }>;
};
type CatalogDependency = { id: string; slug: string; name: string; category: string };
type LocalDiscoveryObservation = {
  id: string;
  evidenceFamily: string;
  identifier: string;
  identity: string;
  dependencyConfirmationState:
    "confirmed_for_product" | "needs_confirmation" | "unknown_provider_review_only";
  provider: null | { id: string; name: string; slug: string };
  confirmedDependencyId: string | null;
  authoritativeSourcesAvailable: number | null;
  catalogCoverageState: string;
  safeRelativePath: string | null;
};
type LocalCandidateSummary = {
  provider: LocalDiscoveryObservation["provider"];
  identifier: string;
  count: number;
  confirmedDependencyId: string | null;
  sources: number | null;
  families: Set<string>;
};
type ReadModel = {
  company: { name: string; websiteUrl: string | null };
  product: Product;
  progress: {
    stage: OnboardingV2Stage;
    completed_stages: string[];
    milestone_times: Record<string, string>;
  };
  discovery: { status: string | null; candidates: Candidate[] };
  dependencies: Array<{
    workspaceDependencyId: string;
    providerName: string;
    dependencySlug?: string;
    criticality?: "critical" | "important" | "normal";
    productionCritical?: boolean;
    usedFor?: string[];
    contextNote?: string;
  }>;
  protectionGraph: null | {
    product: { id: string; name: string; state: string };
    coverage: {
      confirmedDependencies: number;
      authoritativeSourcesAvailable: number;
      sourcesWithObservedGlobalBaseline: number;
      baselineObservation: string;
    };
    repositories: Array<{
      owner: string;
      name: string;
      status: string;
      mappingState: string;
      verificationCapabilityAvailable: boolean;
    }>;
    localDiscovery?: {
      latestScan: null | {
        status: string;
        receivedAt: string;
        observationCount: number;
      };
      observations: LocalDiscoveryObservation[];
      truncated: boolean;
    };
  };
  repositories: Array<{ id: string; status: string }>;
  recommendations: Array<{ key: string; reason: string; action: string }>;
  notificationPreferences: null | {
    importantChanges: "daily_digest" | "instant" | "off";
    monthlyProtectionReport: boolean;
  };
  cliInsertionPoint: { available: boolean; command: string; stage: string };
};

const stageLabels: Record<OnboardingV2Stage, string> = {
  scan_import: "Scan import",
  company: "Company",
  product: "Product",
  discovery: "Discovery",
  dependency_confirmation: "Dependencies",
  protection_graph: "Protection Graph",
  strengthen_protection: "Strengthen",
  activation: "Activation",
  complete: "Protected",
};

function summarizeLocalCandidates(
  observations: LocalDiscoveryObservation[],
): LocalCandidateSummary[] {
  const grouped = new Map<string, LocalCandidateSummary>();
  for (const observation of observations) {
    const key = observation.provider?.slug ?? `unknown:${observation.identifier}`;
    const current = grouped.get(key) ?? {
      provider: observation.provider,
      identifier: observation.identifier,
      count: 0,
      confirmedDependencyId: observation.confirmedDependencyId,
      sources: observation.authoritativeSourcesAvailable,
      families: new Set<string>(),
    };
    current.count += 1;
    current.confirmedDependencyId ??= observation.confirmedDependencyId;
    current.families.add(observation.evidenceFamily);
    if (observation.authoritativeSourcesAvailable !== null)
      current.sources = Math.max(current.sources ?? 0, observation.authoritativeSourcesAvailable);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .sort((left, right) =>
      (left.provider?.name ?? left.identifier).localeCompare(
        right.provider?.name ?? right.identifier,
      ),
    )
    .slice(0, 20);
}

export function OnboardingV2Panel({
  workspaceId,
  initialProductId,
  api,
  onActivated,
  allowProductCreate = false,
  canManageProducts = false,
}: {
  workspaceId: string;
  initialProductId?: string;
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  onActivated: () => Promise<void>;
  allowProductCreate?: boolean;
  canManageProducts?: boolean;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [model, setModel] = useState<ReadModel | null>(null);
  const [productId, setProductId] = useState(initialProductId ?? "");
  const [newProductName, setNewProductName] = useState("");
  const [manualSlug, setManualSlug] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState<CatalogDependency[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [contexts, setContexts] = useState<
    Record<
      string,
      {
        criticality: "critical" | "important" | "normal";
        productionCritical: boolean;
        usedFor: string[];
        contextNote: string;
      }
    >
  >({});
  const [importantChanges, setImportantChanges] = useState<"daily_digest" | "instant" | "off">(
    "daily_digest",
  );
  const [monthlyReport, setMonthlyReport] = useState(true);
  const loadGeneration = useRef(0);
  const localCandidates = useMemo(
    () => summarizeLocalCandidates(model?.protectionGraph?.localDiscovery?.observations ?? []),
    [model?.protectionGraph?.localDiscovery?.observations],
  );

  const load = useCallback(
    async (requestedProductId?: string) => {
      const generation = ++loadGeneration.current;
      const productResult = (await api(
        `/api/products?workspaceId=${encodeURIComponent(workspaceId)}`,
      )) as { products?: Product[] };
      if (generation !== loadGeneration.current) return;
      const available = (productResult.products ?? []).filter(
        (product) => product.status !== "archived",
      );
      setProducts(available);
      const selected =
        requestedProductId && available.some((product) => product.id === requestedProductId)
          ? requestedProductId
          : (available.find((product) => product.is_default)?.id ?? available[0]?.id ?? "");
      setProductId(selected);
      if (!selected) {
        setModel(null);
        return;
      }
      await api("/api/onboarding/v2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "start", workspaceId, productId: selected }),
      });
      const [result, repositoryGraph, protectionGraph] = await Promise.all([
        api(
          `/api/onboarding/v2?workspaceId=${encodeURIComponent(workspaceId)}&productId=${encodeURIComponent(selected)}`,
        ),
        api(
          `/api/products/${selected}/repositories?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
        api(
          `/api/products/${selected}/protection-graph?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
      ]);
      if (generation !== loadGeneration.current) return;
      const next = result as ReadModel;
      const mapped = (
        repositoryGraph as { mappedRepositories?: Array<{ id: string; status: string }> }
      ).mappedRepositories;
      setModel({
        ...next,
        repositories: Array.isArray(mapped)
          ? mapped.map((item) => ({ id: item.id, status: item.status }))
          : next.repositories,
        protectionGraph: protectionGraph as ReadModel["protectionGraph"],
      });
      setContexts(
        Object.fromEntries(
          next.dependencies.map((dependency) => [
            dependency.workspaceDependencyId,
            {
              criticality: dependency.criticality ?? "normal",
              productionCritical: dependency.productionCritical ?? false,
              usedFor: dependency.usedFor ?? [],
              contextNote: dependency.contextNote ?? "",
            },
          ]),
        ),
      );
      setImportantChanges(next.notificationPreferences?.importantChanges ?? "daily_digest");
      setMonthlyReport(next.notificationPreferences?.monthlyProtectionReport ?? true);
    },
    [api, workspaceId],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => load(initialProductId))
      .catch(() => {
        if (!cancelled)
          setError("Product protection state is unavailable. Your saved progress is preserved.");
      });
    return () => {
      cancelled = true;
    };
  }, [initialProductId, load]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replaceAll("_", " ")
          : "The operation could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function selectProduct(nextId: string) {
    setProductId(nextId);
    await load(nextId);
  }

  async function createProduct() {
    const name = newProductName.trim();
    if (!name) return;
    await run(async () => {
      const key = `onboarding-v2:${workspaceId}:${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 80)}`;
      const created = (await api("/api/products", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ workspaceId, name, surfaces: [] }),
      })) as { product?: { id: string } };
      const id = created.product?.id ?? (created as unknown as { id?: string }).id;
      if (!id) throw new Error("product_creation_unavailable");
      setNewProductName("");
      await load(id);
    });
  }

  async function transition(targetStage: OnboardingV2Stage) {
    await run(async () => {
      await api("/api/onboarding/v2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "transition", workspaceId, productId, targetStage }),
      });
      await load(productId);
    });
  }

  async function decide(candidateId: string, decision: "confirmed" | "rejected") {
    await run(async () => {
      await api(`/api/products/${productId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "decision", workspaceId, candidateId, decision }),
      });
      await load(productId);
    });
  }

  async function addManual() {
    const dependencySlug = manualSlug.trim().toLowerCase();
    if (!dependencySlug) return;
    await run(async () => {
      await api(`/api/products/${productId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "manual_add", workspaceId, dependencySlug }),
      });
      setManualSlug("");
      await load(productId);
    });
  }

  async function searchCatalog() {
    await run(async () => {
      const result = (await api(
        `/api/onboarding/dependencies?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(catalogQuery)}`,
      )) as { dependencies?: CatalogDependency[] };
      setCatalogResults((result.dependencies ?? []).slice(0, 25));
    });
  }

  async function addCatalogDependency(dependencySlug: string) {
    await run(async () => {
      await api(`/api/products/${productId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "manual_add", workspaceId, dependencySlug }),
      });
      setCatalogResults([]);
      setCatalogQuery("");
      await load(productId);
    });
  }

  async function confirmLocalProvider(dependencySlug: string) {
    await run(async () => {
      await api(`/api/products/${productId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "manual_add", workspaceId, dependencySlug }),
      });
      await load(productId);
    });
  }

  async function saveContext(dependencyId: string) {
    const context = contexts[dependencyId];
    if (!context) return;
    await run(async () => {
      await api(`/api/onboarding/dependencies/${dependencyId}/context`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, ...context }),
      });
      await load(productId);
    });
  }

  async function savePreferences() {
    await run(async () => {
      await api("/api/onboarding/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          importantChanges,
          informational: "off",
          monthlyProtectionReport: monthlyReport,
        }),
      });
      await load(productId);
    });
  }

  async function activate() {
    await run(async () => {
      if (model?.product.is_default) {
        await api("/api/onboarding/steps", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, step: "dependencies_review" }),
        });
        await api("/api/onboarding/steps", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, step: "context_setup" }),
        });
        await api("/api/onboarding/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            importantChanges,
            informational: "off",
            monthlyProtectionReport: monthlyReport,
          }),
        });
        await api("/api/onboarding/steps", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, step: "notifications_setup" }),
        });
      }
      await api("/api/onboarding/v2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "activate", workspaceId, productId }),
      });
      await onActivated();
      await load(productId);
    });
  }

  const stepIndex = useMemo(
    () => Math.max(0, ONBOARDING_V2_STAGES.indexOf(model?.progress.stage ?? "scan_import")),
    [model?.progress.stage],
  );
  const unresolved =
    model?.discovery.candidates.filter((candidate) => candidate.suggestedStatus === "candidate") ??
    [];
  const nextStage = ONBOARDING_V2_STAGES[Math.min(stepIndex + 1, ONBOARDING_V2_STAGES.length - 1)]!;
  const discoverySettled = !model?.discovery.status || model.discovery.status !== "running";

  return (
    <section className="onboarding-card onboarding-v2" aria-label="Product onboarding">
      <p className="card-kicker">PRODUCT PROTECTION</p>
      {model ? (
        <>
          <h2>
            {model.product.status === "protected"
              ? "Auterim is watching this Product."
              : "Choose what Auterim will protect."}
          </h2>
          <p>
            {model.company.name}
            {model.company.websiteUrl ? ` · ${model.company.websiteUrl}` : ""}
          </p>
          <label>
            Protected Product
            <select
              value={productId}
              onChange={(event) => void run(() => selectProduct(event.target.value))}
              disabled={busy}
            >
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.is_default ? " · default" : ""} · {product.status}
                </option>
              ))}
            </select>
          </label>
          <div className="onboarding-progress" aria-label="Product setup progress">
            {ONBOARDING_V2_STAGES.map((stage, index) => (
              <div
                key={stage}
                className={`onboarding-step${stage === model.progress.stage ? " is-current" : index < stepIndex ? " is-complete" : ""}`}
              >
                <span>{index < stepIndex ? "✓" : index + 1}</span>
                {stageLabels[stage]}
              </div>
            ))}
          </div>
          <p className="account-step-note">
            Saved on the server. Resume at <strong>{stageLabels[model.progress.stage]}</strong>{" "}
            after sign-in or refresh.
          </p>
          {((model.progress.stage === "product" && canManageProducts) || allowProductCreate) && (
            <div className="onboarding-fields">
              <label>
                {model.progress.stage === "product"
                  ? "New Product name"
                  : "Protect another Product"}
                <input
                  maxLength={160}
                  value={newProductName}
                  onChange={(event) => setNewProductName(event.target.value)}
                  placeholder="Customer portal"
                />
              </label>
              <button
                type="button"
                onClick={() => void createProduct()}
                disabled={busy || !newProductName.trim()}
              >
                Create Product
              </button>
            </div>
          )}
          {(model.progress.stage === "discovery" ||
            model.progress.stage === "dependency_confirmation") && (
            <section>
              <h3>Public discovery suggestions</h3>
              {model.discovery.status === "running" && (
                <p role="status">Discovery is still running. You can leave and resume later.</p>
              )}
              {unresolved.length === 0 && model.discovery.status !== "running" && (
                <p>
                  No unreviewed provider suggestions. Public observations remain separate from
                  confirmed Product dependencies.
                </p>
              )}
              {unresolved.map((candidate) => (
                <article key={candidate.candidateId} className="onboarding-candidate">
                  <div>
                    <h4>{candidate.providerName}</h4>
                    <p>
                      {candidate.category} · {candidate.confidenceLabel} confidence
                    </p>
                    <p>
                      {candidate.evidenceSummary
                        .slice(0, 2)
                        .map(
                          (item) =>
                            `${item.strength} ${item.signalType.replaceAll("_", " ")} at ${item.sourceOrigin}`,
                        )
                        .join(" · ") || "No public evidence summary"}
                    </p>
                  </div>
                  <div className="onboarding-candidate-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(candidate.candidateId, "confirmed")}
                    >
                      Confirm for this Product
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(candidate.candidateId, "rejected")}
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}
              <label>
                Search the dependency catalog
                <input
                  value={catalogQuery}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  maxLength={80}
                  placeholder="OpenAI, Stripe, Supabase…"
                />
              </label>
              <button
                type="button"
                disabled={busy || !catalogQuery.trim()}
                onClick={() => void searchCatalog()}
              >
                Search providers
              </button>
              {catalogResults.map((dependency) => (
                <div key={dependency.id}>
                  <span>
                    {dependency.name} · {dependency.category}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addCatalogDependency(dependency.slug)}
                  >
                    Add to this Product
                  </button>
                </div>
              ))}
              <details>
                <summary>Have a catalog slug?</summary>
                <label>
                  Known dependency slug
                  <input
                    value={manualSlug}
                    onChange={(event) => setManualSlug(event.target.value)}
                    maxLength={80}
                    placeholder="provider-slug"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !manualSlug.trim()}
                  onClick={() => void addManual()}
                >
                  Add known dependency
                </button>
              </details>
            </section>
          )}
          {model.progress.stage === "protection_graph" ||
          model.progress.stage === "strengthen_protection" ||
          model.progress.stage === "activation" ||
          model.product.status === "protected" ||
          Boolean(model.protectionGraph?.localDiscovery?.latestScan) ? (
            <>
              <h3>First Protection Graph</h3>
              {model.protectionGraph ? (
                <div className="account-summary">
                  <div>
                    <span className="summary-label">Confirmed dependencies</span>
                    <strong>{model.protectionGraph.coverage.confirmedDependencies}</strong>
                  </div>
                  <div>
                    <span className="summary-label">Authoritative sources</span>
                    <strong>{model.protectionGraph.coverage.authoritativeSourcesAvailable}</strong>
                  </div>
                  <div>
                    <span className="summary-label">Sources with a recorded shared snapshot</span>
                    <strong>
                      {model.protectionGraph.coverage.sourcesWithObservedGlobalBaseline}
                    </strong>
                  </div>
                  <div>
                    <span className="summary-label">Product repositories</span>
                    <strong>{model.protectionGraph.repositories.length}</strong>
                  </div>
                </div>
              ) : (
                <p>Graph data is not available yet.</p>
              )}
              {model.protectionGraph?.localDiscovery?.observations.length ? (
                <section aria-label="Locally detected dependencies">
                  <h4>Detected locally</h4>
                  <p>
                    Local observations are suggestions. They do not confirm a dependency or enable
                    monitoring until you add a known provider to this Product.
                  </p>
                  {localCandidates.map((candidate) => (
                    <div
                      className="onboarding-fields"
                      key={candidate.provider?.slug ?? candidate.identifier}
                    >
                      <strong>{candidate.provider?.name ?? candidate.identifier}</strong>
                      <span>Detected locally · {candidate.count} local signals</span>
                      <span>
                        Evidence:{" "}
                        {[...candidate.families]
                          .map((family) => family.replaceAll("_", " "))
                          .join(", ")}
                        {candidate.provider
                          ? candidate.sources && candidate.sources > 0
                            ? ` · Monitoring sources available: ${candidate.sources}`
                            : " · Monitoring coverage not available yet"
                          : " · Provider is not in the catalog; review only"}
                      </span>
                      {candidate.provider ? (
                        candidate.confirmedDependencyId ? (
                          <span>Confirmed dependency for this Product</span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void confirmLocalProvider(candidate.provider!.slug)}
                          >
                            Confirm dependency
                          </button>
                        )
                      ) : (
                        <span>Review when this provider is available in the catalog</span>
                      )}
                    </div>
                  ))}
                  {model.protectionGraph.localDiscovery.truncated ? (
                    <p>Additional local observations are omitted from this bounded view.</p>
                  ) : null}
                </section>
              ) : null}
              <p>
                Baseline:{" "}
                {model.protectionGraph?.coverage.baselineObservation.replaceAll("_", " ") ??
                  "not observed"}
                . A recorded snapshot is shared source history, not a freshness or health check.
                Repository verification is shown only when an entitled capability and repository
                evidence exist.
              </p>
              {model.recommendations.map((recommendation) => (
                <p key={recommendation.key}>
                  <strong>Next:</strong> {recommendation.reason}
                  {recommendation.action === "connect_github"
                    ? " Connect GitHub from Settings when ready."
                    : ""}
                </p>
              ))}
              <ul>
                {model.dependencies.map((dependency) => (
                  <li key={dependency.workspaceDependencyId}>
                    {dependency.providerName} · confirmed for this Product
                  </li>
                ))}
              </ul>
              <h3>Optional dependency context</h3>
              {model.dependencies.map((dependency) => {
                const context = contexts[dependency.workspaceDependencyId];
                if (!context) return null;
                return (
                  <div
                    className="onboarding-fields"
                    key={`context-${dependency.workspaceDependencyId}`}
                  >
                    <strong>{dependency.providerName}</strong>
                    <label>
                      Criticality
                      <select
                        value={context.criticality}
                        onChange={(event) =>
                          setContexts((current) => ({
                            ...current,
                            [dependency.workspaceDependencyId]: {
                              ...context,
                              criticality: event.target.value as typeof context.criticality,
                            },
                          }))
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="important">Important</option>
                        <option value="critical">Critical</option>
                      </select>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={context.productionCritical}
                        onChange={(event) =>
                          setContexts((current) => ({
                            ...current,
                            [dependency.workspaceDependencyId]: {
                              ...context,
                              productionCritical: event.target.checked,
                            },
                          }))
                        }
                      />{" "}
                      Production critical
                    </label>
                    <label>
                      Used for (comma separated)
                      <input
                        maxLength={500}
                        value={context.usedFor.join(", ")}
                        onChange={(event) =>
                          setContexts((current) => ({
                            ...current,
                            [dependency.workspaceDependencyId]: {
                              ...context,
                              usedFor: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean)
                                .slice(0, 20),
                            },
                          }))
                        }
                        placeholder="billing, customer-facing product"
                      />
                    </label>
                    <label>
                      Usage note
                      <input
                        maxLength={500}
                        value={context.contextNote}
                        onChange={(event) =>
                          setContexts((current) => ({
                            ...current,
                            [dependency.workspaceDependencyId]: {
                              ...context,
                              contextNote: event.target.value,
                            },
                          }))
                        }
                        placeholder="Optional: how this provider is used"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveContext(dependency.workspaceDependencyId)}
                    >
                      Save context
                    </button>
                  </div>
                );
              })}
              <h3>Notification preferences</h3>
              <label>
                Important changes
                <select
                  value={importantChanges}
                  onChange={(event) =>
                    setImportantChanges(event.target.value as typeof importantChanges)
                  }
                >
                  <option value="daily_digest">Daily digest</option>
                  <option value="instant">Instant</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={monthlyReport}
                  onChange={(event) => setMonthlyReport(event.target.checked)}
                />{" "}
                Monthly protection report
              </label>
              <button type="button" disabled={busy} onClick={() => void savePreferences()}>
                Save preferences
              </button>
            </>
          ) : null}
          <div className="onboarding-activation">
            {model.progress.stage === "activation" ? (
              <button
                type="button"
                disabled={
                  busy ||
                  model.dependencies.length === 0 ||
                  unresolved.length > 0 ||
                  !discoverySettled
                }
                onClick={() => void activate()}
              >
                {busy ? "Activating…" : "Activate Product protection"} →
              </button>
            ) : (
              model.progress.stage !== "complete" && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    (nextStage === "dependency_confirmation" && !discoverySettled) ||
                    (model.progress.stage === "dependency_confirmation" && unresolved.length > 0)
                  }
                  onClick={() => void transition(nextStage)}
                >
                  {busy ? "Saving…" : `Continue to ${stageLabels[nextStage]}`} →
                </button>
              )
            )}
            {model.progress.stage === "complete" && (
              <p role="status">
                Protection is active. The five-day Pro trial starts once when the workspace&apos;s
                first Product goes live.
              </p>
            )}
          </div>
          <p className="account-step-note">
            Future CLI discovery enters at <code>{model.cliInsertionPoint.command}</code> during{" "}
            {stageLabels[model.cliInsertionPoint.stage as OnboardingV2Stage]}; CLI is optional and
            not required to activate.
          </p>
        </>
      ) : (
        <p role="status">Loading Product protection state…</p>
      )}
      {error && (
        <p className="onboarding-inline-error" role="alert">
          {error.replaceAll("_", " ")}
        </p>
      )}
    </section>
  );
}
