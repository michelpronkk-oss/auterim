import "server-only";
import { getDomain } from "tldts";
import { performance } from "node:perf_hooks";
import { fetchHttpSource, SafeFetchError } from "@/lib/monitoring/fetcher";
import {
  discoverWebsiteDependencies,
  discoveryLimits,
  evidenceFamily,
  makeCandidates,
  normalizePublicWebsiteUrl,
  type DiscoveryEvidence,
  type DiscoverySurfaceType,
  type UrlDiscoveryResult,
} from "@/lib/discovery/discovery";
import {
  fuseTechnologyObservations,
  type TechnologyObservation,
} from "@/lib/discovery/technology-registry";

export const companyDiscoveryLimits = {
  maxObservedSurfaceLinks: 64,
  maxStoredSurfaces: 24,
  maxExtraSurfaces: 2,
  maxTotalStaticBytes: 8 * 1024 * 1024,
  maxTotalWireBytes: 16 * 1024 * 1024,
  maxSafeFetchCalls: 48,
  maxTotalDurationMs: 18_000,
  maxTotalRuntimeDurationMs: 8_000,
  maxTotalRuntimeRequests: 60,
  maxTotalRuntimeHosts: 20,
  maxTotalRuntimeResponseBytes: 5 * 1024 * 1024,
  maxTotalRuntimeWireBytes: 8 * 1024 * 1024,
} as const;

type SurfaceChoice = {
  url: string;
  host: string;
  type: DiscoverySurfaceType;
  rank: number;
  association: "root_link";
};

type SurfaceCoverage = NonNullable<UrlDiscoveryResult["companyCoverage"]>["surfaces"][number];

function hostTokens(host: string) {
  return host.toLowerCase().replace(/\.$/, "").split(".").slice(0, -1);
}

const excludedToken =
  /^(docs?|documentation|blog|news|status|support|help|careers?|community|api|cdn|static|assets?|integrations?|market|marketplace|plugins?|ecosystem|customers?|case|studies|stories)$/;
const highValueToken = /^(app|product|dashboard|portal|console|workspace)$/;

function classifyLinkedSurface(url: URL, labelKind: "app_cta" | "auth_cta" | "other") {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const tokens = [
    ...hostTokens(host),
    ...url.pathname
      .toLowerCase()
      .split(/[/.\-_]+/)
      .filter(Boolean),
  ];
  if (tokens.some((token) => token === "docs" || token === "doc" || token === "documentation"))
    return { type: "DOCS" as const, rank: 0 };
  if (tokens.some((token) => token === "blog" || token === "news"))
    return { type: "BLOG" as const, rank: 0 };
  if (tokens.some((token) => token === "status")) return { type: "STATUS" as const, rank: 0 };
  if (tokens.some((token) => token === "support" || token === "help"))
    return { type: "SUPPORT" as const, rank: 0 };
  if (tokens.some((token) => token === "integration" || token === "integrations"))
    return { type: "INTEGRATION_DIRECTORY" as const, rank: 0 };
  if (
    tokens.some((token) =>
      /^(market|marketplace|plugins?|ecosystem|case|studies|stories)$/.test(token),
    )
  )
    return { type: "INTEGRATION_DIRECTORY" as const, rank: 0 };
  if (tokens.some((token) => token === "api")) return { type: "FIRST_PARTY_API" as const, rank: 0 };
  if (tokens.some((token) => token === "portal"))
    return { type: "CUSTOMER_PORTAL" as const, rank: 90 };
  if (tokens.some((token) => excludedToken.test(token)))
    return { type: "UNKNOWN" as const, rank: 0 };
  if (tokens.some((token) => token === "auth" || token === "login" || token === "signin")) {
    return labelKind === "auth_cta" ? { type: "AUTH_APP" as const, rank: 80 } : null;
  }
  if (tokens.some((token) => token === "dashboard"))
    return { type: "DASHBOARD" as const, rank: 100 };
  if (tokens.some((token) => highValueToken.test(token)) || labelKind === "app_cta")
    return { type: "PRODUCT_APP" as const, rank: labelKind === "app_cta" ? 95 : 85 };
  return null;
}

function associatedSurfaceChoices(
  rootUrl: string,
  links: NonNullable<UrlDiscoveryResult["surfaceLinks"]>,
): SurfaceChoice[] {
  const root = new URL(rootUrl);
  const registrable = getDomain(root.hostname, { allowPrivateDomains: true });
  if (!registrable) return [];
  const choices = new Map<string, SurfaceChoice>();
  for (const link of links.slice(0, companyDiscoveryLimits.maxObservedSurfaceLinks)) {
    try {
      const linked = new URL(link.url);
      if (
        linked.protocol !== "https:" ||
        linked.username ||
        linked.password ||
        (linked.port && linked.port !== "443") ||
        getDomain(linked.hostname, { allowPrivateDomains: true }) !== registrable
      )
        continue;
      const classification = classifyLinkedSurface(linked, link.labelKind);
      if (!classification) continue;
      // Scan only the linked first-party origin root; paths and query values may encode customer data.
      const url = `${linked.origin}/`;
      const host = linked.hostname.toLowerCase().replace(/\.$/, "");
      const isRootHost =
        host.replace(/^www\./, "") ===
        root.hostname
          .toLowerCase()
          .replace(/^www\./, "")
          .replace(/\.$/, "");
      if (isRootHost) continue;
      const choiceKey = url;
      const prior = choices.get(choiceKey);
      if (
        !prior ||
        classification.rank > prior.rank ||
        (classification.rank === prior.rank && classification.type < prior.type)
      ) {
        choices.set(choiceKey, {
          url,
          host,
          type: classification.type,
          rank: classification.rank,
          association: "root_link",
        });
      }
    } catch {
      // Invalid or non-HTTP links are not surface associations.
    }
  }
  return [...choices.values()].sort(
    (left, right) => right.rank - left.rank || left.host.localeCompare(right.host),
  );
}

function createCompanyFetchBudget(fetcher: typeof fetchHttpSource, deadlineAt: number) {
  let staticBytes = 0;
  let staticWireBytes = 0;
  let runtimeBytes = 0;
  let runtimeWireBytes = 0;
  let calls = 0;
  let reservedResponse = 0;
  let reservedWire = 0;
  const budgetedFetcher = (runtime: boolean) =>
    (async (url, validators, dependencies) => {
      const bytes = staticBytes + runtimeBytes;
      const wireBytes = staticWireBytes + runtimeWireBytes;
      if (performance.now() >= deadlineAt || calls >= companyDiscoveryLimits.maxSafeFetchCalls) {
        throw new SafeFetchError("company_budget_exhausted", "The company discovery budget ended.");
      }
      const remaining = companyDiscoveryLimits.maxTotalStaticBytes - bytes - reservedResponse;
      const remainingWire = companyDiscoveryLimits.maxTotalWireBytes - wireBytes - reservedWire;
      if (remaining <= 0 || remainingWire <= 0)
        throw new SafeFetchError("company_budget_exhausted", "The company byte budget ended.");
      const requestedResponse = dependencies?.maxResponseBytes ?? discoveryLimits.maxHtmlBytes;
      const maxResponseBytes = Math.max(1, Math.min(requestedResponse, remaining));
      const requestedWire = dependencies?.maxWireBytes ?? Math.max(maxResponseBytes * 2, 64 * 1024);
      const maxWireBytes = Math.max(1, Math.min(requestedWire, remainingWire));
      calls += 1;
      reservedResponse += maxResponseBytes;
      reservedWire += maxWireBytes;
      try {
        const result = await fetcher(url, validators, {
          ...dependencies,
          maxResponseBytes,
          maxWireBytes,
          deadlineAt: Math.min(dependencies?.deadlineAt ?? deadlineAt, deadlineAt),
        });
        if (
          result.bytesRead > maxResponseBytes ||
          (result.wireBytesRead ?? result.bytesRead) > maxWireBytes
        ) {
          throw new SafeFetchError(
            "company_budget_exhausted",
            "The company fetch exceeded its shared byte budget.",
            null,
            result.wireBytesRead ?? maxWireBytes,
          );
        }
        reservedResponse -= maxResponseBytes;
        reservedWire -= maxWireBytes;
        if (runtime) runtimeBytes += result.bytesRead;
        else staticBytes += result.bytesRead;
        if (runtime) runtimeWireBytes += result.wireBytesRead ?? result.bytesRead;
        else staticWireBytes += result.wireBytesRead ?? result.bytesRead;
        return result;
      } catch (error) {
        reservedResponse -= maxResponseBytes;
        reservedWire -= maxWireBytes;
        if (runtime) runtimeBytes += maxResponseBytes;
        else staticBytes += maxResponseBytes;
        const failedWireBytes = Math.min(
          maxWireBytes,
          error instanceof SafeFetchError ? (error.wireBytesRead ?? maxWireBytes) : maxWireBytes,
        );
        if (runtime) runtimeWireBytes += failedWireBytes;
        else staticWireBytes += failedWireBytes;
        throw error;
      }
    }) as typeof fetchHttpSource;
  return {
    get staticBytes() {
      return staticBytes;
    },
    get staticWireBytes() {
      return staticWireBytes;
    },
    get runtimeBytes() {
      return runtimeBytes;
    },
    get runtimeWireBytes() {
      return runtimeWireBytes;
    },
    get calls() {
      return calls;
    },
    fetcher: budgetedFetcher(false),
    runtimeFetcher: budgetedFetcher(true),
  };
}

function fuseEvidence(evidence: DiscoveryEvidence[]) {
  const eligible = evidence.filter((item) => {
    if (item.surfaceType !== "ROOT_MARKETING") return true;
    return evidenceFamily(item.signalType) === "hosting_infrastructure";
  });
  return eligible;
}

function evidenceSourceHost(item: DiscoveryEvidence) {
  try {
    return new URL(item.sourceOrigin).hostname.toLowerCase();
  } catch {
    return "unknown.invalid";
  }
}

function evidenceSourceOrigin(item: DiscoveryEvidence) {
  try {
    return new URL(item.sourceOrigin).origin;
  } catch {
    return "https://unknown.invalid";
  }
}

function buildSuppression(
  evidence: DiscoveryEvidence[],
  suggested: Set<string>,
  eligible: DiscoveryEvidence[],
) {
  const byProvider = new Map<string, DiscoveryEvidence[]>();
  for (const item of evidence)
    byProvider.set(item.providerSlug, [...(byProvider.get(item.providerSlug) ?? []), item]);
  const eligibleKeys = new Set(
    eligible.map(
      (item) =>
        `${item.surfaceType}:${item.surfaceHost}:${item.providerSlug}:${item.signatureKey}:${item.sourceOrigin}`,
    ),
  );
  const suppressionReasonCounts: Record<string, number> = {};
  const suppressed: Array<{
    providerSlug: string;
    surfaceType: DiscoverySurfaceType;
    surfaceHost: string;
    sourceHost: string;
    sourceOrigin: string;
    signatureKey: string;
    evidenceFamily: string;
    reason: string;
  }> = [];
  for (const [providerSlug, items] of byProvider) {
    const rootOnlyEvidence = items.filter(
      (item) =>
        !eligibleKeys.has(
          `${item.surfaceType}:${item.surfaceHost}:${item.providerSlug}:${item.signatureKey}:${item.sourceOrigin}`,
        ),
    );
    for (const item of rootOnlyEvidence) {
      suppressed.push({
        providerSlug,
        surfaceType: item.surfaceType,
        surfaceHost: item.surfaceHost,
        sourceHost: evidenceSourceHost(item),
        sourceOrigin: evidenceSourceOrigin(item),
        signatureKey: item.signatureKey,
        evidenceFamily: evidenceFamily(item.signalType),
        reason: "marketing_only",
      });
    }
    const usable = items.filter((item) =>
      eligibleKeys.has(
        `${item.surfaceType}:${item.surfaceHost}:${item.providerSlug}:${item.signatureKey}:${item.sourceOrigin}`,
      ),
    );
    if (!suggested.has(providerSlug)) {
      const reason = usable.every((item) => item.strength === "weak")
        ? "weak_evidence"
        : "below_suggestion_threshold";
      for (const item of usable)
        suppressed.push({
          providerSlug,
          surfaceType: item.surfaceType,
          surfaceHost: item.surfaceHost,
          sourceHost: evidenceSourceHost(item),
          sourceOrigin: evidenceSourceOrigin(item),
          signatureKey: item.signatureKey,
          evidenceFamily: evidenceFamily(item.signalType),
          reason,
        });
    } else {
      const byFamily = new Map<string, DiscoveryEvidence[]>();
      for (const item of usable)
        byFamily.set(evidenceFamily(item.signalType), [
          ...(byFamily.get(evidenceFamily(item.signalType)) ?? []),
          item,
        ]);
      for (const [family, repeated] of byFamily) {
        for (const item of repeated.slice(1))
          suppressed.push({
            providerSlug,
            surfaceType: item.surfaceType,
            surfaceHost: item.surfaceHost,
            sourceHost: evidenceSourceHost(item),
            sourceOrigin: evidenceSourceOrigin(item),
            signatureKey: item.signatureKey,
            evidenceFamily: family,
            reason: "correlated_evidence",
          });
      }
    }
  }
  const deduplicated = [
    ...new Map(
      suppressed.map((item) => [
        `${item.providerSlug}:${item.surfaceType}:${item.surfaceHost}:${item.sourceOrigin}:${item.signatureKey}:${item.evidenceFamily}:${item.reason}`,
        item,
      ]),
    ).values(),
  ];
  for (const item of deduplicated)
    suppressionReasonCounts[item.reason] = (suppressionReasonCounts[item.reason] ?? 0) + 1;
  return { suppressed: deduplicated.slice(0, 100), suppressionReasonCounts };
}

export async function discoverCompanySurfaceDependencies(
  rawUrl: string,
  options: Parameters<typeof discoverWebsiteDependencies>[1] = {},
): Promise<UrlDiscoveryResult> {
  const startedAt = performance.now();
  const normalizedUrl = normalizePublicWebsiteUrl(rawUrl);
  const companyDeadlineAt = startedAt + companyDiscoveryLimits.maxTotalDurationMs;
  const runtimeDeadlineAt = startedAt + companyDiscoveryLimits.maxTotalRuntimeDurationMs;
  const runtimeBudget = {
    deadlineAt: null,
    requests: 0,
    hosts: new Set<string>(),
    responseBytes: 0,
    wireBytes: 0,
    reservedResponseBytes: 0,
    reservedWireBytes: 0,
    maxRequests: companyDiscoveryLimits.maxTotalRuntimeRequests,
    maxHosts: companyDiscoveryLimits.maxTotalRuntimeHosts,
    maxResponseBytes: companyDiscoveryLimits.maxTotalRuntimeResponseBytes,
    maxWireBytes: companyDiscoveryLimits.maxTotalRuntimeWireBytes,
  };
  const baseFetcher = options.fetcher ?? fetchHttpSource;
  const budget = createCompanyFetchBudget(baseFetcher, companyDeadlineAt);
  const scan = async (url: string, type: DiscoverySurfaceType) =>
    discoverWebsiteDependencies(url, {
      ...options,
      fetcher: budget.fetcher,
      runtimeFetcher: budget.runtimeFetcher,
      surfaceType: type,
      globalDeadlineAt: companyDeadlineAt,
      runtimeDeadlineAt,
      runtimeBudget,
    });
  const root = await scan(normalizedUrl, "ROOT_MARKETING");
  if (root.status === "failed") {
    return {
      ...root,
      surfaceLinks: [],
      companyCoverage: {
        surfacesObserved: 1,
        surfacesClassified: 1,
        surfacesSelected: 1,
        surfacesScanned: 0,
        surfaces: [
          {
            host: new URL(normalizedUrl).hostname.toLowerCase().replace(/\.$/, ""),
            type: "ROOT_MARKETING",
            association: "submitted_url",
            selected: true,
            selectionReason: "root_surface",
            status: "failed",
            staticBytes: 0,
            staticDurationMs: root.coverage.staticCoverage.durationMs,
            scriptBytes: 0,
            runtimeDurationMs: 0,
            runtimeRequests: 0,
          },
        ],
        providersObserved: 0,
        providersSuggested: 0,
        providersSuppressed: 0,
        technologyObservations: [],
        technologyObservationsTotal: 0,
        technologiesObserved: 0,
        technologiesRecognized: 0,
        externalProvidersRecognized: 0,
        technologiesStrong: 0,
        technologiesMedium: 0,
        technologiesWeak: 0,
        protectableTechnologies: 0,
        protectableTechnologiesSuggested: 0,
        technologySuppressionReasonCounts: {},
        suppressionReasonCounts: {},
        suppressedObservations: [],
        totalDurationMs: Math.ceil(performance.now() - startedAt),
        totalStaticBytes: budget.staticBytes,
        totalStaticWireBytes: budget.staticWireBytes,
        totalScriptBytes: 0,
        totalRuntimeBytes: budget.runtimeBytes,
        totalRuntimeWireBytes: budget.runtimeWireBytes,
        totalRuntimeDurationMs: 0,
        totalRuntimeRequests: 0,
        totalRuntimeHosts: 0,
      },
    };
  }
  const choices = associatedSurfaceChoices(normalizedUrl, root.surfaceLinks ?? []);
  const selected = choices
    .filter((item) => item.rank > 0)
    .slice(0, companyDiscoveryLimits.maxExtraSurfaces);
  const surfaces: SurfaceCoverage[] = [
    {
      host: new URL(normalizedUrl).hostname,
      type: "ROOT_MARKETING",
      association: "submitted_url",
      selected: true,
      selectionReason: "root_surface",
      status: "scanned",
    },
    ...choices
      .slice(0, companyDiscoveryLimits.maxStoredSurfaces - 1)
      .map((item): SurfaceCoverage => ({
        host: item.host,
        type: item.type,
        association: item.association,
        selected: selected.includes(item),
        selectionReason: selected.includes(item)
          ? "high_discovery_value"
          : item.type === "INTEGRATION_DIRECTORY"
            ? "integration_directory_excluded"
            : item.rank === 0
              ? "low_value_or_excluded"
              : "surface_limit",
        status: selected.includes(item) ? "skipped" : "skipped",
      })),
  ];
  const results = [root];
  for (const choice of selected) {
    if (performance.now() >= companyDeadlineAt) break;
    try {
      const scanned = await scan(choice.url, choice.type);
      const finalHost = scanned.finalHost?.toLowerCase().replace(/\.$/, "");
      const result =
        finalHost === choice.host
          ? scanned
          : {
              ...scanned,
              status: "partial" as const,
              outcome: "partial" as const,
              candidates: [],
              evidence: [],
              coverage: {
                ...scanned.coverage,
                outcome: "partial" as const,
                incompleteReasons: [
                  ...new Set([...scanned.coverage.incompleteReasons, "surface_redirect_mismatch"]),
                ],
              },
            };
      results.push(result);
      const item = surfaces.find((surface) => surface.host === choice.host);
      if (item)
        item.status =
          result.status === "failed" ||
          result.coverage.incompleteReasons.includes("surface_redirect_mismatch")
            ? "failed"
            : "scanned";
    } catch {
      const item = surfaces.find((surface) => surface.host === choice.host);
      if (item) item.status = "failed";
    }
  }
  const allEvidence = [
    ...new Map(
      results
        .flatMap((item) => item.evidence)
        .map((item) => [
          `${item.surfaceType}:${item.surfaceHost}:${item.providerSlug}:${item.signatureKey}:${item.sourceOrigin}`,
          item,
        ]),
    ).values(),
  ];
  const evidence = fuseEvidence(allEvidence);
  const fusedCandidates = makeCandidates(evidence);
  const technologyObservations = fuseTechnologyObservations(
    results.flatMap((item) => item.technologyObservations ?? []),
    new Set(fusedCandidates.map(({ providerSlug }) => providerSlug)),
  );
  const uniqueTechnology = new Map<string, TechnologyObservation>();
  for (const observation of technologyObservations) {
    const prior = uniqueTechnology.get(observation.technologySlug);
    if (!prior || (observation.strength === "strong" && prior.strength !== "strong"))
      uniqueTechnology.set(observation.technologySlug, observation);
  }
  const technologySuppressionReasonCounts = technologyObservations.reduce<Record<string, number>>(
    (counts, observation) => {
      if (observation.suppressionReason)
        counts[observation.suppressionReason] = (counts[observation.suppressionReason] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const suppression = buildSuppression(
    allEvidence,
    new Set(fusedCandidates.map((item) => item.providerSlug)),
    evidence,
  );
  const incompleteSurface = surfaces.some((item) => item.selected && item.status !== "scanned");
  for (const result of results) {
    const scannedUrlHost = new URL(result.normalizedUrl).hostname.toLowerCase().replace(/\.$/, "");
    const surface = surfaces.find(
      (item) => item.host.toLowerCase().replace(/\.$/, "") === scannedUrlHost,
    );
    if (!surface) continue;
    surface.staticBytes = result.coverage.html.bytesRead;
    surface.staticDurationMs = result.coverage.staticCoverage.durationMs;
    surface.scriptBytes = result.coverage.javascript.bytesFetched;
    surface.cssBytes = result.coverage.css?.bytesFetched ?? 0;
    surface.runtimeDurationMs = result.coverage.runtime.durationMs;
    surface.runtimeRequests = result.coverage.runtime.requestsObserved;
  }
  const outcome =
    results.some((item) => item.outcome === "partial") || incompleteSurface
      ? "partial"
      : fusedCandidates.length
        ? "complete"
        : "empty";
  const durationMs = Math.ceil(performance.now() - startedAt);
  const status = outcome === "partial" ? "partial" : "completed";
  return {
    ...root,
    status,
    outcome,
    candidates: fusedCandidates,
    evidence: allEvidence,
    surfaceLinks: [],
    companyCoverage: {
      surfacesObserved: choices.length + 1,
      surfacesClassified: choices.length + 1,
      surfacesSelected: selected.length + 1,
      surfacesScanned: surfaces.filter((item) => item.status === "scanned").length,
      surfaces: surfaces.slice(0, companyDiscoveryLimits.maxStoredSurfaces),
      providersObserved: new Set(allEvidence.map((item) => item.providerSlug)).size,
      providersSuggested: fusedCandidates.length,
      providersSuppressed: new Set(
        suppression.suppressed
          .map((item) => item.providerSlug)
          .filter(
            (providerSlug) => !fusedCandidates.some((item) => item.providerSlug === providerSlug),
          ),
      ).size,
      technologyObservations,
      technologyObservationsTotal: technologyObservations.length,
      technologiesObserved: uniqueTechnology.size,
      technologiesRecognized: uniqueTechnology.size,
      externalProvidersRecognized: new Set(
        technologyObservations
          .filter(
            ({ category }) =>
              category !== "framework" && category !== "library" && category !== "build_tool",
          )
          .map(({ technologySlug }) => technologySlug),
      ).size,
      technologiesStrong: [...uniqueTechnology.values()].filter(
        ({ strength }) => strength === "strong",
      ).length,
      technologiesMedium: [...uniqueTechnology.values()].filter(
        ({ strength }) => strength === "medium",
      ).length,
      technologiesWeak: [...uniqueTechnology.values()].filter(({ strength }) => strength === "weak")
        .length,
      protectableTechnologies: new Set(
        technologyObservations
          .filter(({ protectability }) => protectability === "protectable")
          .map(({ technologySlug }) => technologySlug),
      ).size,
      protectableTechnologiesSuggested: new Set(
        technologyObservations
          .filter(
            ({ protectability, disposition }) =>
              protectability === "protectable" && disposition === "suggested",
          )
          .map(({ technologySlug }) => technologySlug),
      ).size,
      technologySuppressionReasonCounts,
      suppressionReasonCounts: suppression.suppressionReasonCounts,
      suppressedObservations: suppression.suppressed,
      totalDurationMs: durationMs,
      totalStaticBytes: budget.staticBytes,
      totalStaticWireBytes: budget.staticWireBytes,
      totalScriptBytes: results.reduce(
        (sum, item) => sum + item.coverage.javascript.bytesFetched,
        0,
      ),
      totalCssBytes: results.reduce((sum, item) => sum + (item.coverage.css?.bytesFetched ?? 0), 0),
      totalRuntimeBytes: budget.runtimeBytes,
      totalRuntimeWireBytes: budget.runtimeWireBytes,
      totalRuntimeDurationMs: results.reduce(
        (sum, item) => sum + item.coverage.runtime.durationMs,
        0,
      ),
      totalRuntimeRequests: runtimeBudget.requests,
      totalRuntimeHosts: runtimeBudget.hosts.size,
      totalRuntimeFingerprintEvaluations: results.reduce(
        (sum, item) => sum + (item.coverage.runtime.technologyFingerprintEvaluations ?? 0),
        0,
      ),
    },
    coverage: {
      ...root.coverage,
      durationMs,
      outcome,
      incompleteReasons: [...new Set(results.flatMap((item) => item.coverage.incompleteReasons))],
    },
  };
}
