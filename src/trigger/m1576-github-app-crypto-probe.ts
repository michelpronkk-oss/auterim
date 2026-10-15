import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { inspectGitHubAppPrivateKey } from "@/lib/preflight/github-app-crypto";
import { getEnvironment } from "@/lib/env/schema";

/** Internal operator probe. It performs local crypto only and never contacts GitHub. */
export const m1576GitHubAppCryptoProbe = schemaTask({
  id: "m1576-github-app-crypto-probe",
  schema: z.object({}).strict(),
  retry: { maxAttempts: 1 },
  maxDuration: 30,
  run: async () => {
    let environment: ReturnType<typeof getEnvironment>;
    try {
      environment = getEnvironment();
    } catch {
      return {
        configPresent: false,
        formatClass: "unknown" as const,
        privateKeyParseable: false,
        keyType: "unknown" as const,
        localSignVerify: false,
        failureCategory: "environment_invalid" as const,
        networkRequested: false as const,
      };
    }
    const diagnostics = inspectGitHubAppPrivateKey(environment.GITHUB_APP_PRIVATE_KEY);
    return {
      configPresent: Boolean(environment.GITHUB_APP_ID && diagnostics.configured),
      formatClass: diagnostics.formatClass,
      privateKeyParseable: diagnostics.parseable,
      keyType: diagnostics.keyType,
      localSignVerify: diagnostics.localSignVerify,
      ...(diagnostics.failureCategory ? { failureCategory: diagnostics.failureCategory } : {}),
      networkRequested: false as const,
    };
  },
});
