import { describe, expect, it } from "vitest";
import {
  CLAIM_LEVELS,
  COVERAGE_DIMENSIONS,
  COVERAGE_STATES,
  type CoverageDimension,
  type CoverageState,
  type SubjectEvaluation,
} from "@/lib/coverage-certification/contracts";
import {
  assessExposure,
  buildCertificate,
  claimLevelAt,
  claimLevelFor,
  evaluateDependencySources,
  evaluateDeploymentExposure,
  evaluateRepositoryCode,
  evaluateRuntimeSignals,
  NEGATIVE_ASSESSMENT_PROFILE,
  weakestState,
} from "@/lib/coverage-certification/evaluate";
import { protectionClaim } from "@/lib/coverage-certification/claims";

const now = new Date("2026-10-24T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const COMMIT = "94135df6f85bfb34ac83c046e5541e1ad8d73a86";
const OTHER_COMMIT = "1111111111111111111111111111111111111111";

const openAiSources = (lastSuccessAt: string | null) =>
  ["pricing", "changelog", "deprecation"].map((sourceType, index) => ({
    sourceId: `source-${index}`,
    sourceType,
    lastSuccessAt,
  }));

describe("coverage state lattice", () => {
  it("takes the weakest state and treats absence as unknown", () => {
    expect(weakestState([])).toBe("unknown");
    for (const a of COVERAGE_STATES)
      for (const b of COVERAGE_STATES)
        expect(weakestState([a, b])).toBe(
          COVERAGE_STATES[Math.max(COVERAGE_STATES.indexOf(a), COVERAGE_STATES.indexOf(b))],
        );
  });
});

describe("dimension evaluators", () => {
  it("maps catalog labels and scan freshness for dependency sources", () => {
    const evaluate = (sources: ReturnType<typeof openAiSources>, catalogReadComplete = true) =>
      evaluateDependencySources({ dependencyId: "dep", catalogReadComplete, sources, now });
    expect(evaluate(openAiSources(hoursAgo(2)))).toMatchObject({
      state: "complete",
      reason: "covered",
    });
    expect(evaluate(openAiSources(hoursAgo(2)).slice(0, 2))).toMatchObject({
      state: "partial",
      reason: "partial_source_types",
    });
    expect(evaluate([])).toMatchObject({ state: "unsupported", reason: "no_configured_sources" });
    expect(evaluate(openAiSources(null))).toMatchObject({
      state: "unknown",
      reason: "no_successful_scan",
    });
    expect(evaluate(openAiSources(hoursAgo(49)))).toMatchObject({
      state: "unknown",
      reason: "scan_stale",
    });
    expect(evaluate(openAiSources(hoursAgo(2)), false)).toMatchObject({
      state: "unknown",
      reason: "catalog_read_incomplete",
    });
    expect(evaluate(openAiSources(hoursAgo(2))).expiresAt).toBe(
      new Date(now.getTime() + 46 * 3_600_000).toISOString(),
    );
  });

  it("counts code evidence only at the production-verified or head commit", () => {
    const analysis = (
      commitSha: string,
      coverageState: "complete" | "partial" | "unsupported" | "failed" = "complete",
      status = "completed",
    ) => ({
      runId: "run",
      commitSha,
      status,
      coverageState,
    });
    const evaluate = (input: Partial<Parameters<typeof evaluateRepositoryCode>[0]>) =>
      evaluateRepositoryCode({
        repositoryId: "repo",
        analysis: analysis(COMMIT),
        headCommitSha: COMMIT,
        productionCommitSha: null,
        ...input,
      });
    expect(evaluate({})).toMatchObject({ state: "complete", reason: "covered" });
    expect(evaluate({ headCommitSha: OTHER_COMMIT })).toMatchObject({
      state: "unknown",
      reason: "analysis_commit_behind_head",
    });
    expect(evaluate({ headCommitSha: OTHER_COMMIT, productionCommitSha: COMMIT })).toMatchObject({
      state: "complete",
    });
    expect(evaluate({ productionCommitSha: OTHER_COMMIT })).toMatchObject({ state: "unknown" });
    expect(evaluate({ headCommitSha: null })).toMatchObject({
      state: "unknown",
      reason: "analysis_commit_unverified",
    });
    expect(evaluate({ analysis: null })).toMatchObject({ state: "unknown", reason: "no_analysis" });
    expect(evaluate({ analysis: analysis(COMMIT, "complete", "running") })).toMatchObject({
      state: "unknown",
      reason: "analysis_not_completed",
    });
    expect(evaluate({ analysis: analysis(COMMIT, "partial") })).toMatchObject({ state: "partial" });
    expect(evaluate({ analysis: analysis(COMMIT, "unsupported") })).toMatchObject({
      state: "unsupported",
    });
    expect(evaluate({ analysis: analysis(COMMIT, "failed") })).toMatchObject({ state: "unknown" });
  });

  it("requires a fresh successful sync and production-verified evidence for deployment", () => {
    const evidence = (
      verificationState:
        "mapped" | "commit_verified" | "production_verified" | "inconclusive" | "historical",
    ) => ({
      evidenceId: "evidence",
      verificationState,
      verifiedCommitSha: COMMIT,
    });
    const evaluate = (input: Partial<Parameters<typeof evaluateDeploymentExposure>[0]>) =>
      evaluateDeploymentExposure({
        surfaceId: "surface",
        evidence: evidence("production_verified"),
        lastSync: { status: "succeeded", completedAt: hoursAgo(1) },
        now,
        ...input,
      });
    expect(evaluate({})).toMatchObject({ state: "complete", reason: "covered" });
    expect(evaluate({ evidence: evidence("commit_verified") })).toMatchObject({ state: "partial" });
    for (const state of ["mapped", "inconclusive", "historical"] as const)
      expect(evaluate({ evidence: evidence(state) })).toMatchObject({ state: "unknown" });
    expect(evaluate({ evidence: null })).toMatchObject({ reason: "no_production_deployment" });
    expect(evaluate({ lastSync: null })).toMatchObject({ state: "unknown", reason: "sync_failed" });
    expect(evaluate({ lastSync: { status: "failed", completedAt: hoursAgo(1) } })).toMatchObject({
      reason: "sync_failed",
    });
    expect(
      evaluate({ lastSync: { status: "succeeded", completedAt: hoursAgo(25) } }),
    ).toMatchObject({
      reason: "sync_stale",
    });
  });

  it("never lets a missing runtime provider block or strengthen protection", () => {
    expect(evaluateRuntimeSignals()).toMatchObject({ state: "unknown" });
    const component = (dimension: CoverageDimension, state: CoverageState): SubjectEvaluation => ({
      dimension,
      subjectType: "t",
      subjectId: dimension,
      state,
      reason: "covered",
      evidenceRefs: [],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const certificate = buildCertificate({
      components: [
        component("dependency_sources", "complete"),
        component("repository_code", "complete"),
        component("deployment_exposure", "complete"),
        evaluateRuntimeSignals(),
      ],
      issuedAt: now,
    });
    expect(certificate.dimensions.runtime_signals).toBe("unknown");
    expect(certificate.claimLevel).toBe("deployment_verified_protection");
  });
});

describe("claims never exceed the certificate", () => {
  const combos: Array<Record<CoverageDimension, CoverageState>> = [];
  for (const sources of COVERAGE_STATES)
    for (const code of COVERAGE_STATES)
      for (const deployment of COVERAGE_STATES)
        for (const runtime of COVERAGE_STATES)
          combos.push({
            dependency_sources: sources,
            repository_code: code,
            deployment_exposure: deployment,
            runtime_signals: runtime,
          });

  it("holds for every combination of dimension states (256 cases)", () => {
    for (const dims of combos) {
      const level = claimLevelFor(dims);
      expect(CLAIM_LEVELS).toContain(level);
      if (level === "deployment_verified_protection")
        expect([dims.dependency_sources, dims.repository_code, dims.deployment_exposure]).toEqual([
          "complete",
          "complete",
          "complete",
        ]);
      if (level === "code_verified_protection") {
        expect(dims.dependency_sources).toBe("complete");
        expect(dims.repository_code).toBe("complete");
        expect(dims.deployment_exposure).not.toBe("complete");
      }
      if (level === "partial_protection") {
        expect(dims.dependency_sources).not.toBe("unknown");
        expect(dims.repository_code).not.toBe("unknown");
      }
      if (dims.dependency_sources === "unknown" || dims.repository_code === "unknown")
        expect(level).toBe("unverified");
      // Runtime signals never change the claim.
      expect(level).toBe(claimLevelFor({ ...dims, runtime_signals: "unknown" }));
    }
  });

  it("is monotonic: strengthening any dimension never weakens the claim", () => {
    const rank = (level: (typeof CLAIM_LEVELS)[number]) =>
      CLAIM_LEVELS.length - CLAIM_LEVELS.indexOf(level);
    for (const dims of combos)
      for (const dimension of COVERAGE_DIMENSIONS) {
        const index = COVERAGE_STATES.indexOf(dims[dimension]);
        if (index === 0) continue;
        const stronger = { ...dims, [dimension]: COVERAGE_STATES[index - 1] };
        expect(rank(claimLevelFor(stronger))).toBeGreaterThanOrEqual(rank(claimLevelFor(dims)));
      }
  });

  it("expires to unverified and names every gap in customer text", () => {
    const sources = evaluateDependencySources({
      dependencyId: "dep",
      catalogReadComplete: true,
      sources: openAiSources(hoursAgo(2)),
      now,
    });
    const code = evaluateRepositoryCode({
      repositoryId: "repo",
      analysis: { runId: "run", commitSha: COMMIT, status: "completed", coverageState: "complete" },
      headCommitSha: COMMIT,
      productionCommitSha: null,
    });
    const certificate = buildCertificate({ components: [sources, code], issuedAt: now });
    expect(certificate.claimLevel).toBe("code_verified_protection");
    expect(protectionClaim(certificate, now)).toBe(
      "Protected at the analysed commit; Production deployment not verified (Production deployment: unknown).",
    );
    const expired = new Date(Date.parse(certificate.validUntil!) + 1);
    expect(claimLevelAt(certificate, expired)).toBe("unverified");
    expect(protectionClaim(certificate, expired)).toBe("Protection not currently verified.");
  });
});

describe("certificate fingerprint", () => {
  it("is independent of component order and issue time, and changes with evidence", () => {
    const a = evaluateDependencySources({
      dependencyId: "a",
      catalogReadComplete: true,
      sources: openAiSources(hoursAgo(2)),
      now,
    });
    const b = evaluateRepositoryCode({
      repositoryId: "repo",
      analysis: { runId: "run", commitSha: COMMIT, status: "completed", coverageState: "partial" },
      headCommitSha: COMMIT,
      productionCommitSha: null,
    });
    const first = buildCertificate({ components: [a, b], issuedAt: now });
    const second = buildCertificate({
      components: [b, a],
      issuedAt: new Date(now.getTime() + 60_000),
    });
    expect(second.componentsFingerprint).toBe(first.componentsFingerprint);
    expect(first.componentsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const changed = buildCertificate({
      components: [a, { ...b, state: "complete", reason: "covered" }],
      issuedAt: now,
    });
    expect(changed.componentsFingerprint).not.toBe(first.componentsFingerprint);
  });
});

describe("exposure assessment", () => {
  const deployment = (state: CoverageState, commitSha: string | undefined): SubjectEvaluation => ({
    dimension: "deployment_exposure",
    subjectType: "deployment_surface",
    subjectId: "surface",
    state,
    reason: "covered",
    evidenceRefs: [{ kind: "product_deployment_evidence", id: "evidence", commitSha }],
  });

  it("can be disproven only by a complete negative analysis at the verified deployed commit", () => {
    const assessments = [
      "evidence_present",
      "absence_observed",
      "unknown_incomplete",
      "failed",
    ] as const;
    const coverages = ["complete", "partial", "unsupported", "failed"] as const;
    const profiles = [NEGATIVE_ASSESSMENT_PROFILE, "javascript-typescript-v2.2"];
    let cases = 0;
    for (const assessmentState of assessments)
      for (const analysisCoverageState of coverages)
        for (const analysisProfile of profiles)
          for (const state of COVERAGE_STATES)
            for (const deployedCommit of [COMMIT, OTHER_COMMIT, undefined])
              for (const hasDeployment of [true, false]) {
                cases += 1;
                const result = assessExposure({
                  graph: {
                    assessmentState,
                    analysisCommitSha: COMMIT,
                    analysisProfile,
                    analysisCoverageState,
                  },
                  deployment: hasDeployment ? deployment(state, deployedCommit) : null,
                });
                const verifiedAtCommit =
                  hasDeployment && state === "complete" && deployedCommit === COMMIT;
                if (result.state === "disproven")
                  expect({
                    verifiedAtCommit,
                    assessmentState,
                    analysisProfile,
                    analysisCoverageState,
                  }).toEqual({
                    verifiedAtCommit: true,
                    assessmentState: "absence_observed",
                    analysisProfile: NEGATIVE_ASSESSMENT_PROFILE,
                    analysisCoverageState: "complete",
                  });
                if (result.state === "proven")
                  expect({ verifiedAtCommit, assessmentState }).toEqual({
                    verifiedAtCommit: true,
                    assessmentState: "evidence_present",
                  });
                if (!verifiedAtCommit) expect(result.state).toBe("unknown");
              }
    expect(cases).toBe(4 * 4 * 2 * 4 * 3 * 2);
  });

  it("reports a deployed commit that differs from the analysed commit", () => {
    expect(
      assessExposure({
        graph: {
          assessmentState: "evidence_present",
          analysisCommitSha: COMMIT,
          analysisProfile: NEGATIVE_ASSESSMENT_PROFILE,
          analysisCoverageState: "complete",
        },
        deployment: deployment("complete", OTHER_COMMIT),
      }),
    ).toEqual({ state: "unknown", reason: "analysis_commit_not_deployed" });
  });
});
