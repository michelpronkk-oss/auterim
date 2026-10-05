import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.mts";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["scripts/eval-public-discovery-live.test.ts"],
    testTimeout: 90_000,
  },
});
