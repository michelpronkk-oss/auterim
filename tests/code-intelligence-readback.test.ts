import { describe, expect, it } from "vitest";
import {
  assessPartialCauses,
  classifySkipReason,
  externalReferenceEvidenceMatchesSource,
  isSafeReadbackPath,
  persistedCredentialLikeValueCount,
  safeReadbackValue,
  safeSourceSpanMatch,
  relationEvidenceMatchesSource,
} from "@/lib/code-intelligence/readback";
import { analyzeCodeSnapshot } from "@/lib/code-intelligence/analyzer";

describe("bounded Code Intelligence readback", () => {
  it("accepts repository-relative paths and rejects traversal and platform separators", () => {
    expect(isSafeReadbackPath("src/payments/client.ts")).toBe(true);
    expect(isSafeReadbackPath("src/app/api/products/[id]/route.ts")).toBe(true);
    expect(isSafeReadbackPath("scripts/[name].mts")).toBe(true);
    expect(isSafeReadbackPath("scripts/[redacted:abc123].mts")).toBe(process.platform !== "win32");
    expect(isSafeReadbackPath("../.env")).toBe(false);
    expect(isSafeReadbackPath("src/../../.env")).toBe(false);
    expect(isSafeReadbackPath("C:/Windows/win.ini")).toBe(false);
    expect(isSafeReadbackPath("src/control\u0001name.ts")).toBe(false);
    expect(isSafeReadbackPath("src\\client.ts")).toBe(false);
    expect(isSafeReadbackPath("/etc/passwd")).toBe(false);
  });

  it("allowlists normalized structural values and withholds credential-like values", () => {
    expect(safeReadbackValue("package", "@stripe/stripe-js@^4.0.0")).toBe(
      "@stripe/stripe-js@^4.0.0",
    );
    expect(safeReadbackValue("package", "stripe@4.0.0?token=ghp_secret123456789012345")).toBeNull();
    expect(safeReadbackValue("endpoint", "https://api.example.test/v1?api-version=v2")).toBe(
      "https://api.example.test/v1?api-version=v2",
    );
    expect(safeReadbackValue("endpoint", "https://api.example.test/v1?token=secret")).toBeNull();
    expect(
      persistedCredentialLikeValueCount([
        "OPENAI_API_KEY",
        "ghp_12345678901234567890",
        "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
      ]),
    ).toBe(2);
  });

  it("checks package/import facts against exact source without relying on stored line hints", () => {
    const packageJson = '{"dependencies":{"stripe":"^4.0.0"}}';
    expect(safeSourceSpanMatch("package", "stripe@^4.0.0", "package.json", packageJson, 1, 1)).toBe(
      true,
    );
    expect(
      safeSourceSpanMatch("package", "stripe@4.0.0", "package.json", packageJson, 1, 1, [
        {
          path: "package-lock.json",
          source: '{"packages":{"node_modules/stripe":{"version":"4.0.0"}}}',
        },
      ]),
    ).toBe(true);
    expect(
      safeSourceSpanMatch("package", "stripe@9.9.9", "package.json", packageJson, 1, 1, [
        {
          path: "package-lock.json",
          source: '{"packages":{"node_modules/stripe":{"version":"4.0.0"}}}',
        },
      ]),
    ).toBe(false);
    const source = 'const value = 1;\nimport { Stripe } from "stripe";';
    expect(safeSourceSpanMatch("import", "stripe", "src/client.ts", source, 1, 1)).toBe(true);
  });

  it("does not accept package-name mentions outside a manifest dependency section", () => {
    const source = JSON.stringify({
      description: "This project discusses stripe@4.0.0",
      scripts: { note: "stripe is mentioned here" },
    });
    expect(safeSourceSpanMatch("package", "stripe@4.0.0", "package.json", source, 1, 1)).toBe(
      false,
    );
  });

  it("keeps generated-directory coverage explicitly incomplete", () => {
    expect(classifySkipReason("generated_directory:dist", "dist")).toBe("OTHER_INCOMPLETE");
    expect(
      assessPartialCauses([{ reason: "generated_directory:dist", path: "dist" }]).causes[0]
        ?.classification,
    ).toBe("OTHER_INCOMPLETE");
  });

  it("classifies explicit source bounds and expected security exclusions separately", () => {
    expect(classifySkipReason("file_size_limit", "src/large.ts")).toBe(
      "SUPPORTED_SOURCE_COVERAGE_GAP",
    );
    expect(classifySkipReason("environment_file_excluded", ".env.local")).toBe(
      "EXPECTED_SECURITY_SKIP",
    );
  });

  it("proves source provenance for each emitted relation type", () => {
    const source = [
      'import Stripe from "stripe";',
      "function target() {}",
      "function run(event: { type: string }) {",
      '  const stripe = new Stripe("test");',
      '  stripe.webhooks.constructEvent("payload", "signature", "secret");',
      "  if (`customer.subscription.updated` === event.type) {",
      '    fetch("https://api.example.test/v1/items");',
      "  }",
      "  const key = process.env.STRIPE_API_KEY;",
      "  const schema: PaymentSchema = {} as PaymentSchema;",
      "  target();",
      "}",
    ].join("\n");
    const analysis = analyzeCodeSnapshot([
      { path: "src/payment.ts", text: source, size: Buffer.byteLength(source) },
      {
        path: "package.json",
        text: JSON.stringify({ dependencies: { stripe: "^18.0.0" } }),
        size: 52,
      },
    ]);
    const entities = new Map(analysis.entities.map((entity) => [entity.entityKey, entity]));
    for (const reference of analysis.externalReferences.filter(
      (item) => item.path === "src/payment.ts",
    )) {
      expect(
        externalReferenceEvidenceMatchesSource({ ...reference, source }),
        `${reference.referenceType} ${reference.path}:${reference.startLine}`,
      ).toBe(true);
    }
    const present = new Set(analysis.relations.map((relation) => relation.relationType));
    const required = [
      "FILE_CONTAINS_SYMBOL",
      "IMPORTS_PACKAGE",
      "IMPORTS_SYMBOL",
      "CALLS_SYMBOL",
      "REFERENCES_EXTERNAL",
      "USES_ENV_NAME",
      "HANDLES_EVENT",
      "CALLS_ENDPOINT",
      "REFERENCES_SCHEMA",
    ];
    for (const type of required) expect([...present], type).toContain(type);
    for (const relation of analysis.relations) {
      const from = entities.get(relation.fromEntityKey)!;
      const to = entities.get(relation.toEntityKey)!;
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(relation.evidencePath).toBe("src/payment.ts");
      expect(relation.evidenceStartColumn).toBeGreaterThan(0);
      expect(relation.evidenceEndColumn).toBeGreaterThan(0);
      expect(relation.extractorType).toContain("typescript-compiler-api");
      const expectedConfidence = {
        FILE_CONTAINS_SYMBOL: "structural",
        IMPORTS_PACKAGE: "exact",
        IMPORTS_SYMBOL: "exact",
        CALLS_SYMBOL: "heuristic",
        REFERENCES_EXTERNAL: "structural",
        USES_ENV_NAME: "exact",
        HANDLES_EVENT: "structural",
        CALLS_ENDPOINT: "exact",
        REFERENCES_SCHEMA: "structural",
      }[relation.relationType];
      if (expectedConfidence) expect(relation.confidenceClass).toBe(expectedConfidence);
      const matchingReference = analysis.externalReferences.find(
        (reference) =>
          reference.entityKey === relation.toEntityKey &&
          reference.path === relation.evidencePath &&
          reference.extractorType === relation.extractorType,
      );
      const matchingExternalReference = matchingReference
        ? {
            referenceType: matchingReference.referenceType,
            normalizedValue: matchingReference.normalizedValue,
            redacted: matchingReference.redacted,
            startColumn: matchingReference.startColumn,
            endColumn: matchingReference.endColumn,
          }
        : null;
      expect(
        relationEvidenceMatchesSource({
          relationType: relation.relationType,
          path: relation.evidencePath,
          startLine: relation.evidenceStartLine,
          startColumn: relation.evidenceStartColumn,
          endLine: relation.evidenceEndLine,
          endColumn: relation.evidenceEndColumn,
          extractorType: relation.extractorType,
          from: {
            entity_type: from.entityType,
            name: from.name,
            path: from.path,
            start_line: from.startLine,
            end_line: from.endLine,
          },
          to: {
            entity_type: to.entityType,
            name: to.name,
            path: to.path,
            start_line: to.startLine,
            end_line: to.endLine,
          },
          matchingTargetDeclarations: analysis.entities.filter(
            (entity) =>
              entity.path === to.path &&
              entity.entityType === to.entityType &&
              entity.name === to.name &&
              ["function", "method", "class"].includes(entity.entityType),
          ).length,
          source,
          matchingExternalReference,
        }),
        `${relation.relationType} ${relation.evidencePath}:${relation.evidenceStartLine}`,
      ).toBe(true);
      if (matchingExternalReference && relation.relationType !== "USES_ENV_NAME") {
        expect(
          relationEvidenceMatchesSource({
            relationType: relation.relationType,
            path: relation.evidencePath,
            startLine: relation.evidenceStartLine,
            startColumn: relation.evidenceStartColumn,
            endLine: relation.evidenceEndLine,
            endColumn: relation.evidenceEndColumn,
            extractorType: relation.extractorType,
            from: {
              entity_type: from.entityType,
              name: from.name,
              path: from.path,
              start_line: from.startLine,
              end_line: from.endLine,
            },
            to: {
              entity_type: to.entityType,
              name: to.name,
              path: to.path,
              start_line: to.startLine,
              end_line: to.endLine,
            },
            matchingTargetDeclarations: 1,
            source,
            matchingExternalReference: {
              ...matchingExternalReference,
              normalizedValue: `${matchingExternalReference.normalizedValue}.unrelated`,
            },
          }),
          relation.relationType,
        ).toBe(false);
      }
      if (relation.relationType === "REFERENCES_EXTERNAL") {
        expect(
          relationEvidenceMatchesSource({
            relationType: relation.relationType,
            path: relation.evidencePath,
            startLine: relation.evidenceStartLine,
            startColumn: relation.evidenceStartColumn,
            endLine: relation.evidenceEndLine,
            endColumn: relation.evidenceEndColumn,
            extractorType: relation.extractorType,
            from: {
              entity_type: from.entityType,
              name: from.name,
              path: from.path,
              start_line: from.startLine,
              end_line: from.endLine,
            },
            to: {
              entity_type: to.entityType,
              name: "unrelated.responses.create",
              path: to.path,
              start_line: to.startLine,
              end_line: to.endLine,
            },
            matchingTargetDeclarations: 1,
            source,
            matchingExternalReference: {
              referenceType: "sdk_call",
              normalizedValue: "unrelated.responses.create",
              redacted: false,
            },
          }),
        ).toBe(false);
      }
      if (relation.relationType === "IMPORTS_PACKAGE" && from.entityType === "file") {
        expect(
          relationEvidenceMatchesSource({
            relationType: relation.relationType,
            path: relation.evidencePath,
            startLine: relation.evidenceStartLine,
            startColumn: relation.evidenceStartColumn,
            endLine: relation.evidenceEndLine,
            endColumn: relation.evidenceEndColumn,
            extractorType: relation.extractorType,
            from: {
              entity_type: from.entityType,
              name: from.name,
              path: from.path,
              start_line: from.startLine,
              end_line: from.endLine,
            },
            to: {
              entity_type: "schema_reference",
              name: "unrelated-package",
              path: to.path,
              start_line: to.startLine,
              end_line: to.endLine,
            },
            matchingTargetDeclarations: 1,
            source,
            matchingExternalReference: {
              referenceType: "import",
              normalizedValue: "unrelated-package",
              redacted: false,
            },
          }),
        ).toBe(false);
      }
      if (relation.relationType === "CALLS_SYMBOL") {
        const sourceLines = source.split("\n");
        const callSite = sourceLines[relation.evidenceStartLine - 1]!.slice(
          relation.evidenceStartColumn - 1,
          relation.evidenceEndColumn - 1,
        );
        expect(callSite).toBe("target()");
        expect(
          relationEvidenceMatchesSource({
            relationType: relation.relationType,
            path: relation.evidencePath,
            startLine: relation.evidenceStartLine,
            startColumn: relation.evidenceStartColumn,
            endLine: relation.evidenceEndLine,
            endColumn: relation.evidenceEndColumn,
            extractorType: relation.extractorType,
            from: {
              entity_type: from.entityType,
              name: from.name,
              path: from.path,
              start_line: from.startLine,
              end_line: from.endLine,
            },
            to: {
              entity_type: to.entityType,
              name: to.name,
              path: to.path,
              start_line: relation.evidenceStartLine,
              end_line: relation.evidenceEndLine,
            },
            matchingTargetDeclarations: 1,
            source,
            matchingExternalReference,
          }),
        ).toBe(false);
        expect(
          relationEvidenceMatchesSource({
            relationType: relation.relationType,
            path: relation.evidencePath,
            startLine: relation.evidenceStartLine,
            startColumn: relation.evidenceStartColumn + 1,
            endLine: relation.evidenceEndLine,
            endColumn: relation.evidenceEndColumn,
            extractorType: relation.extractorType,
            from: {
              entity_type: from.entityType,
              name: from.name,
              path: from.path,
              start_line: from.startLine,
              end_line: from.endLine,
            },
            to: {
              entity_type: to.entityType,
              name: to.name,
              path: to.path,
              start_line: to.startLine,
              end_line: to.endLine,
            },
            matchingTargetDeclarations: 1,
            source,
            matchingExternalReference,
          }),
        ).toBe(false);
      }
    }
  });

  it("binds imported-symbol relations to the exact source module specifier", () => {
    const source = 'import { Stripe as PaymentStripe } from "stripe";';
    const result = analyzeCodeSnapshot([
      { path: "src/client.ts", text: source, size: Buffer.byteLength(source) },
    ]);
    const relation = result.relations.find((item) => item.relationType === "IMPORTS_SYMBOL");
    expect(relation).toBeDefined();
    if (!relation) throw new Error("expected_imports_symbol_relation");
    const entities = new Map(result.entities.map((item) => [item.entityKey, item]));
    const from = entities.get(relation.fromEntityKey)!;
    const to = entities.get(relation.toEntityKey)!;
    const input = {
      relationType: relation.relationType,
      path: relation.evidencePath,
      startLine: relation.evidenceStartLine,
      startColumn: relation.evidenceStartColumn,
      endLine: relation.evidenceEndLine,
      endColumn: relation.evidenceEndColumn,
      extractorType: relation.extractorType,
      from: {
        entity_type: from.entityType,
        name: from.name,
        path: from.path,
        start_line: from.startLine,
        end_line: from.endLine,
      },
      to: {
        entity_type: to.entityType,
        name: to.name,
        path: to.path,
        start_line: to.startLine,
        end_line: to.endLine,
      },
      matchingTargetDeclarations: 0,
      source,
      matchingExternalReference: null,
    };
    expect(relationEvidenceMatchesSource(input)).toBe(true);
    expect(
      relationEvidenceMatchesSource({
        ...input,
        from: { ...input.from, name: "stripe/other" },
      }),
    ).toBe(false);
  });

  it("does not attribute an unrelated dynamic call as an endpoint reference", () => {
    const source = "fetch(endpoint);";
    const result = analyzeCodeSnapshot([
      { path: "src/client.ts", text: source, size: Buffer.byteLength(source) },
    ]);
    const reference = result.externalReferences.find(
      (item) => item.referenceType === "dynamic_endpoint",
    );
    expect(reference).toBeDefined();
    if (!reference) throw new Error("expected_dynamic_endpoint_reference");
    expect(externalReferenceEvidenceMatchesSource({ ...reference, source })).toBe(true);
    expect(
      externalReferenceEvidenceMatchesSource({ ...reference, source: "other(endpoint);" }),
    ).toBe(false);
  });

  it("binds redacted endpoint relation evidence to the exact persisted call occurrence", () => {
    const source = 'fetch("https://user:pw@api.example.test/v1");';
    const reference = analyzeCodeSnapshot([
      { path: "src/client.ts", text: source },
    ]).externalReferences.find((item) => item.referenceType === "endpoint");
    expect(reference).toBeDefined();
    if (!reference) throw new Error("expected_redacted_endpoint_reference");
    const input = {
      relationType: "CALLS_ENDPOINT",
      path: "src/client.ts",
      startLine: 1,
      startColumn: reference.startColumn!,
      endLine: 1,
      endColumn: reference.endColumn!,
      extractorType: "typescript-compiler-api:endpoint-v1",
      from: {
        entity_type: "module",
        name: "src/client",
        path: "src/client.ts",
        start_line: 1,
        end_line: 1,
      },
      to: {
        entity_type: "http_endpoint_reference",
        name: "[redacted]",
        path: "src/client.ts",
        start_line: 1,
        end_line: 1,
      },
      matchingTargetDeclarations: 0,
      source,
      matchingExternalReference: {
        referenceType: "endpoint",
        normalizedValue: "[redacted]",
        redacted: true,
        startColumn: reference.startColumn!,
        endColumn: reference.endColumn!,
      },
    } as const;
    expect(relationEvidenceMatchesSource(input)).toBe(true);
    expect(
      relationEvidenceMatchesSource({
        ...input,
        matchingExternalReference: { ...input.matchingExternalReference, startColumn: 2 },
      }),
    ).toBe(false);
  });
});
