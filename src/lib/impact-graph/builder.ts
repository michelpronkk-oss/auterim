import { createHash } from "node:crypto";

export const IMPACT_GRAPH_BUILDER_VERSION = "impact-graph-v1";

export type GraphNode = {
  node_type: string;
  identity_key: string;
  normalized_label: string;
  repository_id: string | null;
  commit_sha: string | null;
  path: string | null;
  analysis_run_id: string;
  code_entity_id: string | null;
  code_reference_id: string | null;
};

export type GraphEdge = {
  edge_type: string;
  edge_kind: "observed" | "inferred";
  evidence_type: "code_relation" | "external_reference" | "dependency_mapping" | "intelligence_decision" | "coverage" | "code_entity" | "analysis_identity";
  code_relation_id: string | null;
  code_reference_id: string | null;
  evidence_chain: Array<Record<string, string>>;
  evidence_path: string | null;
  evidence_start_line: number | null;
  evidence_start_column: number | null;
  evidence_end_line: number | null;
  evidence_end_column: number | null;
  classifier_decision_id: string | null;
  policy_version: string;
  graph_builder_version: string;
  confidence_class: "exact" | "structural" | "heuristic";
  edge_fingerprint: string;
  from_node_id: string;
  to_node_id: string;
};

type EntityRow = {
  id: string;
  entity_type: string;
  name: string;
  path: string;
  language: string;
  confidence_class: "exact" | "structural" | "heuristic";
};
type RelationRow = {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  confidence_class: "exact" | "structural" | "heuristic";
  evidence_path: string;
  evidence_start_line: number;
  evidence_start_column: number;
  evidence_end_line: number;
  evidence_end_column: number;
  extractor_type: string;
};
type ReferenceRow = {
  id: string;
  entity_id: string;
  reference_type: string;
  normalized_value: string;
  path: string;
  start_line: number;
  start_column: number | null;
  end_line: number;
  end_column: number | null;
  confidence_class: "exact" | "structural" | "heuristic";
};

export type ImpactGraphInput = {
  buildId: string;
  workspaceId: string;
  productId: string;
  repositoryId: string;
  sourceChangeId: string;
  decisionId: string;
  sourceClassificationId?: string | null;
  changedEntities?: string[];
  analysisRunId: string;
  commitSha: string;
  graphBuilderVersion?: string;
  policyVersion: string;
  route: string;
  routeTarget: string;
  dependencyId: string;
  dependencySlug: string;
  dependencyName: string;
  dependencyWebsite: string;
  mappingId: string;
  dependencyMappingId: string;
  entities: EntityRow[];
  relations: RelationRow[];
  references: ReferenceRow[];
  coverageTruth: string;
};

export type ImpactGraphFacts = { nodes: GraphNode[]; edges: GraphEdge[]; assessmentState: "evidence_present" | "absence_observed" | "unknown_incomplete" };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tuple = (...parts: Array<string | number | null>) => parts.map((part) => part ?? "").join("\0");
const relationEdgeTypes: Record<string, string> = {
  FILE_CONTAINS_SYMBOL: "FILE_CONTAINS_SYMBOL",
  IMPORTS_PACKAGE: "IMPORTS_PACKAGE",
  IMPORTS_SYMBOL: "IMPORTS_SYMBOL",
  CALLS_SYMBOL: "CALLS_SYMBOL",
  REFERENCES_EXTERNAL: "REFERENCES_EXTERNAL",
  USES_ENV_NAME: "USES_ENV_NAME",
  HANDLES_EVENT: "HANDLES_EVENT",
  CALLS_ENDPOINT: "CALLS_ENDPOINT",
  REFERENCES_SCHEMA: "REFERENCES_SCHEMA",
};

function nodeType(entityType: string, referenceType?: string): string {
  if (referenceType) {
    if (referenceType === "package" || referenceType === "import") return "sdk_package";
    if (referenceType === "sdk_call") return "sdk_symbol";
    if (referenceType === "event") return "event";
    if (referenceType === "endpoint" || referenceType === "dynamic_endpoint") return "endpoint";
    if (referenceType === "schema") return "schema";
    if (referenceType === "environment_variable") return "environment_variable";
  }
  if (entityType === "package_dependency") return "sdk_package";
  if (entityType === "external_sdk_reference") return "sdk_symbol";
  if (entityType === "http_endpoint_reference") return "endpoint";
  if (entityType === "webhook_event_reference") return "event";
  if (entityType === "schema_reference") return "schema";
  if (entityType === "environment_variable_name") return "environment_variable";
  if (entityType === "file") return "file";
  if (entityType === "module") return "module";
  return "code_symbol";
}

const normalizePackage = (value: string) => value.trim().toLowerCase().replaceAll("\\", "/");

function providerAliases(slug: string, name: string): string[] {
  const aliases: Record<string, string[]> = {
    openai: ["openai"],
    stripe: ["stripe"],
    supabase: ["@supabase/supabase-js"],
    vercel: ["@vercel/sdk"],
    github: ["@octokit/rest", "@octokit/app"],
    "trigger-dev": ["@trigger.dev/sdk"],
  };
  const registered = aliases[slug];
  return registered ? [...new Set([normalizePackage(slug), normalizePackage(name), ...registered])] : [];
}

function hasTrustedProviderMatcher(slug: string, name: string): boolean {
  return providerAliases(slug, name).length > 0;
}

function packageIdentity(value: string): string {
  const normalized = normalizePackage(value);
  const versionSeparator = normalized.lastIndexOf("@");
  const packageSeparator = normalized.startsWith("@") ? normalized.indexOf("/") : -1;
  return versionSeparator > packageSeparator ? normalized.slice(0, versionSeparator) : normalized;
}

function importMatches(value: string, aliases: string[]): boolean {
  const normalized = normalizePackage(value);
  return aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias}/`));
}

function hostMatches(value: string, website: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const providerHost = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
    return hostname === providerHost || hostname.endsWith(`.${providerHost}`);
  } catch {
    return false;
  }
}

function normalizeChangedEntity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function normalizeEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    // Only scheme and host are case-insensitive. Preserve pathname, trailing
    // slash, and query because APIs may use each to distinguish resources or versions.
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function candidateMatchesReference(candidate: string, reference: ReferenceRow): boolean {
  const normalizedCandidate = normalizeChangedEntity(candidate);
  const normalizedReference = normalizeChangedEntity(reference.normalized_value);
  switch (reference.reference_type) {
    case "package":
      return packageIdentity(normalizedReference) === packageIdentity(normalizedCandidate);
    case "import":
      return importMatches(normalizedReference, [normalizedCandidate]);
    case "sdk_call":
      return normalizedReference === normalizedCandidate;
    case "endpoint": {
      const candidateEndpoint = normalizeEndpoint(candidate);
      return candidateEndpoint !== null && normalizeEndpoint(reference.normalized_value) === candidateEndpoint;
    }
    case "event":
    case "schema":
    case "environment_variable":
      return normalizedReference === normalizedCandidate;
    default:
      return false;
  }
}

function routeReferenceTypes(route: string): ReadonlySet<string> {
  switch (route) {
    case "deprecation":
    case "sdk_change":
      return new Set(["package", "import", "sdk_call"]);
    case "breaking_api_change":
      return new Set(["endpoint", "sdk_call"]);
    case "webhook_or_event_change":
      return new Set(["event"]);
    case "schema_or_contract_change":
      return new Set(["schema"]);
    case "auth_or_security_change":
      return new Set(["environment_variable", "endpoint"]);
    default:
      return new Set();
  }
}

export function buildImpactGraphFacts(input: ImpactGraphInput): ImpactGraphFacts {
  const graphBuilderVersion = input.graphBuilderVersion ?? IMPACT_GRAPH_BUILDER_VERSION;
  const nodesByIdentity = new Map<string, GraphNode>();
  const nodeIds = new Map<string, string>();
  const edgesByFingerprint = new Map<string, GraphEdge>();
  const addNode = (type: string, label: string, identity: string, extra: Partial<GraphNode> = {}) => {
    const key = digest(tuple(type, identity));
    const node: GraphNode = {
      node_type: type,
      identity_key: key,
      normalized_label: label.slice(0, 512),
      repository_id: null,
      commit_sha: null,
      path: null,
      analysis_run_id: input.analysisRunId,
      code_entity_id: null,
      code_reference_id: null,
      ...extra,
    };
    nodesByIdentity.set(key, node);
    return key;
  };
  const addEdge = (inputEdge: Omit<GraphEdge, "edge_fingerprint"> & { fingerprintParts: string[] }) => {
    const { fingerprintParts, ...edge } = inputEdge;
    const edge_fingerprint = digest(tuple(input.buildId, edge.edge_type, ...fingerprintParts));
    edgesByFingerprint.set(edge_fingerprint, { ...edge, edge_fingerprint });
  };

  const changeNode = addNode("provider_change", `change:${input.sourceChangeId}`, input.sourceChangeId);
  const providerNode = addNode("provider", input.dependencySlug, input.dependencySlug);
  const dependencyNode = addNode("dependency", input.dependencyName, input.dependencyId);
  const productNode = addNode("product", input.productId, input.productId);
  const repoNode = addNode("repository", input.repositoryId, input.repositoryId, { repository_id: input.repositoryId, commit_sha: input.commitSha });
  const commitNode = addNode("commit", input.commitSha, `${input.repositoryId}:${input.commitSha}`, { repository_id: input.repositoryId, commit_sha: input.commitSha });
  addEdge({ edge_type: "CHANGE_AFFECTS_DEPENDENCY", edge_kind: "inferred", evidence_type: "dependency_mapping", code_relation_id: null, code_reference_id: null,
    evidence_chain: [{ type: "source_change", id: input.sourceChangeId }, { type: "source_catalog_dependency", id: input.dependencyId }],
    evidence_path: null, evidence_start_line: null, evidence_start_column: null, evidence_end_line: null, evidence_end_column: null,
    classifier_decision_id: input.decisionId, policy_version: input.policyVersion, graph_builder_version: graphBuilderVersion,
    confidence_class: "exact", from_node_id: changeNode, to_node_id: dependencyNode, fingerprintParts: [input.dependencyId, "provider-source"] });
  addEdge({ edge_type: "PROVIDER_HAS_DEPENDENCY", edge_kind: "observed", evidence_type: "dependency_mapping", code_relation_id: null, code_reference_id: null,
    evidence_chain: [{ type: "source_catalog_dependency", id: input.dependencyId }], evidence_path: null, evidence_start_line: null, evidence_start_column: null,
    evidence_end_line: null, evidence_end_column: null, classifier_decision_id: null, policy_version: input.policyVersion,
    graph_builder_version: graphBuilderVersion, confidence_class: "exact", from_node_id: providerNode, to_node_id: dependencyNode,
    fingerprintParts: [input.dependencyId, input.dependencySlug, "provider-dependency"] });
  addEdge({ edge_type: "PRODUCT_PROTECTS_DEPENDENCY", edge_kind: "observed", evidence_type: "dependency_mapping", code_relation_id: null, code_reference_id: null,
    evidence_chain: [{ type: "workspace_dependency", id: input.dependencyMappingId }], evidence_path: null, evidence_start_line: null, evidence_start_column: null,
    evidence_end_line: null, evidence_end_column: null, classifier_decision_id: null, policy_version: input.policyVersion,
    graph_builder_version: graphBuilderVersion, confidence_class: "exact", from_node_id: productNode, to_node_id: dependencyNode,
    fingerprintParts: [input.dependencyMappingId, "product-protects-dependency"] });
  addEdge({ edge_type: "PRODUCT_USES_REPOSITORY", edge_kind: "observed", evidence_type: "dependency_mapping", code_relation_id: null, code_reference_id: null,
    evidence_chain: [{ type: "workspace_product_repository", id: input.mappingId }], evidence_path: null, evidence_start_line: null, evidence_start_column: null,
    evidence_end_line: null, evidence_end_column: null, classifier_decision_id: null, policy_version: input.policyVersion,
    graph_builder_version: graphBuilderVersion, confidence_class: "exact", from_node_id: productNode, to_node_id: repoNode,
    fingerprintParts: [input.mappingId, "product-uses-repository"] });
  addEdge({ edge_type: "REPOSITORY_CONTAINS_COMMIT", edge_kind: "observed", evidence_type: "analysis_identity", code_relation_id: null, code_reference_id: null,
    evidence_chain: [{ type: "code_analysis_run", id: input.analysisRunId }], evidence_path: null, evidence_start_line: null, evidence_start_column: null,
    evidence_end_line: null, evidence_end_column: null, classifier_decision_id: null, policy_version: input.policyVersion,
    graph_builder_version: graphBuilderVersion, confidence_class: "exact", from_node_id: repoNode, to_node_id: commitNode,
    fingerprintParts: [input.commitSha, "repository-commit"] });

  const entityNodeById = new Map<string, string>();
  const fileNodes = new Map<string, string>();
  for (const entity of input.entities) {
    const type = nodeType(entity.entity_type);
    const id = addNode(type, entity.name, `${input.repositoryId}:${input.commitSha}:${entity.path}:${entity.id}`, {
      repository_id: input.repositoryId, commit_sha: input.commitSha, path: entity.path, code_entity_id: entity.id,
    });
    entityNodeById.set(entity.id, id);
    nodeIds.set(entity.id, id);
    if (entity.entity_type === "file") fileNodes.set(entity.path, id);
    if (entity.entity_type === "file") addEdge({ edge_type: "COMMIT_CONTAINS_FILE", edge_kind: "observed", evidence_type: "code_entity", code_relation_id: null, code_reference_id: null,
      evidence_chain: [{ type: "code_entity", id: entity.id }], evidence_path: entity.path, evidence_start_line: null, evidence_start_column: null,
      evidence_end_line: null, evidence_end_column: null, classifier_decision_id: null, policy_version: input.policyVersion,
      graph_builder_version: graphBuilderVersion, confidence_class: entity.confidence_class,
      from_node_id: commitNode, to_node_id: id,
      fingerprintParts: [entity.id, "commit-entity", entity.path] });
  }
  for (const relation of input.relations) {
    const from = entityNodeById.get(relation.from_entity_id);
    const to = entityNodeById.get(relation.to_entity_id);
    const edgeType = relationEdgeTypes[relation.relation_type];
    if (!from || !to || !edgeType) throw new Error("impact_graph_relation_endpoint_missing");
    addEdge({ edge_type: edgeType, edge_kind: "observed", evidence_type: "code_relation", code_relation_id: relation.id, code_reference_id: null,
      evidence_chain: [{ type: "code_relation", id: relation.id }], evidence_path: relation.evidence_path,
      evidence_start_line: relation.evidence_start_line, evidence_start_column: relation.evidence_start_column,
      evidence_end_line: relation.evidence_end_line, evidence_end_column: relation.evidence_end_column,
      classifier_decision_id: null, policy_version: input.policyVersion, graph_builder_version: graphBuilderVersion,
      confidence_class: relation.confidence_class, from_node_id: from, to_node_id: to,
      fingerprintParts: [relation.id, relation.evidence_path, String(relation.evidence_start_line), String(relation.evidence_start_column)] });
  }

  const aliases = providerAliases(input.dependencySlug, input.dependencyName);
  const routeTypes = routeReferenceTypes(input.route);
  const changedEntities = (input.changedEntities ?? []).filter((value) => value.trim().length > 0).slice(0, 5);
  const providerAssociatedEventOrSchema = (reference: ReferenceRow) => {
    // Co-location in a file is not evidence that an event/schema belongs to a
    // provider. Require both facts to share a structurally represented parent
    // (for example, the same function) and a provider SDK call or endpoint.
    const referenceRelation = reference.reference_type === "event" ? "HANDLES_EVENT" : "REFERENCES_SCHEMA";
    const referenceParents = new Set(input.relations
      .filter((relation) => relation.to_entity_id === reference.entity_id && relation.relation_type === referenceRelation)
      .map((relation) => relation.from_entity_id));
    if (referenceParents.size === 0) return false;
    return input.references.some((providerReference) => {
      if (providerReference.path !== reference.path || !["sdk_call", "endpoint"].includes(providerReference.reference_type)) return false;
      const providerRelation = providerReference.reference_type === "sdk_call" ? "REFERENCES_EXTERNAL" : "CALLS_ENDPOINT";
      const isProviderOwned = providerReference.reference_type === "sdk_call"
        ? aliases.some((alias) => normalizePackage(providerReference.normalized_value).startsWith(`${alias}.`))
        : hostMatches(providerReference.normalized_value, input.dependencyWebsite);
      return isProviderOwned && input.relations.some((relation) =>
        relation.to_entity_id === providerReference.entity_id && relation.relation_type === providerRelation &&
        referenceParents.has(relation.from_entity_id));
    });
  };
  const matchedReferences: Array<{ node: string; id: string; type: string; confidence: "exact" | "structural" | "heuristic" }> = [];
  let unmatchedRelevantReference = false;
  for (const reference of input.references) {
    const entityNode = entityNodeById.get(reference.entity_id);
    if (!entityNode) throw new Error("impact_graph_reference_entity_missing");
    const referenceNode = addNode(nodeType("", reference.reference_type), reference.normalized_value,
      `${input.repositoryId}:${input.commitSha}:${reference.id}`, {
        repository_id: input.repositoryId, commit_sha: input.commitSha, path: reference.path,
        analysis_run_id: input.analysisRunId, code_entity_id: reference.entity_id, code_reference_id: reference.id,
      });
    const fileNode = fileNodes.get(reference.path) ?? entityNode;
    addEdge({ edge_type: "REFERENCES_EXTERNAL", edge_kind: "observed", evidence_type: "external_reference", code_relation_id: null,
      code_reference_id: reference.id, evidence_chain: [{ type: "external_reference", id: reference.id }], evidence_path: reference.path,
      evidence_start_line: reference.start_line, evidence_start_column: reference.start_column, evidence_end_line: reference.end_line,
      evidence_end_column: reference.end_column, classifier_decision_id: null, policy_version: input.policyVersion,
      graph_builder_version: graphBuilderVersion, confidence_class: reference.confidence_class,
      from_node_id: fileNode, to_node_id: referenceNode,
      fingerprintParts: [reference.id, "source-reference", reference.path, String(reference.start_line)] });
    const relevantType = routeTypes.has(reference.reference_type);
    const providerPackage = reference.reference_type === "package" && aliases.includes(packageIdentity(reference.normalized_value));
    const providerImport = reference.reference_type === "import" && importMatches(reference.normalized_value, aliases);
    const providerCall = reference.reference_type === "sdk_call" && aliases.some((alias) =>
      normalizePackage(reference.normalized_value).startsWith(`${alias}.`));
    const providerEndpoint = reference.reference_type === "endpoint" && hostMatches(reference.normalized_value, input.dependencyWebsite);
    const providerOwnedReference = providerPackage || providerImport || providerCall || providerEndpoint ||
      (["event", "schema"].includes(reference.reference_type) && providerAssociatedEventOrSchema(reference));
    const changeMatch = relevantType && providerOwnedReference && changedEntities.some((candidate) =>
      candidateMatchesReference(candidate, reference));
    if (relevantType && !changeMatch && (providerOwnedReference || ["event", "schema"].includes(reference.reference_type)))
      unmatchedRelevantReference = true;
    if (changeMatch) {
      const inferredConfidence = reference.confidence_class === "heuristic" ? "heuristic" : "structural";
      matchedReferences.push({ node: referenceNode, id: reference.id, type: reference.reference_type, confidence: inferredConfidence });
      const changeEdgeType = reference.reference_type === "endpoint" ? "CHANGE_AFFECTS_ENDPOINT"
        : reference.reference_type === "event" ? "CHANGE_AFFECTS_EVENT"
          : reference.reference_type === "schema" ? "CHANGE_AFFECTS_SCHEMA"
            : reference.reference_type === "environment_variable" ? "CHANGE_AFFECTS_API" : "CHANGE_AFFECTS_SDK";
      addEdge({ edge_type: changeEdgeType,
        edge_kind: "inferred", evidence_type: "intelligence_decision", code_relation_id: null, code_reference_id: reference.id,
        evidence_chain: [{ type: "intelligence_decision", id: input.decisionId },
          ...(input.sourceClassificationId ? [{ type: "source_change_classification", id: input.sourceClassificationId }] : []),
          { type: "dependency_mapping", id: input.dependencyId },
          { type: "external_reference", id: reference.id }], evidence_path: reference.path, evidence_start_line: reference.start_line,
        evidence_start_column: reference.start_column, evidence_end_line: reference.end_line, evidence_end_column: reference.end_column,
        classifier_decision_id: input.decisionId, policy_version: input.policyVersion, graph_builder_version: graphBuilderVersion,
        confidence_class: inferredConfidence, from_node_id: changeNode, to_node_id: referenceNode,
        fingerprintParts: [input.decisionId, reference.id, input.commitSha, input.route] });
    }
  }
  if (matchedReferences.length > 0) {
    addEdge({ edge_type: "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE", edge_kind: "inferred", evidence_type: "intelligence_decision",
      code_relation_id: null, code_reference_id: null,
      evidence_chain: [{ type: "intelligence_decision", id: input.decisionId }, { type: "workspace_product_repository", id: input.mappingId },
        ...(input.sourceClassificationId ? [{ type: "source_change_classification", id: input.sourceClassificationId }] : []),
        ...matchedReferences.slice(0, 32).map((item) => ({ type: "external_reference", id: item.id }))],
      evidence_path: null, evidence_start_line: null, evidence_start_column: null, evidence_end_line: null, evidence_end_column: null,
      classifier_decision_id: input.decisionId, policy_version: input.policyVersion, graph_builder_version: graphBuilderVersion,
      confidence_class: "structural", from_node_id: productNode, to_node_id: changeNode,
      fingerprintParts: [input.productId, input.sourceChangeId, input.commitSha, ...matchedReferences.map((item) => item.id).sort()] });
  }
  const assessmentState = matchedReferences.length > 0
    ? "evidence_present"
    : !unmatchedRelevantReference && changedEntities.length > 0 && input.coverageTruth === "FULL_SUPPORTED_PROFILE"
      && hasTrustedProviderMatcher(input.dependencySlug, input.dependencyName)
      ? "absence_observed"
      : "unknown_incomplete";
  return { nodes: [...nodesByIdentity.values()], edges: [...edgesByFingerprint.values()], assessmentState };
}
