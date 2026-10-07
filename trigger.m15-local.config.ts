import { defineConfig } from "@trigger.dev/sdk";
import { playwright } from "@trigger.dev/build/extensions/playwright";

const localSupabaseUrl = process.env.AUTERIM_M15_LOCAL_SUPABASE_URL;
let localSupabaseOrigin: string | undefined;
try {
  localSupabaseOrigin = new URL(localSupabaseUrl ?? "").origin;
} catch {
  localSupabaseOrigin = undefined;
}
if (
  process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
  !new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
    localSupabaseOrigin ?? "",
  )
) {
  throw new Error("m15_local_trigger_config_requires_guarded_local_supabase");
}

export default defineConfig({
  project: "proj_hwqtxtyrvwykjirkrdoh",
  runtime: "node-24",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger", "./src/trigger-m15-local"],
  build: {
    external: ["playwright"],
    extensions: [playwright({ browsers: ["chromium"] })],
  },
});
