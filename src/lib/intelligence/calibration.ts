import type { PolicyThresholds } from "@/lib/intelligence/policy";
import { createHash } from "node:crypto";

/**
 * Frozen output of the accepted M15.75A explicit-stratified-64-v2 lab run.
 * Values and safety gates are copied from its sanitized local report; threshold
 * derivation remains implemented by replay.ts and eval-intelligence-live.test.ts.
 */
export const ACTIVE_THRESHOLD_VERSION = "m1575a-calibrated-thresholds-v1";
export const CALIBRATION_CORPUS_VERSION = "explicit-stratified-64-v2";
export const CALIBRATION_VERSION = "m1575a-stratified-64-v2";
export const CALIBRATION_FIXTURE_COUNT = 32;

export const CALIBRATED_ACTIVE_THRESHOLDS: PolicyThresholds = Object.freeze({
  material: 0.399999999,
  criticalChange: 0.509999999,
  evidenceSufficient: 0.420000001,
  docsNoise: 0.829999999,
  requiresEscalation: 0.5399999990000001,
  routeConfidence: 0.48999999899999996,
  calibrationFixtureCount: CALIBRATION_FIXTURE_COUNT,
  calibrationVersion: CALIBRATION_VERSION,
});

export const CALIBRATION_HOLDOUT_METRICS = Object.freeze({
  fixtureCount: 32,
  materialFalseNegatives: 3,
  materialFalsePositives: 1,
  criticalFalseNegatives: 3,
  routeAccuracy: 0.90625,
  evidenceInsufficiencyRecall: 0.8,
  escalationRecall: 0.84,
  dangerousSuppressionFalseNegatives: 0,
  criticalProtectionCoverage: 1,
  criticalIncompleteEvidenceCoverage: 1,
  docsNoiseSuppressionPrecision: 1,
  docsNoiseMaterialFalseSuppressions: 0,
  unnecessaryEscalationRate: 0,
  noHighRiskRouteCollapse: true,
});

export const ACTIVE_ROUTING_READINESS = Object.freeze({
  policySemanticsVersion: "intelligence-policy-semantics-v2",
  corpusVersion: CALIBRATION_CORPUS_VERSION,
  calibrationVersion: CALIBRATION_VERSION,
  fixtureCount: 64,
  calibrationFixtureCount: CALIBRATION_FIXTURE_COUNT,
  holdoutFixtureCount: 32,
  dangerousSuppressionFalseNegatives:
    CALIBRATION_HOLDOUT_METRICS.dangerousSuppressionFalseNegatives === 0,
  criticalProtectionCoverage: CALIBRATION_HOLDOUT_METRICS.criticalProtectionCoverage === 1,
  criticalIncompleteEvidenceCoverage:
    CALIBRATION_HOLDOUT_METRICS.criticalIncompleteEvidenceCoverage === 1,
  docsNoiseSuppressionPrecision: CALIBRATION_HOLDOUT_METRICS.docsNoiseSuppressionPrecision === 1,
  docsNoiseNoMaterialFalseSuppression:
    CALIBRATION_HOLDOUT_METRICS.docsNoiseMaterialFalseSuppressions === 0,
  unnecessaryEscalationRate: CALIBRATION_HOLDOUT_METRICS.unnecessaryEscalationRate,
  noHighRiskRouteCollapse: CALIBRATION_HOLDOUT_METRICS.noHighRiskRouteCollapse,
});

type Readiness = {
  policySemanticsVersion: string;
  corpusVersion: string;
  calibrationVersion: string;
  fixtureCount: number;
  calibrationFixtureCount: number;
  holdoutFixtureCount: number;
  dangerousSuppressionFalseNegatives: boolean;
  criticalProtectionCoverage: boolean;
  criticalIncompleteEvidenceCoverage: boolean;
  docsNoiseSuppressionPrecision: boolean;
  docsNoiseNoMaterialFalseSuppression: boolean;
  unnecessaryEscalationRate: number;
  noHighRiskRouteCollapse: boolean;
};

export const INTELLIGENCE_ACTIVE_POLICY_VERSION = "intelligence-policy-active-v2";

export function activeCalibrationIsReady(
  readiness: Readiness = ACTIVE_ROUTING_READINESS,
  thresholds = CALIBRATED_ACTIVE_THRESHOLDS,
): boolean {
  const t = thresholds;
  const r = readiness;
  return (
    r.policySemanticsVersion === "intelligence-policy-semantics-v2" &&
    ACTIVE_THRESHOLD_VERSION === "m1575a-calibrated-thresholds-v1" &&
    r.corpusVersion === "explicit-stratified-64-v2" &&
    r.calibrationVersion === t.calibrationVersion &&
    r.fixtureCount === 64 &&
    r.calibrationFixtureCount === t.calibrationFixtureCount &&
    r.holdoutFixtureCount === 32 &&
    r.dangerousSuppressionFalseNegatives &&
    r.criticalProtectionCoverage &&
    r.criticalIncompleteEvidenceCoverage &&
    r.docsNoiseSuppressionPrecision &&
    r.docsNoiseNoMaterialFalseSuppression &&
    r.unnecessaryEscalationRate === 0 &&
    r.noHighRiskRouteCollapse &&
    t.calibrationFixtureCount === CALIBRATION_FIXTURE_COUNT &&
    t.calibrationVersion === CALIBRATION_VERSION &&
    [
      t.material,
      t.criticalChange,
      t.evidenceSufficient,
      t.docsNoise,
      t.requiresEscalation,
      t.routeConfidence,
    ].every((value) => value >= 0 && value <= 1)
  );
}

export function activeThresholdFingerprint(): string {
  // A stable, content-addressed identity. The caller persists only this digest
  // and the bounded threshold object, never source or provider material.
  const canonical = JSON.stringify({
    policySemanticsVersion: "intelligence-policy-semantics-v2",
    policyVersion: INTELLIGENCE_ACTIVE_POLICY_VERSION,
    thresholdVersion: ACTIVE_THRESHOLD_VERSION,
    corpusVersion: CALIBRATION_CORPUS_VERSION,
    thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
