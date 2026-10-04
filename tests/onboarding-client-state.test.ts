import { describe, expect, it } from "vitest";
import {
  createRequestSequence,
  onboardingReadModelSchema,
  onboardingStepIndex,
  resolveOnboardingStep,
  summarizeCandidateEvidence,
} from "@/lib/onboarding/client-state";

function readModel(overrides: Record<string, unknown> = {}) {
  return onboardingReadModelSchema.parse({
    currentStep: "dependencies_review",
    company: {
      id: "00000000-0000-4000-8000-000000000101",
      name: "Example Inc.",
      websiteUrl: "https://example.com/",
    },
    discovery: { status: "completed", candidates: [] },
    confirmedDependencies: [],
    completion: { dependencyReview: false, context: false, notifications: false },
    notificationPreferences: null,
    coveragePreview: {
      dependenciesConfirmed: 0,
      authoritativeSourcesAvailable: 0,
      criticalDependencies: 0,
      sourcesByType: {},
    },
    activation: null,
    ...overrides,
  });
}

describe("onboarding client state", () => {
  it("accepts the persisted JSON evidence summary returned for discovery candidates", () => {
    const result = onboardingReadModelSchema.parse({
      currentStep: "dependencies_review",
      company: {
        id: "00000000-0000-4000-8000-000000000101",
        name: "Example Inc.",
        websiteUrl: "https://example.com/",
      },
      discovery: {
        status: "completed",
        candidates: [
          {
            candidateId: "00000000-0000-4000-8000-000000000102",
            dependencyId: "00000000-0000-4000-8000-000000000103",
            providerName: "Vercel",
            category: "hosting",
            confidence: 0.72,
            confidenceLabel: "medium",
            evidenceSummary: [
              {
                signatureKey: "server-vercel",
                signalType: "response_header",
                strength: "strong",
                sourceOrigin: "https://example.com",
              },
              {
                signatureKey: "x-vercel-id",
                signalType: "response_header",
                strength: "strong",
                sourceOrigin: "https://example.com",
              },
            ],
            suggestedStatus: "candidate",
          },
        ],
      },
      confirmedDependencies: [],
      completion: { dependencyReview: false, context: false, notifications: false },
      notificationPreferences: null,
      coveragePreview: {
        dependenciesConfirmed: 0,
        authoritativeSourcesAvailable: 0,
        criticalDependencies: 0,
        sourcesByType: {},
      },
      activation: null,
    });

    expect(result.currentStep).toBe("dependencies_review");
    expect(result.discovery.candidates[0]?.suggestedStatus).toBe("candidate");
    expect(resolveOnboardingStep(result)).toBe("dependencies");
    expect(summarizeCandidateEvidence(result.discovery.candidates[0]!.evidenceSummary)).toContain(
      "Strong response header signal",
    );
  });

  it.each([
    ["discovery pending", "company_created", null, "discovery"],
    ["discovery running", "discovery_running", "running", "discovery"],
    ["empty completed discovery", "discovery_running", "completed", "dependencies"],
    ["failed discovery", "discovery_running", "failed", "dependencies"],
  ] as const)(
    "resolves %s without falling back to Company",
    (_label, currentStep, status, step) => {
      expect(
        resolveOnboardingStep(readModel({ currentStep, discovery: { status, candidates: [] } })),
      ).toBe(step);
    },
  );

  it("resolves saved onboarding progression in order and keeps activation terminal", () => {
    const states = [
      readModel({
        currentStep: "discovery_running",
        discovery: { status: "running", candidates: [] },
      }),
      readModel({
        currentStep: "dependencies_review",
        completion: { dependencyReview: false, context: false, notifications: false },
      }),
      readModel({
        currentStep: "context_setup",
        completion: { dependencyReview: true, context: false, notifications: false },
      }),
      readModel({
        currentStep: "notifications_setup",
        completion: { dependencyReview: true, context: true, notifications: false },
      }),
      readModel({
        currentStep: "activating",
        completion: { dependencyReview: true, context: true, notifications: true },
      }),
      readModel({
        currentStep: "active",
        activation: { activatedAt: "2026-10-04T00:00:00Z", baselineStatus: "in_progress" },
      }),
    ];
    const steps = states.map(resolveOnboardingStep);

    expect(steps).toEqual([
      "discovery",
      "dependencies",
      "context",
      "notifications",
      "protect",
      "active",
    ]);
    expect(steps.map(onboardingStepIndex)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("prevents an older workspace read from committing after a newer read starts", () => {
    const sequence = createRequestSequence();
    const staleRead = sequence.begin();
    const currentRead = sequence.begin();

    expect(sequence.isCurrent(staleRead)).toBe(false);
    expect(sequence.isCurrent(currentRead)).toBe(true);
  });

  it("invalidates pending workspace reads when the authenticated user changes", () => {
    const sequence = createRequestSequence();
    const oldSessionRead = sequence.begin();
    sequence.invalidate();
    const newSessionRead = sequence.begin();

    expect(sequence.isCurrent(oldSessionRead)).toBe(false);
    expect(sequence.isCurrent(newSessionRead)).toBe(true);
  });
});
