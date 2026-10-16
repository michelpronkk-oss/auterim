import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/cli/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "tests/baseline-queue-migration.test.ts",
      "tests/database.test.ts",
      "tests/m15-dependency-lifecycle.test.ts",
      "tests/onboarding.test.ts",
      "tests/products.test.ts",
      "tests/protection.test.ts",
      "packages/cli/tests/scanner.test.ts",
    ],
    maxWorkers: 4,
  },
});
