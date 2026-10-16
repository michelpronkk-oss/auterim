import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.mts";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["scripts/eval-intelligence-policy-semantics-live.test.ts"],
    maxWorkers: 1,
  },
});
