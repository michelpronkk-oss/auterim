export type PublicConfidenceLabel = "low" | "medium" | "high";

export function publicScanHeadline(
  status: "completed" | "partial" | "failed",
  confidenceLabels: readonly PublicConfidenceLabel[],
) {
  if (status === "failed") return "We couldn't complete this scan.";

  const likely = confidenceLabels.filter((label) => label === "high").length;
  const possible = confidenceLabels.length - likely;
  if (likely === 0 && possible === 0) return "No supported dependency suggestions were found.";
  const likelyText = `${likely} likely dependenc${likely === 1 ? "y" : "ies"}`;
  const possibleText = `${possible} possible dependenc${possible === 1 ? "y" : "ies"}`;
  if (likely === 0) return `We found ${possibleText}.`;
  if (possible === 0) return `We found ${likelyText}.`;
  return `We found ${likelyText} and ${possibleText}.`;
}
