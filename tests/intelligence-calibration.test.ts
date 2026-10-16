import { describe, expect, it } from "vitest";
import { measureEvidenceQuality } from "@/lib/intelligence/evidence";
import {
  ACTIVE_ROUTING_READINESS,
  ACTIVE_THRESHOLD_VERSION,
  CALIBRATION_CORPUS_VERSION,
  CALIBRATED_ACTIVE_THRESHOLDS,
  CALIBRATION_FIXTURE_COUNT,
  CALIBRATION_HOLDOUT_METRICS,
  CALIBRATION_VERSION,
  activeCalibrationIsReady,
  activeThresholdFingerprint,
} from "@/lib/intelligence/calibration";
import { evaluateWithReadinessGate } from "@/lib/intelligence/decision";

describe("M15.75A calibrated active policy artifact", () => {
  it("pins the accepted explicit stratified calibration identity and thresholds", () => {
    expect(ACTIVE_THRESHOLD_VERSION).toBe("m1575a-calibrated-thresholds-v1");
    expect(CALIBRATION_CORPUS_VERSION).toBe("explicit-stratified-64-v2");
    expect(CALIBRATION_VERSION).toBe("m1575a-stratified-64-v2");
    expect(CALIBRATION_FIXTURE_COUNT).toBe(32);
    expect(CALIBRATED_ACTIVE_THRESHOLDS).toEqual({
      material: 0.399999999,
      criticalChange: 0.509999999,
      evidenceSufficient: 0.420000001,
      docsNoise: 0.829999999,
      requiresEscalation: 0.5399999990000001,
      routeConfidence: 0.48999999899999996,
      calibrationFixtureCount: 32,
      calibrationVersion: "m1575a-stratified-64-v2",
    });
  });

  it("reproduces the accepted readiness gates and fails closed on any changed gate", () => {
    expect(CALIBRATION_HOLDOUT_METRICS).toMatchObject({
      fixtureCount: 32,
      dangerousSuppressionFalseNegatives: 0,
      criticalProtectionCoverage: 1,
      criticalIncompleteEvidenceCoverage: 1,
      docsNoiseSuppressionPrecision: 1,
      docsNoiseMaterialFalseSuppressions: 0,
      unnecessaryEscalationRate: 0,
      noHighRiskRouteCollapse: true,
    });
    expect(ACTIVE_ROUTING_READINESS).toMatchObject({
      fixtureCount: 64,
      calibrationFixtureCount: 32,
      holdoutFixtureCount: 32,
    });
    expect(activeCalibrationIsReady()).toBe(true);
    expect(
      activeCalibrationIsReady({ ...ACTIVE_ROUTING_READINESS, criticalProtectionCoverage: false }),
    ).toBe(false);
  });

  it("content-addresses the immutable threshold set", () => {
    expect(activeThresholdFingerprint()).toMatch(/^[a-f0-9]{64}$/);
    expect(activeThresholdFingerprint()).toBe(activeThresholdFingerprint());
  });

  it("allows supported material work only when ready and otherwise fails closed", () => {
    const quality = measureEvidenceQuality({
      sourceName: "SDK release notes",
      sourceType: "sdk",
      sourceUrl: "https://fixture.invalid/changelog",
      dependencyName: "Provider SDK",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: "The SDK adds a new method for stable request handling.",
      addedLines: 1,
      removedLines: 0,
      diffTruncated: false,
      beforeBytes: 100,
      afterBytes: 120,
    });
    const judgment = {
      route: "sdk_change" as const,
      confidence: 0.99,
      probabilities: {
        material: 0.99,
        criticalChange: 0.01,
        evidenceSufficient: 0.99,
        docsNoise: 0.01,
        requiresEscalation: 0.01,
        route: { sdk_change: 0.99 },
      } as never,
    };
    const supported = evaluateWithReadinessGate({
      classifier: null,
      judgment,
      evidenceQuality: quality,
      thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
      activeReady: true,
    });
    expect(supported.state).toBe("continue_candidate");

    const closed = evaluateWithReadinessGate({
      classifier: null,
      judgment,
      evidenceQuality: quality,
      thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
      activeReady: false,
    });
    expect(closed.state).toBe("escalate");
    expect(closed.state).not.toBe("continue_candidate");
    expect(closed.state).not.toBe("suppress_candidate");
  });
});
