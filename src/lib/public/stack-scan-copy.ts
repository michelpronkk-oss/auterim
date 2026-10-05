export type PublicConfidenceLabel = "low" | "medium" | "high";

export function publicScanHeadline(
  status: "completed" | "partial" | "failed",
  candidateCount: number,
) {
  if (status === "failed") return "We couldn't complete this scan.";
  if (candidateCount <= 0) return "No dependency candidates were surfaced for review.";
  return `Auterim surfaced ${candidateCount} dependenc${candidateCount === 1 ? "y" : "ies"} for review.`;
}

export function publicAdditionalTechnologyCopy(count: number, names: readonly string[]) {
  if (count <= 0) return "";

  const noun = count === 1 ? "technology" : "technologies";
  const shownNames = names.slice(0, 8);
  const remaining = Math.max(0, count - shownNames.length);
  const nameList = shownNames.length
    ? `: ${shownNames.join(" · ")}${remaining > 0 ? ` · +${remaining} more` : ""}`
    : "";
  return `${count} additional ${noun} observed${nameList}.`;
}

export function publicDiscoveryScopeCopy(partial: boolean) {
  return partial
    ? "Initial discovery is selective by design. This scan may not surface every dependency."
    : "Initial discovery prioritizes evidence-backed matches for review.";
}
