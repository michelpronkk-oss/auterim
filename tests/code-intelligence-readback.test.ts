import { describe, expect, it } from "vitest";
import {
  assessPartialCauses,
  classifySkipReason,
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
    expect(isSafeReadbackPath("../.env")).toBe(false);
    expect(isSafeReadbackPath("src\\client.ts")).toBe(false);
    expect(isSafeReadbackPath("/etc/passwd")).toBe(false);
  });

  it("allowlists normalized structural values and withholds credential-like values", () => {
    expect(safeReadbackValue("package", "@stripe/stripe-js@^4.0.0")).toBe(
      "@stripe/stripe-js@^4.0.0",
    );
    expect(safeReadbackValue("package", "stripe@4.0.0?token=ghp_secret123456789012345")).toBeNull();
    expect(safeReadbackValue("endpoint", "https://api.example.test/v1?token=secret")).toBe(
      "https://api.example.test/v1",
    );
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
    expect(safeSourceSpanMatch("package", "stripe@4.0.0", "package.json", packageJson, 1, 1)).toBe(
      true,
    );
    const source = 'const value = 1;\nimport { Stripe } from "stripe";';
    expect(safeSourceSpanMatch("import", "stripe", "src/client.ts", source, 1, 1)).toBe(true);
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
      '  if (event.type === "customer.subscription.updated") {',
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
      const matchingExternalReference = analysis.externalReferences.some(
        (reference) =>
          reference.entityKey === relation.toEntityKey &&
          reference.path === relation.evidencePath &&
          reference.startLine === relation.evidenceStartLine &&
          reference.endLine === relation.evidenceEndLine &&
          reference.extractorType === relation.extractorType,
      );
      expect(
        relationEvidenceMatchesSource({
          relationType: relation.relationType,
          path: relation.evidencePath,
          startLine: relation.evidenceStartLine,
          endLine: relation.evidenceEndLine,
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
      if (relation.relationType === "CALLS_SYMBOL") {
        expect(
          relationEvidenceMatchesSource({
            relationType: relation.relationType,
            path: relation.evidencePath,
            startLine: relation.evidenceStartLine,
            endLine: relation.evidenceEndLine,
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
      }
    }
  });
});
