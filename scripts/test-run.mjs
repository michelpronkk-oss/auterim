import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const phases = [
  ["parallel unit suites", ["run", "--config", "vitest.unit.config.mts"]],
  [
    "serial PGlite integration suites",
    ["run", "--config", "vitest.database.config.mts", "--reporter=verbose"],
  ],
  ["bounded filesystem scan suite", ["run", "--config", "vitest.bounded-scan.config.mts"]],
];

for (const [name, args] of phases) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, [vitest, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${name} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
