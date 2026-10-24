import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/supabase-bounded-migration.integration.test.ts"],
    maxWorkers: 1,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
