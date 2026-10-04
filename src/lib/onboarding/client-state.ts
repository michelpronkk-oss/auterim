import { z } from "zod";

export const candidateSchema = z.object({
  candidateId: z.string().uuid(),
  dependencyId: z.string().uuid(),
  providerName: z.string(),
  category: z.string(),
  confidence: z.number(),
  confidenceLabel: z.string(),
  evidenceSummary: z.array(
    z.object({
      signatureKey: z.string(),
      signalType: z.enum([
        "response_header",
        "script_host",
        "script_path",
        "document_host",
        "embedded_url",
        "markup_marker",
        "resource_host",
        "csp_host",
        "api_endpoint",
        "js_sdk",
        "redirect_host",
      ]),
      strength: z.enum(["strong", "medium", "weak"]),
      sourceOrigin: z.string(),
    }),
  ),
  suggestedStatus: z.enum(["candidate", "confirmed", "rejected"]),
});

const dependencySchema = z.object({
  workspaceDependencyId: z.string().uuid(),
  dependencyId: z.string().uuid(),
  providerName: z.string(),
  category: z.string(),
  origin: z.string(),
  criticality: z.enum(["critical", "important", "normal"]),
  productionCritical: z.boolean(),
  usedFor: z.array(z.string()),
  contextNote: z.string(),
  usageMetadata: z.record(z.string(), z.unknown()),
});

export const onboardingReadModelSchema = z
  .object({
    currentStep: z.string(),
    company: z.object({
      id: z.string().uuid(),
      name: z.string(),
      websiteUrl: z.string().nullable(),
    }),
    discovery: z.object({
      status: z.enum(["running", "completed", "partial", "failed"]).nullable(),
      coverage: z
        .object({
          outcome: z.enum(["complete", "partial", "empty", "failed"]).optional(),
          durationMs: z.number().int().nonnegative().optional(),
          html: z
            .object({
              attempted: z.boolean(),
              status: z.number().int().nullable(),
              bytesRead: z.number().int().nonnegative(),
              truncated: z.boolean(),
              extractionPerformed: z.boolean(),
              nodeLimitReached: z.boolean(),
              referenceLimitReached: z.boolean(),
            })
            .optional(),
          headers: z.object({ inspected: z.number().int().nonnegative() }).optional(),
          csp: z
            .object({ inspected: z.boolean(), hostSources: z.number().int().nonnegative() })
            .optional(),
          manifest: z
            .object({
              attempted: z.boolean(),
              discovered: z.number().int().nonnegative(),
              fetched: z.number().int().nonnegative(),
              failures: z.number().int().nonnegative(),
            })
            .optional(),
          javascript: z
            .object({
              attempted: z.boolean(),
              scriptsDiscovered: z.number().int().nonnegative(),
              scriptsAttempted: z.number().int().nonnegative(),
              scriptsFetched: z.number().int().nonnegative(),
              bytesFetched: z.number().int().nonnegative(),
              failures: z.number().int().nonnegative(),
              limitReached: z.boolean(),
            })
            .optional(),
          incompleteReasons: z.array(z.string()).optional(),
        })
        .optional(),
      candidates: z.array(candidateSchema),
    }),
    confirmedDependencies: z.array(dependencySchema),
    completion: z.object({
      dependencyReview: z.boolean(),
      context: z.boolean(),
      notifications: z.boolean(),
    }),
    notificationPreferences: z
      .object({
        importantChanges: z.enum(["daily_digest", "instant", "off"]),
        informational: z.enum(["off", "digest"]),
        monthlyProtectionReport: z.boolean(),
      })
      .nullable(),
    coveragePreview: z.object({
      dependenciesConfirmed: z.number(),
      authoritativeSourcesAvailable: z.number(),
      criticalDependencies: z.number(),
      sourcesByType: z.record(z.string(), z.number()),
    }),
    activation: z
      .object({
        activatedAt: z.string(),
        baselineStatus: z.enum(["ready", "in_progress", "partial"]),
      })
      .nullable(),
  })
  .passthrough();

export type OnboardingReadModel = z.infer<typeof onboardingReadModelSchema>;

export type OnboardingStep =
  "discovery" | "dependencies" | "context" | "notifications" | "protect" | "active";

export function resolveOnboardingStep(onboarding: OnboardingReadModel): OnboardingStep {
  if (onboarding.activation || onboarding.currentStep === "active") return "active";

  const discoveryPending = ["company_created", "discovery_running"].includes(
    onboarding.currentStep,
  );
  if (
    discoveryPending &&
    (onboarding.discovery.status === null || onboarding.discovery.status === "running")
  ) {
    return "discovery";
  }

  if (!onboarding.completion.dependencyReview) return "dependencies";
  if (!onboarding.completion.context) return "context";
  if (!onboarding.completion.notifications) return "notifications";
  return "protect";
}

export function onboardingStepIndex(step: OnboardingStep) {
  switch (step) {
    case "discovery":
    case "dependencies":
      return 1;
    case "context":
    case "notifications":
      return 2;
    case "protect":
    case "active":
      return 3;
  }
}

export function summarizeCandidateEvidence(
  evidence: z.infer<typeof candidateSchema>["evidenceSummary"],
) {
  if (evidence.length === 0) return "No public evidence summary is available.";
  const labels = evidence.slice(0, 3).map((item) => {
    const strength =
      item.strength === "strong" ? "Strong" : item.strength === "medium" ? "Medium" : "Weak";
    const signal = item.signalType.replaceAll("_", " ");
    return `${strength} ${signal} signal (${item.sourceOrigin})`;
  });
  const remaining = evidence.length - labels.length;
  return `${labels.join(" · ")}${remaining > 0 ? ` · +${remaining} more` : ""}`;
}

export function createRequestSequence() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(request: number) {
      return request === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
