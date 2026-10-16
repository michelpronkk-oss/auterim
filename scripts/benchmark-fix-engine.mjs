import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const fixtures = JSON.parse(
  readFileSync(path.join(root, "tests/fixtures/fix-engine/benchmark.json"), "utf8"),
);
if (
  !Array.isArray(fixtures) ||
  fixtures.length < 6 ||
  new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length
) {
  throw new Error("fix_engine_benchmark_corpus_invalid");
}
console.log(`Fix Engine benchmark corpus ready: ${fixtures.length} versioned labeled cases.`);
console.log(
  "No external model was called. Provider runs use scoreFixBenchmark() with separately recorded safe metrics.",
);
