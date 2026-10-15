import type {
  ClassificationChange,
  ClassificationEvidencePacket,
} from "@/lib/monitoring/classification";

const SIDE_BUDGET_BYTES = 3_000;
const DIFF_BUDGET_BYTES = 8_000;

export type EvidenceQuality = {
  diffTruncated: boolean;
  previousSideTruncated: boolean;
  currentSideTruncated: boolean;
  normalizedByteSize: number;
  addedLineCount: number;
  removedLineCount: number;
  sourceCriticality: "critical" | "standard";
  sourceType: string;
  semanticEvidenceCoverage: number;
  incomplete: boolean;
};

function extractDiffSide(diffText: string, marker: "+" | "-") {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith(marker) && !line.startsWith(marker.repeat(3)))
    .map((line) => line.slice(1))
    .join("\n");
}

export function isCriticalSourceType(sourceType: string) {
  return sourceType === "deprecation" || sourceType === "api" || sourceType === "status";
}

export function measureEvidenceQuality(change: ClassificationChange): EvidenceQuality {
  const previous = extractDiffSide(change.diffText, "-");
  const current = extractDiffSide(change.diffText, "+");
  const previousSideTruncated = Buffer.byteLength(previous, "utf8") > SIDE_BUDGET_BYTES;
  const currentSideTruncated = Buffer.byteLength(current, "utf8") > SIDE_BUDGET_BYTES;
  const diffTruncated =
    change.diffTruncated ||
    Buffer.byteLength(change.diffText, "utf8") > DIFF_BUDGET_BYTES ||
    previousSideTruncated ||
    currentSideTruncated;
  const expectedLines = change.addedLines + change.removedLines;
  const observedLines =
    Math.min(change.addedLines, current.split("\n").filter(Boolean).length) +
    Math.min(change.removedLines, previous.split("\n").filter(Boolean).length);
  const semanticEvidenceCoverage = expectedLines === 0 ? 1 : observedLines / expectedLines;
  return {
    diffTruncated,
    previousSideTruncated,
    currentSideTruncated,
    normalizedByteSize: Buffer.byteLength(change.diffText, "utf8"),
    addedLineCount: change.addedLines,
    removedLineCount: change.removedLines,
    sourceCriticality: isCriticalSourceType(change.sourceType) ? "critical" : "standard",
    sourceType: change.sourceType,
    semanticEvidenceCoverage: Number(semanticEvidenceCoverage.toFixed(4)),
    incomplete: diffTruncated || semanticEvidenceCoverage < 1,
  };
}

export type IntelligenceEvidence = {
  state: {
    dependencyName: string;
    sourceName: string;
    sourceType: string;
    previousVersion: number;
    currentVersion: number;
    previousEvidence: string;
    currentEvidence: string;
    deterministicDiff: string;
  };
  packet: ClassificationEvidencePacket;
  quality: EvidenceQuality;
};

export function buildIntelligenceEvidence(change: ClassificationChange): IntelligenceEvidence {
  const previousRaw = extractDiffSide(change.diffText, "-");
  const currentRaw = extractDiffSide(change.diffText, "+");
  const packet: ClassificationEvidencePacket = {
    sourceName: change.sourceName.slice(0, 160),
    sourceType: change.sourceType.slice(0, 40),
    sourceUrl: "",
    previousEvidence: bounded(previousRaw, SIDE_BUDGET_BYTES),
    currentEvidence: bounded(currentRaw, SIDE_BUDGET_BYTES),
    dependencyName: change.dependencyName.slice(0, 120),
    beforeVersion: change.beforeVersion,
    afterVersion: change.afterVersion,
    diffText: bounded(change.diffText, DIFF_BUDGET_BYTES),
    addedLines: change.addedLines,
    removedLines: change.removedLines,
    diffTruncated: measureEvidenceQuality(change).diffTruncated,
    beforeBytes: change.beforeBytes,
    afterBytes: change.afterBytes,
  };
  return {
    state: {
      dependencyName: packet.dependencyName,
      sourceName: packet.sourceName,
      sourceType: packet.sourceType,
      previousVersion: packet.beforeVersion,
      currentVersion: packet.afterVersion,
      previousEvidence: packet.previousEvidence,
      currentEvidence: packet.currentEvidence,
      deterministicDiff: packet.diffText,
    },
    packet,
    quality: measureEvidenceQuality(change),
  };
}

function bounded(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const marker = Buffer.from("\n[bounded evidence omitted]\n", "utf8");
  const budget = maxBytes - marker.byteLength;
  const headSize = Math.floor(budget / 2);
  const tailSize = budget - headSize;
  return Buffer.concat([
    bytes.subarray(0, headSize),
    marker,
    bytes.subarray(bytes.byteLength - tailSize),
  ]).toString("utf8");
}
