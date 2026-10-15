import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  analyzeCodeSnapshot,
  CODE_SCAN_LIMITS,
  type SnapshotFile,
} from "../src/lib/code-intelligence/analyzer.ts";

const commit = "6165f30d4e0c9a37bd7f2cd7579aaaa76d2bfdcc";
const factLimitOverride = Number(process.env.M1576_BENCH_FACT_LIMIT ?? 0);
if (
  Number.isSafeInteger(factLimitOverride) &&
  factLimitOverride > CODE_SCAN_LIMITS.maxPersistedFacts
)
  Object.assign(CODE_SCAN_LIMITS, { maxPersistedFacts: factLimitOverride });
const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", commit], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean)
  .filter(
    (file) =>
      file === "package.json" ||
      file === "package-lock.json" ||
      file === "pnpm-lock.yaml" ||
      file === "yarn.lock" ||
      /\.(?:js|jsx|cjs|mjs|ts|tsx|cts|mts)$/i.test(file),
  )
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

function readExactCommit(): SnapshotFile[] {
  return tracked.map((file) => {
    const bytes = execFileSync("git", ["show", `${commit}:${file}`], {
      maxBuffer: CODE_SCAN_LIMITS.maxManifestBytes + 1_000_000,
    });
    const text = bytes.toString("utf8");
    return {
      path: file,
      text: text.includes("\uFFFD") ? "" : text,
      size: bytes.byteLength,
      binary: text.includes("\uFFFD"),
    };
  });
}

function makeUpperBoundFixture(): SnapshotFile[] {
  return Array.from({ length: CODE_SCAN_LIMITS.maxFiles }, (_, fileIndex) => {
    const imports = Array.from(
      { length: 4 },
      (_, importIndex) =>
        `import { item${importIndex} as alias${importIndex} } from "@fixture/pkg-${fileIndex}-${importIndex}";`,
    );
    const functions = Array.from(
      { length: 4 },
      (_, index) => `export function module${fileIndex}Function${index}() { return ${index}; }`,
    );
    const filler = `/* ${String(fileIndex).padStart(4, "0")} ${"bounded-source-".repeat(620)} */`;
    const text = [...imports, ...functions, filler].join("\n");
    return {
      path: `src/upper-${String(fileIndex).padStart(4, "0")}.ts`,
      text,
      size: Buffer.byteLength(text),
    };
  });
}

function measure(name: string, files: SnapshotFile[]) {
  const start = performance.now();
  const result = analyzeCodeSnapshot(files);
  const durationMs = Math.round(performance.now() - start);
  const peakRss = process.resourceUsage().maxRSS;
  return {
    name,
    inputFiles: files.length,
    bytesSupplied: files.reduce(
      (sum, file) => sum + (file.size ?? Buffer.byteLength(file.text)),
      0,
    ),
    filesDiscovered: result.filesDiscovered,
    supportedFilesDiscovered: result.supportedFilesDiscovered,
    supportedFilesAnalyzed: result.supportedFilesAnalyzed,
    supportedFilesSkippedByBound: result.supportedFilesSkippedByBound,
    bytesAnalyzed: result.bytesAnalyzed,
    entities: result.entities.length,
    relations: result.relations.length,
    references: result.externalReferences.length,
    skippedRecords: result.skippedFiles.length,
    coverageState: result.coverageState,
    durationMs,
    peakRssBytes: peakRss * 1024,
  };
}

const small: SnapshotFile[] = [
  {
    path: "src/client.ts",
    text: 'import Stripe from "stripe";\nexport const client = new Stripe("placeholder");',
    size: 78,
  },
];
const current = readExactCommit();
const upper = makeUpperBoundFixture();
console.log(
  JSON.stringify([
    measure("small", small),
    measure("auterim-exact-commit", current),
    measure("upper-bound-synthetic", upper),
  ]),
);
