import { describe, expect, it } from "vitest";
import { buildImpactGraphFacts, type ImpactGraphInput } from "@/lib/impact-graph/builder";

function input(overrides: Partial<ImpactGraphInput> = {}): ImpactGraphInput {
  return {
    buildId: "build-1",
    workspaceId: "workspace-1",
    productId: "product-1",
    repositoryId: "repository-1",
    sourceChangeId: "change-1",
    decisionId: "decision-1",
    sourceClassificationId: "classification-1",
    changedEntities: ["openai"],
    analysisRunId: "analysis-1",
    commitSha: "a".repeat(40),
    policyVersion: "policy-v1",
    route: "sdk_change",
    routeTarget: "repository_dependency_exposure_analysis",
    dependencyId: "dependency-1",
    dependencySlug: "openai",
    dependencyName: "OpenAI",
    dependencyWebsite: "https://openai.com",
    mappingId: "mapping-1",
    dependencyMappingId: "dependency-mapping-1",
    entities: [
      {
        id: "entity-file",
        entity_type: "file",
        name: "src/client.ts",
        path: "src/client.ts",
        language: "typescript",
        confidence_class: "exact",
      },
    ],
    relations: [],
    references: [],
    coverageTruth: "FULL_SUPPORTED_PROFILE",
    ...overrides,
  };
}

describe("M15.77 impact graph facts", () => {
  it("keeps code observations separate from provider-change inference", () => {
    const facts = buildImpactGraphFacts(
      input({
        references: [
          {
            id: "ref-1",
            entity_id: "entity-file",
            reference_type: "package",
            normalized_value: "openai",
            path: "src/client.ts",
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 20,
            confidence_class: "exact",
          },
        ],
      }),
    );
    expect(facts.assessmentState).toBe("evidence_present");
    expect(facts.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: "REFERENCES_EXTERNAL",
          edge_kind: "observed",
          evidence_type: "external_reference",
        }),
        expect.objectContaining({
          edge_type: "CHANGE_AFFECTS_SDK",
          edge_kind: "inferred",
          evidence_type: "intelligence_decision",
        }),
        expect.objectContaining({ edge_type: "PROVIDER_HAS_DEPENDENCY", edge_kind: "observed" }),
      ]),
    );
    expect(facts.edges.filter((edge) => edge.edge_type === "COMMIT_CONTAINS_FILE")).toHaveLength(1);
  });

  it("does not infer exposure from a generic external reference", () => {
    const facts = buildImpactGraphFacts(
      input({
        references: [
          {
            id: "ref-2",
            entity_id: "entity-file",
            reference_type: "package",
            normalized_value: "unrelated-package",
            path: "src/client.ts",
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 20,
            confidence_class: "exact",
          },
        ],
      }),
    );
    expect(facts.edges.some((edge) => edge.edge_type === "REFERENCES_EXTERNAL")).toBe(true);
    expect(facts.edges.some((edge) => edge.edge_type === "CHANGE_AFFECTS_SDK")).toBe(false);
    expect(facts.assessmentState).toBe("absence_observed");
  });

  it("matches manifest versions and package subpath imports without overstating inference confidence", () => {
    const facts = buildImpactGraphFacts(
      input({
        route: "deprecation",
        references: [
          {
            id: "ref-package",
            entity_id: "entity-file",
            reference_type: "package",
            normalized_value: "openai@4.12.0",
            path: "package.json",
            start_line: 1,
            start_column: null,
            end_line: 1,
            end_column: null,
            confidence_class: "exact",
          },
          {
            id: "ref-import",
            entity_id: "entity-file",
            reference_type: "import",
            normalized_value: "openai/resources/responses",
            path: "src/client.ts",
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 40,
            confidence_class: "exact",
          },
        ],
      }),
    );
    expect(facts.assessmentState).toBe("evidence_present");
    expect(facts.edges.filter((edge) => edge.edge_type === "CHANGE_AFFECTS_SDK")).toHaveLength(2);
    expect(
      facts.edges
        .filter((edge) => edge.edge_type === "CHANGE_AFFECTS_SDK")
        .every((edge) => edge.confidence_class === "structural"),
    ).toBe(true);
  });

  it("keeps unknown provider mappings and incomplete scans unknown", () => {
    const unmatched = buildImpactGraphFacts(
      input({ dependencySlug: "unknown-vendor", dependencyName: "Unknown Vendor" }),
    );
    const partial = buildImpactGraphFacts(input({ coverageTruth: "PARTIAL_SUPPORTED_PROFILE" }));
    expect(unmatched.assessmentState).toBe("unknown_incomplete");
    expect(partial.assessmentState).toBe("unknown_incomplete");
  });

  it("matches exact provider domains and records file provenance", () => {
    const endpoint = "https://api.openai.com/v1/responses";
    const facts = buildImpactGraphFacts(
      input({
        route: "breaking_api_change",
        routeTarget: "dependency_impact_repository_exposure_candidate",
        changedEntities: [endpoint],
        references: [
          {
            id: "ref-3",
            entity_id: "entity-file",
            reference_type: "endpoint",
            normalized_value: endpoint,
            path: "src/client.ts",
            start_line: 4,
            start_column: 12,
            end_line: 4,
            end_column: 53,
            confidence_class: "structural",
          },
        ],
      }),
    );
    expect(facts.assessmentState).toBe("evidence_present");
    expect(facts.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: "CHANGE_AFFECTS_ENDPOINT",
          edge_kind: "inferred",
          evidence_path: "src/client.ts",
          evidence_start_line: 4,
        }),
      ]),
    );
  });

  it("matches a typed METHOD plus exact URL for a deprecation without changing route semantics", () => {
    const endpoint = "https://api.openai.com/v1/responses";
    const facts = buildImpactGraphFacts(
      input({
        route: "deprecation",
        routeTarget: "dependency_product_impact",
        changedEntities: [`POST ${endpoint}`],
        references: [
          {
            id: "deprecated-endpoint",
            entity_id: "entity-file",
            reference_type: "endpoint",
            normalized_value: endpoint,
            path: "src/client.ts",
            start_line: 114,
            start_column: 30,
            end_line: 114,
            end_column: 68,
            confidence_class: "exact",
          },
        ],
      }),
    );
    expect(facts.assessmentState).toBe("evidence_present");
    expect(facts.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: "REFERENCES_EXTERNAL",
          edge_kind: "observed",
          code_reference_id: "deprecated-endpoint",
        }),
        expect.objectContaining({
          edge_type: "CHANGE_AFFECTS_ENDPOINT",
          edge_kind: "inferred",
          code_reference_id: "deprecated-endpoint",
        }),
        expect.objectContaining({
          edge_type: "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE",
          edge_kind: "inferred",
        }),
      ]),
    );
  });

  it("does not fuzzy-match deprecation endpoint prose or an unrelated endpoint", () => {
    const reference = {
      id: "exact-endpoint",
      entity_id: "entity-file",
      reference_type: "endpoint",
      normalized_value: "https://api.openai.com/v1/responses",
      path: "src/client.ts",
      start_line: 1,
      start_column: 1,
      end_line: 1,
      end_column: 50,
      confidence_class: "exact" as const,
    };
    for (const changedEntity of [
      "Responses API at https://api.openai.com/v1/responses may change",
      "TRACE https://api.openai.com/v1/responses",
      "POST https://api.openai.com/v1/responses extra",
    ]) {
      const facts = buildImpactGraphFacts(
        input({
          route: "deprecation",
          routeTarget: "dependency_product_impact",
          changedEntities: [changedEntity],
          references: [reference],
        }),
      );
      expect(facts.edges.some((edge) => edge.edge_type === "CHANGE_AFFECTS_ENDPOINT")).toBe(false);
      expect(
        facts.edges.some((edge) => edge.edge_type === "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE"),
      ).toBe(false);
    }

    const unrelated = buildImpactGraphFacts(
      input({
        route: "deprecation",
        routeTarget: "dependency_product_impact",
        changedEntities: ["POST https://api.openai.com/v1/responses"],
        references: [{ ...reference, normalized_value: "https://api.openai.com/v1/responses/v2" }],
      }),
    );
    expect(unrelated.edges.some((edge) => edge.edge_type === "CHANGE_AFFECTS_ENDPOINT")).toBe(
      false,
    );
    expect(
      unrelated.edges.some((edge) => edge.edge_type === "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE"),
    ).toBe(false);
  });

  it("does not match endpoint paths case-insensitively", () => {
    const facts = buildImpactGraphFacts(
      input({
        route: "breaking_api_change",
        changedEntities: ["https://api.openai.com/v1/Users"],
        references: [
          {
            id: "case-sensitive-path",
            entity_id: "entity-file",
            reference_type: "endpoint",
            normalized_value: "https://API.OPENAI.COM/v1/users",
            path: "src/client.ts",
            start_line: 4,
            start_column: 12,
            end_line: 4,
            end_column: 53,
            confidence_class: "structural",
          },
        ],
      }),
    );
    expect(facts.edges.some((edge) => edge.edge_type === "CHANGE_AFFECTS_ENDPOINT")).toBe(false);
    expect(facts.assessmentState).toBe("unknown_incomplete");
  });

  it("preserves endpoint query strings and trailing slashes during matching", () => {
    const facts = buildImpactGraphFacts(
      input({
        route: "breaking_api_change",
        changedEntities: [
          "https://api.openai.com/v1/responses?api-version=v2",
          "https://api.openai.com/v1/users",
        ],
        references: [
          {
            id: "query-version",
            entity_id: "entity-file",
            reference_type: "endpoint",
            normalized_value: "https://api.openai.com/v1/responses?api-version=v1",
            path: "src/client.ts",
            start_line: 4,
            start_column: 1,
            end_line: 4,
            end_column: 50,
            confidence_class: "structural",
          },
          {
            id: "trailing-slash",
            entity_id: "entity-file",
            reference_type: "endpoint",
            normalized_value: "https://api.openai.com/v1/users/",
            path: "src/client.ts",
            start_line: 5,
            start_column: 1,
            end_line: 5,
            end_column: 50,
            confidence_class: "structural",
          },
        ],
      }),
    );
    expect(facts.edges.some((edge) => edge.edge_type === "CHANGE_AFFECTS_ENDPOINT")).toBe(false);
    expect(facts.assessmentState).toBe("unknown_incomplete");
  });

  it("requires an exact typed change entity before inferring event impact", () => {
    const eventReference = {
      id: "event-ref",
      entity_id: "event-entity",
      reference_type: "event",
      normalized_value: "customer.subscription.updated",
      path: "src/webhooks.ts",
      start_line: 8,
      start_column: 10,
      end_line: 8,
      end_column: 49,
      confidence_class: "exact" as const,
    };
    const providerCall = {
      id: "provider-call",
      entity_id: "provider-call-entity",
      reference_type: "sdk_call",
      normalized_value: "stripe.webhooks.constructEvent",
      path: "src/webhooks.ts",
      start_line: 6,
      start_column: 4,
      end_line: 6,
      end_column: 35,
      confidence_class: "structural" as const,
    };
    const eventEntities = [
      {
        id: "function-entity",
        entity_type: "function",
        name: "handleWebhook",
        path: "src/webhooks.ts",
        language: "typescript",
        confidence_class: "exact" as const,
      },
      {
        id: "event-entity",
        entity_type: "webhook_event_reference",
        name: eventReference.normalized_value,
        path: "src/webhooks.ts",
        language: "typescript",
        confidence_class: "exact" as const,
      },
      {
        id: "provider-call-entity",
        entity_type: "external_sdk_reference",
        name: providerCall.normalized_value,
        path: "src/webhooks.ts",
        language: "typescript",
        confidence_class: "structural" as const,
      },
    ];
    const eventRelations = [
      {
        id: "handles-event",
        from_entity_id: "function-entity",
        to_entity_id: "event-entity",
        relation_type: "HANDLES_EVENT",
        confidence_class: "exact" as const,
        evidence_path: "src/webhooks.ts",
        evidence_start_line: 8,
        evidence_start_column: 1,
        evidence_end_line: 8,
        evidence_end_column: 49,
        extractor_type: "test",
      },
      {
        id: "calls-provider",
        from_entity_id: "function-entity",
        to_entity_id: "provider-call-entity",
        relation_type: "REFERENCES_EXTERNAL",
        confidence_class: "structural" as const,
        evidence_path: "src/webhooks.ts",
        evidence_start_line: 6,
        evidence_start_column: 1,
        evidence_end_line: 6,
        evidence_end_column: 35,
        extractor_type: "test",
      },
    ];
    const matched = buildImpactGraphFacts(
      input({
        route: "webhook_or_event_change",
        routeTarget: "contract_repository_exposure_analysis",
        dependencySlug: "stripe",
        dependencyName: "Stripe",
        dependencyWebsite: "https://stripe.com",
        changedEntities: ["customer.subscription.updated"],
        entities: [...input().entities, ...eventEntities],
        relations: eventRelations,
        references: [providerCall, eventReference],
      }),
    );
    expect(matched.assessmentState).toBe("evidence_present");
    expect(matched.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: "CHANGE_AFFECTS_EVENT",
          code_reference_id: "event-ref",
        }),
        expect.objectContaining({
          evidence_chain: expect.arrayContaining([
            { type: "source_change_classification", id: "classification-1" },
          ]),
        }),
      ]),
    );

    const unmatched = buildImpactGraphFacts(
      input({
        route: "webhook_or_event_change",
        routeTarget: "contract_repository_exposure_analysis",
        dependencySlug: "stripe",
        dependencyName: "Stripe",
        dependencyWebsite: "https://stripe.com",
        changedEntities: ["customer.subscription.deleted"],
        entities: [...input().entities, ...eventEntities],
        relations: eventRelations,
        references: [providerCall, eventReference],
      }),
    );
    expect(unmatched.assessmentState).toBe("unknown_incomplete");
    expect(
      unmatched.edges.some((edge) => edge.edge_type === "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE"),
    ).toBe(false);
  });

  it("does not infer provider ownership from an unrelated same-file import", () => {
    const facts = buildImpactGraphFacts(
      input({
        route: "webhook_or_event_change",
        routeTarget: "contract_repository_exposure_analysis",
        dependencySlug: "stripe",
        dependencyName: "Stripe",
        dependencyWebsite: "https://stripe.com",
        changedEntities: ["customer.subscription.updated"],
        references: [
          {
            id: "stripe-import",
            entity_id: "entity-file",
            reference_type: "import",
            normalized_value: "stripe",
            path: "src/webhooks.ts",
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 24,
            confidence_class: "exact",
          },
          {
            id: "unrelated-event",
            entity_id: "entity-file",
            reference_type: "event",
            normalized_value: "customer.subscription.updated",
            path: "src/webhooks.ts",
            start_line: 12,
            start_column: 1,
            end_line: 12,
            end_column: 40,
            confidence_class: "exact",
          },
        ],
      }),
    );
    expect(facts.edges.some((edge) => edge.edge_type === "CHANGE_AFFECTS_EVENT")).toBe(false);
    expect(
      facts.edges.some((edge) => edge.edge_type === "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE"),
    ).toBe(false);
    expect(facts.assessmentState).toBe("unknown_incomplete");
  });

  it("never reports absence when route-relevant event or schema references cannot be matched", () => {
    const event = {
      id: "event-ref",
      entity_id: "entity-file",
      reference_type: "event",
      normalized_value: "customer.subscription.updated",
      path: "src/webhooks.ts",
      start_line: 8,
      start_column: 10,
      end_line: 8,
      end_column: 49,
      confidence_class: "exact" as const,
    };
    const schema = {
      id: "schema-ref",
      entity_id: "entity-file",
      reference_type: "schema",
      normalized_value: "SubscriptionPayload",
      path: "src/types.ts",
      start_line: 3,
      start_column: 1,
      end_line: 3,
      end_column: 24,
      confidence_class: "structural" as const,
    };
    expect(
      buildImpactGraphFacts(
        input({
          route: "webhook_or_event_change",
          changedEntities: ["customer.subscription.deleted"],
          references: [event],
        }),
      ).assessmentState,
    ).toBe("unknown_incomplete");
    expect(
      buildImpactGraphFacts(
        input({
          route: "schema_or_contract_change",
          routeTarget: "contract_exposure_analysis",
          changedEntities: ["InvoicePayload"],
          references: [schema],
        }),
      ).assessmentState,
    ).toBe("unknown_incomplete");
  });

  it("matches a changed schema only when the exact schema reference is provider-associated", () => {
    const functionEntity = {
      id: "schema-handler",
      entity_type: "function",
      name: "handleSubscription",
      path: "src/types.ts",
      language: "typescript",
      confidence_class: "exact" as const,
    };
    const schemaEntity = {
      id: "subscription-schema",
      entity_type: "schema_reference",
      name: "SubscriptionPayload",
      path: "src/types.ts",
      language: "typescript",
      confidence_class: "structural" as const,
    };
    const sdkCallEntity = {
      id: "stripe-call",
      entity_type: "external_sdk_reference",
      name: "stripe.subscriptions.retrieve",
      path: "src/types.ts",
      language: "typescript",
      confidence_class: "structural" as const,
    };
    const facts = buildImpactGraphFacts(
      input({
        route: "schema_or_contract_change",
        routeTarget: "contract_exposure_analysis",
        dependencySlug: "stripe",
        dependencyName: "Stripe",
        dependencyWebsite: "https://stripe.com",
        changedEntities: ["SubscriptionPayload"],
        entities: [...input().entities, functionEntity, schemaEntity, sdkCallEntity],
        relations: [
          {
            id: "schema-parent",
            from_entity_id: functionEntity.id,
            to_entity_id: schemaEntity.id,
            relation_type: "REFERENCES_SCHEMA",
            confidence_class: "structural",
            evidence_path: "src/types.ts",
            evidence_start_line: 3,
            evidence_start_column: 1,
            evidence_end_line: 3,
            evidence_end_column: 20,
            extractor_type: "test",
          },
          {
            id: "sdk-parent",
            from_entity_id: functionEntity.id,
            to_entity_id: sdkCallEntity.id,
            relation_type: "REFERENCES_EXTERNAL",
            confidence_class: "structural",
            evidence_path: "src/types.ts",
            evidence_start_line: 4,
            evidence_start_column: 1,
            evidence_end_line: 4,
            evidence_end_column: 20,
            extractor_type: "test",
          },
        ],
        references: [
          {
            id: "stripe-call",
            entity_id: sdkCallEntity.id,
            reference_type: "sdk_call",
            normalized_value: "stripe.subscriptions.retrieve",
            path: "src/types.ts",
            start_line: 4,
            start_column: 1,
            end_line: 4,
            end_column: 20,
            confidence_class: "structural",
          },
          {
            id: "subscription-schema-ref",
            entity_id: schemaEntity.id,
            reference_type: "schema",
            normalized_value: "SubscriptionPayload",
            path: "src/types.ts",
            start_line: 3,
            start_column: 1,
            end_line: 3,
            end_column: 20,
            confidence_class: "structural",
          },
        ],
      }),
    );
    expect(facts.assessmentState).toBe("evidence_present");
    expect(facts.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: "CHANGE_AFFECTS_SCHEMA",
          code_reference_id: "subscription-schema-ref",
        }),
      ]),
    );
  });
});
