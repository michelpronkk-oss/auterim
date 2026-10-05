export type DashboardHealthState =
  | "attention_required"
  | "access_problem"
  | "incomplete_coverage"
  | "coverage_pending"
  | "baseline_pending"
  | "protected_and_quiet"
  | "monitoring_evidence_available"
  | "unsupported"
  | "unknown";

export function getDashboardHealthPresentation(state?: string | null) {
  const presentations: Record<DashboardHealthState, { label: string; explanation: string }> = {
    attention_required: {
      label: "Needs attention",
      explanation: "A current customer-relevant change was assessed.",
    },
    access_problem: {
      label: "Access issue",
      explanation: "Recent monitoring evidence shows a source or repository access problem.",
    },
    incomplete_coverage: {
      label: "Limited coverage",
      explanation: "Coverage or baseline evidence is incomplete.",
    },
    coverage_pending: {
      label: "Coverage pending",
      explanation: "No authoritative provider source is currently cataloged for this dependency.",
    },
    baseline_pending: {
      label: "Baseline pending",
      explanation: "An initial shared source baseline has not been observed yet.",
    },
    protected_and_quiet: {
      label: "No relevant change identified",
      explanation: "Available monitoring evidence has not identified a relevant change.",
    },
    monitoring_evidence_available: {
      label: "Monitoring evidence available",
      explanation: "Shared source baselines exist; no uptime or runtime health claim is made.",
    },
    unsupported: {
      label: "Monitoring unavailable",
      explanation: "This dependency is not currently eligible for monitoring.",
    },
    unknown: {
      label: "Status unknown",
      explanation: "There is not enough evidence to characterize this dependency.",
    },
  };
  return presentations[
    (state as DashboardHealthState) in presentations ? (state as DashboardHealthState) : "unknown"
  ];
}
