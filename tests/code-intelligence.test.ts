import { describe, expect, it } from "vitest";
import {
  analyzeCodeSnapshot,
  CODE_SCAN_LIMITS,
  createCodeAnalysisIdempotencyKey,
  shouldAnalyzeRouteTarget,
} from "@/lib/code-intelligence/analyzer";
import { CODE_INTELLIGENCE_GOLDEN_CORPUS } from "./fixtures/code-intelligence/golden-corpus";

const byType = (files: Parameters<typeof analyzeCodeSnapshot>[0], type: string) =>
  analyzeCodeSnapshot(files)
    .externalReferences.filter((reference) => reference.referenceType === type)
    .map((reference) => reference.normalizedValue);

function metrics(expected: string[], actual: string[]) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  let truePositive = 0;
  for (const value of actualSet) if (expectedSet.has(value)) truePositive += 1;
  const precision =
    actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositive / actualSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositive / expectedSet.size;
  return { precision, recall };
}

describe("deterministic code intelligence", () => {
  it("extracts labeled package/import/SDK/event/endpoint facts with fixture metrics", () => {
    const categories = [
      ["packages", "package"],
      ["imports", "import"],
      ["sdkCalls", "sdk_call"],
      ["events", "event"],
      ["endpoints", "endpoint"],
    ] as const;
    const reports = Object.fromEntries(
      categories.map(([expectedKey, referenceType]) => {
        const expected = CODE_INTELLIGENCE_GOLDEN_CORPUS.flatMap(
          (fixture) => fixture.expected[expectedKey] ?? [],
        );
        const actual = CODE_INTELLIGENCE_GOLDEN_CORPUS.flatMap((fixture) =>
          byType(fixture.files, referenceType),
        );
        const result = metrics(expected, actual);
        expect(result.precision, `${expectedKey} precision`).toBeGreaterThanOrEqual(0.95);
        expect(result.recall, `${expectedKey} recall`).toBeGreaterThanOrEqual(0.95);
        return [expectedKey, result];
      }),
    );
    expect(reports).toMatchObject({
      packages: { precision: 1, recall: 1 },
      imports: { precision: 1, recall: 1 },
      sdkCalls: { precision: 1, recall: 1 },
      events: { precision: 1, recall: 1 },
      endpoints: { precision: 1, recall: 1 },
    });
    const dynamicCount = CODE_INTELLIGENCE_GOLDEN_CORPUS.flatMap((fixture) =>
      byType(fixture.files, "dynamic_endpoint"),
    ).length;
    expect(dynamicCount).toBe(1);
  });

  it("separates declared, imported, and called package evidence", () => {
    const result = analyzeCodeSnapshot([
      { path: "package.json", text: '{"dependencies":{"stripe":"^1.0.0","openai":"^2.0.0"}}' },
      {
        path: "package-lock.json",
        text: '{"lockfileVersion":3,"packages":{"":{"dependencies":{"stripe":"^1.0.0"}},"node_modules/stripe":{"version":"1.4.2"}}}',
      },
      {
        path: "src/payment.ts",
        text: 'import Stripe from "stripe"; const stripe = new Stripe({}); stripe.webhooks.constructEvent(a,b,c);',
      },
    ]);
    expect(
      result.externalReferences
        .filter((item) => item.referenceType === "package")
        .map((item) => item.normalizedValue),
    ).toEqual(["openai@^2.0.0", "stripe@1.4.2"]);
    expect(
      byType(
        [
          {
            path: "src/payment.ts",
            text: 'import Stripe from "stripe"; const stripe = new Stripe({}); stripe.webhooks.constructEvent(a,b,c);',
          },
        ],
        "import",
      ),
    ).toContain("stripe");
    expect(
      byType(
        [
          {
            path: "src/payment.ts",
            text: 'import Stripe from "stripe"; const stripe = new Stripe({}); stripe.webhooks.constructEvent(a,b,c);',
          },
        ],
        "sdk_call",
      ),
    ).toContain("stripe.webhooks.constructEvent");
  });

  it("recognizes HTTP client calls without treating ordinary getters as endpoints", () => {
    const result = analyzeCodeSnapshot([
      {
        path: "src/requests.ts",
        text: [
          'import axios from "axios";',
          'const code = new URLSearchParams("code=abc").get("code");',
          'const value = config.get("endpoint");',
          'axios.get("https://api.example.test/v1/items");',
          "fetch(dynamicUrl);",
        ].join("\n"),
      },
    ]);

    expect(result.externalReferences.filter((item) => item.referenceType === "endpoint")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedValue: "https://api.example.test/v1/items" }),
      ]),
    );
    expect(
      result.externalReferences.filter((item) => item.referenceType === "dynamic_endpoint"),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ normalizedValue: "[dynamic]" })]));
    expect(
      result.externalReferences.filter(
        (item) => item.referenceType === "dynamic_endpoint" && item.normalizedValue !== "[dynamic]",
      ),
    ).toEqual([]);
  });

  it("records source-backed containment and only same-file call candidates", () => {
    const result = analyzeCodeSnapshot([
      { path: "src/a.ts", text: "export function runJob() { return 1; } runJob();" },
      {
        path: "src/b.ts",
        text: 'import { runJob } from "./a"; export const invoke = () => runJob();',
      },
    ]);
    expect(
      result.entities.some(
        (entity) => entity.entityType === "function" && entity.name === "runJob",
      ),
    ).toBe(true);
    expect(
      result.relations.some((relation) => relation.relationType === "FILE_CONTAINS_SYMBOL"),
    ).toBe(true);
    const call = result.relations.find((relation) => relation.relationType === "CALLS_SYMBOL");
    expect(call).toMatchObject({
      evidencePath: "src/a.ts",
      evidenceStartLine: 1,
      evidenceEndLine: 1,
      extractorType: "typescript-compiler-api:same-file-call-site-v2",
      confidenceClass: "heuristic",
    });
    expect(
      result.relations.every((relation) =>
        Boolean(
          relation.evidencePath &&
          relation.evidenceStartLine > 0 &&
          relation.evidenceEndLine >= relation.evidenceStartLine &&
          relation.extractorType,
        ),
      ),
    ).toBe(true);
    const sdkImport = analyzeCodeSnapshot([
      {
        path: "src/provider.ts",
        text: 'import { OpenAI as Client } from "openai"; new Client({});',
      },
    ]);
    expect(sdkImport.relations.some((relation) => relation.relationType === "IMPORTS_SYMBOL")).toBe(
      true,
    );
  });

  it("finds class methods, arrow wrappers, nested SDK members, and package subpaths structurally", () => {
    const source =
      'import Stripe from "stripe";\nimport { Responses as ResponsesApi } from "openai/resources/responses";\nconst stripe = new Stripe({});\nexport const wrapped = (input: unknown) => stripe.webhooks.constructEvent(input, a, b);\nclass AiService { create() { return ResponsesApi.create({}); } }';
    const result = analyzeCodeSnapshot([{ path: "src/client.ts", text: source }]);
    expect(
      result.entities.some(
        (entity) => entity.entityType === "class" && entity.name === "AiService",
      ),
    ).toBe(true);
    expect(
      result.entities.some((entity) => entity.entityType === "method" && entity.name === "create"),
    ).toBe(true);
    expect(
      result.entities.some(
        (entity) => entity.entityType === "function" && entity.name === "wrapped",
      ),
    ).toBe(true);
    expect(byType([{ path: "src/client.ts", text: source }], "sdk_call")).toEqual(
      expect.arrayContaining([
        "stripe.webhooks.constructEvent",
        "openai.resources.responses.create",
      ]),
    );
  });

  it("resolves destructured CommonJS imports and their nested SDK member calls", () => {
    const result = analyzeCodeSnapshot([
      {
        path: "src/legacy.cjs",
        text: 'const { webhooks: webhookApi } = require("stripe"); webhookApi.constructEvent(payload, sig, secret);',
      },
    ]);
    expect(
      byType(
        [
          {
            path: "src/legacy.cjs",
            text: 'const { webhooks: webhookApi } = require("stripe"); webhookApi.constructEvent(payload, sig, secret);',
          },
        ],
        "sdk_call",
      ),
    ).toContain("stripe.webhooks.constructEvent");
    expect(result.relations.some((relation) => relation.relationType === "IMPORTS_SYMBOL")).toBe(
      true,
    );
  });

  it("keeps package, import, and method-use evidence at separate strengths across files", () => {
    const result = analyzeCodeSnapshot([
      { path: "package.json", text: '{"dependencies":{"stripe":"^1.0.0","openai":"^2.0.0"}}' },
      {
        path: "src/a.ts",
        text: 'import Stripe from "stripe"; export const client = new Stripe({});',
      },
      { path: "src/b.ts", text: 'import Stripe from "stripe"; export const another = Stripe;' },
      { path: "src/c.ts", text: 'import OpenAI from "openai"; const unused = OpenAI;' },
    ]);
    expect(
      result.externalReferences.filter((item) => item.referenceType === "package"),
    ).toHaveLength(2);
    expect(
      result.externalReferences.filter(
        (item) => item.referenceType === "import" && item.normalizedValue === "stripe",
      ),
    ).toHaveLength(2);
    expect(
      result.externalReferences.filter((item) => item.referenceType === "sdk_call"),
    ).toHaveLength(0);
  });

  it("does not classify documentation comments or unguarded event strings as code usage", () => {
    const result = analyzeCodeSnapshot([
      {
        path: "src/noise.ts",
        text: '// openai Stripe customer.subscription.updated\nconst text = "customer.subscription.updated";\nexport function f() { return text; }',
      },
    ]);
    expect(result.externalReferences.filter((item) => item.referenceType === "event")).toHaveLength(
      0,
    );
    expect(
      result.externalReferences.filter((item) => item.referenceType === "sdk_call"),
    ).toHaveLength(0);
  });

  it("persists names only for environment variables and redacts secret-looking literals", () => {
    const result = analyzeCodeSnapshot([
      {
        path: "src/config.ts",
        text: 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\nexport const key = process.env.OPENAI_API_KEY;\nfetch("https://example.test/api?token=sk_live_12345678901234567890");',
      },
    ]);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(encoded).not.toContain("sk_live_12345678901234567890");
    expect(
      byType(
        [{ path: "src/config.ts", text: "export const key = process.env.OPENAI_API_KEY;" }],
        "environment_variable",
      ),
    ).toEqual(["OPENAI_API_KEY"]);
  });

  it("redacts credential-like endpoint path segments and records aggregate scan byte skips", () => {
    const secretPath = "Q7x9B2m4K6p8R1t3V5w0Y2z4A6c8D1f3";
    const secretIdentifier = "credential_Q7x9B2m4K6p8R1t3V5w0Y2z4A6c8D1f3";
    const endpointResult = analyzeCodeSnapshot([
      {
        path: `src/${secretPath}.ts`,
        text: `fetch("https://api.example.test/v1/${secretPath}"); export function ${secretIdentifier}() { return true; }`,
      },
    ]);
    expect(JSON.stringify(endpointResult)).not.toContain(secretPath);
    expect(JSON.stringify(endpointResult)).not.toContain(secretIdentifier);
    expect(endpointResult.externalReferences).toContainEqual(
      expect.objectContaining({
        referenceType: "endpoint",
        normalizedValue: "[redacted]",
        redacted: true,
      }),
    );

    const byteLimited = analyzeCodeSnapshot([
      {
        path: "src/limited.ts",
        text: "",
        size: 1,
        skipReason: "repository_byte_limit",
      },
      { path: "src/visible.ts", text: "export const visible = true;" },
    ]);
    expect(byteLimited.coverageState).toBe("partial");
    expect(byteLimited.skippedFiles).toContainEqual(
      expect.objectContaining({ reason: "repository_byte_limit" }),
    );
  });

  it("extracts schema references and never persists secret-shaped package identifiers", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = analyzeCodeSnapshot([
      {
        path: "package.json",
        text: JSON.stringify({
          dependencies: {
            [`stripe-${secret}`]: "^1.0.0",
            privateClient: "https://user:password@registry.example/pkg",
          },
        }),
      },
      {
        path: "src/schema.ts",
        text: `import client from "${secret}"; type Request = PaymentRequestSchema; export type Body = Request;`,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(
      byType([{ path: "src/schema.ts", text: "type Request = PaymentRequestSchema;" }], "schema"),
    ).toContain("PaymentRequestSchema");
  });

  it("reports skipped, unsupported, and parse-failed coverage without claiming clean absence", () => {
    const result = analyzeCodeSnapshot([
      { path: "src/bad.ts", text: "export const = ;" },
      { path: "worker.py", text: "import openai" },
      { path: "dist/bundle.js", text: "fetch('https://hidden.example')" },
      { path: "src/large.ts", text: "x".repeat(CODE_SCAN_LIMITS.maxFileBytes + 1) },
      { path: ".env.local", text: "SHOULD_NOT_BE_READ_OR_PERSISTED=secret" },
      { path: "image.png", text: "", binary: true, size: 512 },
    ]);
    expect(result.coverageState).toBe("partial");
    expect(result.parseFailures).toBeGreaterThan(0);
    expect(result.skippedFiles.map((file) => file.reason)).toEqual(
      expect.arrayContaining([
        "unsupported_language",
        "generated_directory:dist",
        "file_size_limit",
        "environment_file_excluded",
        "binary_or_non_source",
        "parse_failed",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_BE_READ_OR_PERSISTED");
    expect(analyzeCodeSnapshot([{ path: "only/python.py", text: "print(1)" }]).coverageState).toBe(
      "unsupported",
    );
    expect(analyzeCodeSnapshot([]).coverageState).toBe("unsupported");
  });

  it("marks malformed and oversized manifests or lockfiles as incomplete", () => {
    expect(
      analyzeCodeSnapshot([
        { path: "package.json", text: "{ malformed" },
        { path: "src/a.ts", text: "export const a = 1;" },
      ]),
    ).toMatchObject({
      coverageState: "partial",
      skippedFiles: [expect.objectContaining({ reason: "manifest_parse_failed" })],
    });
    expect(
      analyzeCodeSnapshot([
        { path: "package.json", text: '{"dependencies":{"stripe":"^1"}}' },
        {
          path: "package-lock.json",
          text: "x".repeat(CODE_SCAN_LIMITS.maxManifestBytes + 1),
          size: CODE_SCAN_LIMITS.maxManifestBytes + 1,
        },
        { path: "src/a.ts", text: "export const a = 1;" },
      ]),
    ).toMatchObject({
      coverageState: "partial",
      skippedFiles: [expect.objectContaining({ reason: "lockfile_size_limit" })],
    });
  });

  it("bounds repository bytes and file count as partial analysis", () => {
    const tooMany = Array.from({ length: CODE_SCAN_LIMITS.maxFiles + 2 }, (_, i) => ({
      path: `src/${String(i).padStart(3, "0")}.ts`,
      text: "export const value = 1;",
    }));
    expect(analyzeCodeSnapshot(tooMany).coverageState).toBe("partial");
    const tooLarge = [
      {
        path: "src/a.ts",
        text: "x".repeat(CODE_SCAN_LIMITS.maxRepositoryBytes + 1),
        size: CODE_SCAN_LIMITS.maxRepositoryBytes + 1,
      },
    ];
    expect(analyzeCodeSnapshot(tooLarge).coverageState).toBe("partial");
  });

  it("marks truncated filesystem collection and pruned generated directories incomplete", () => {
    const truncated = analyzeCodeSnapshot([
      { path: "src/a.ts", text: "export const a = 1;" },
      { path: "[repository]", text: "", collectionTruncated: true },
    ]);
    expect(truncated.coverageState).toBe("partial");
    expect(truncated.filesDiscovered).toBe(1);
    expect(truncated.skippedFiles).toContainEqual(
      expect.objectContaining({ reason: "traversal_entry_limit" }),
    );

    const pruned = analyzeCodeSnapshot([
      { path: "src/a.ts", text: "export const a = 1;" },
      {
        path: "node_modules",
        text: "",
        directorySkipReason: "generated_directory:node_modules",
      },
      { path: ".next", text: "", directorySkipReason: "generated_directory:_next" },
    ]);
    expect(pruned.coverageState).toBe("partial");
    expect(pruned.filesDiscovered).toBe(1);
    expect(pruned.skippedFiles.map((file) => file.reason)).toEqual(
      expect.arrayContaining(["generated_directory:node_modules", "generated_directory:_next"]),
    );
  });

  it("reuses exact repository commit analysis identity and excludes mutable refs", () => {
    const base = { repositoryId: "repo-id", commitSha: "a".repeat(40) };
    expect(createCodeAnalysisIdempotencyKey(base)).toBe(createCodeAnalysisIdempotencyKey(base));
    expect(createCodeAnalysisIdempotencyKey(base)).not.toBe(
      createCodeAnalysisIdempotencyKey({ ...base, analyzerVersion: "code-intelligence-v3" }),
    );
    expect(createCodeAnalysisIdempotencyKey(base)).not.toBe(
      createCodeAnalysisIdempotencyKey({ ...base, analysisProfile: "other-profile" }),
    );
    expect(() => createCodeAnalysisIdempotencyKey({ ...base, commitSha: "main" })).toThrow(
      /commit_sha_invalid/,
    );
  });

  it("produces identical coverage and fact identities for the same ordered 430-file snapshot", () => {
    const files = Array.from({ length: 430 }, (_, index) => ({
      path: `src/file-${String(index).padStart(3, "0")}.ts`,
      text: `export function item${index}() { return ${index}; }`,
    })).reverse();
    const first = analyzeCodeSnapshot(files);
    const second = analyzeCodeSnapshot([...files].reverse());
    expect(first.supportedFilesDiscovered).toBe(430);
    expect(first.supportedFilesAnalyzed).toBe(430);
    expect(first.supportedFilesSkippedByBound).toBe(0);
    expect(first.coverageState).toBe("complete");
    expect(first.entities.map((row) => row.entityKey)).toEqual(
      second.entities.map((row) => row.entityKey),
    );
    expect(first.relations.map((row) => row.extractorType)).toEqual(
      second.relations.map((row) => row.extractorType),
    );
  });

  it("uses deterministic file and byte bounds and records unsupported coverage", () => {
    const overFileLimit = Array.from({ length: CODE_SCAN_LIMITS.maxFiles + 1 }, (_, index) => ({
      path: `src/${String(index).padStart(4, "0")}.ts`,
      text: `export const value${index} = ${index};`,
    }));
    const fileBound = analyzeCodeSnapshot(overFileLimit);
    expect(fileBound.supportedFilesDiscovered).toBe(CODE_SCAN_LIMITS.maxFiles + 1);
    expect(fileBound.supportedFilesAnalyzed).toBe(CODE_SCAN_LIMITS.maxFiles);
    expect(fileBound.supportedFilesSkippedByBound).toBe(1);
    expect(fileBound.coverageReasonCounts.file_count_limit).toBe(1);
    expect(fileBound.coverageState).toBe("partial");

    const exactBytes = Array.from({ length: 40 }, (_, index) => ({
      path: `src/${String(index).padStart(2, "0")}.ts`,
      text: "x".repeat(250_000),
    }));
    const exactBound = analyzeCodeSnapshot(exactBytes);
    expect(exactBound.supportedFilesAnalyzed).toBe(40);
    expect(exactBound.coverageState).toBe("complete");
    const overBytes = [...exactBytes, { path: "src/zz.ts", text: "x" }];
    const byteBound = analyzeCodeSnapshot(overBytes);
    expect(byteBound.coverageReasonCounts.repository_byte_limit).toBe(1);
    expect(byteBound.coverageState).toBe("partial");

    const unsupported = analyzeCodeSnapshot([{ path: "src/main.py", text: "print('x')" }]);
    expect(unsupported.unsupportedLanguageFiles).toBe(1);
    expect(unsupported.coverageState).toBe("unsupported");

    const invalidEncoding = analyzeCodeSnapshot([
      { path: "src/undecodable.ts", text: "", skipReason: "invalid_encoding" },
    ]);
    expect(invalidEncoding.supportedFilesDiscovered).toBe(1);
    expect(invalidEncoding.supportedFilesAnalyzed).toBe(0);
    expect(invalidEncoding.coverageReasonCounts.invalid_encoding).toBe(1);
    expect(invalidEncoding.coverageState).toBe("partial");

    for (const sourceFile of [
      { path: "src/nul.ts", text: "const value = '\0';" },
      { path: "src/binary.ts", text: "", binary: true },
    ]) {
      const omittedSource = analyzeCodeSnapshot([sourceFile]);
      expect(omittedSource.coverageState).toBe("partial");
      expect(omittedSource.supportedFilesDiscovered).toBe(1);
      expect(omittedSource.supportedFilesAnalyzed).toBe(0);
      expect(omittedSource.coverageReasonCounts.binary_or_non_source).toBe(1);
    }
  });

  it("marks deeply nested syntax incomplete without recursive AST traversal", () => {
    const nested = `${"(".repeat(CODE_SCAN_LIMITS.maxAstDepth + 10)}1${")".repeat(
      CODE_SCAN_LIMITS.maxAstDepth + 10,
    )}`;
    const result = analyzeCodeSnapshot([{ path: "src/deep.ts", text: `const value = ${nested};` }]);
    expect(result.coverageState).toBe("partial");
    expect(result.coverageReasonCounts.ast_depth_limit).toBe(1);
    expect(result.supportedFilesAnalyzed).toBe(0);
  });

  it("fails closed at the deterministic intermediate fact budget", () => {
    const files = Array.from({ length: 17 }, (_, fileIndex) => ({
      path: `src/endpoint-${String(fileIndex).padStart(2, "0")}.ts`,
      text: Array.from({ length: 1_000 }, () => 'fetch("https://api.example.com/v1/items");').join(
        "\n",
      ),
    }));
    expect(() => analyzeCodeSnapshot(files)).toThrow("code_intelligence_stage_failed");
  });

  it("allows only code-intelligence-eligible pending route families", () => {
    const eligible = [
      "dependency_product_impact",
      "dependency_impact_repository_exposure_candidate",
      "contract_exposure_analysis",
      "repository_dependency_exposure_analysis",
      "contract_repository_exposure_analysis",
      "integration_auth_risk_analysis",
    ];
    for (const target of eligible) expect(shouldAnalyzeRouteTarget(target)).toBe(true);
    for (const target of [
      "evidence_escalation",
      "commercial_impact_analysis",
      "capacity_risk_analysis",
      "product_relevance_analysis",
      "runtime_risk_analysis_candidate",
      "provider_policy_review",
      "suppress_archive",
    ])
      expect(shouldAnalyzeRouteTarget(target)).toBe(false);
  });
});
