import { describe, expect, it } from "vitest";
import { runM157DeploymentAcceptance } from "../src/lib/m15/deployment-acceptance.ts";

const enabled = process.env.AUTERIM_M157_DEPLOYMENT_ACCEPTANCE === "1";

describe("M15.7 fixed-target Production deployment acceptance", () => {
  it.skipIf(!enabled)(
    "performs two real Vercel reads/syncs and verifies persisted Production evidence",
    async () => {
      const result = await runM157DeploymentAcceptance();
      expect(result.firstSync.status).toBe("succeeded");
      expect(result.secondSync.status).toBe("succeeded");
      expect(result.evidence.verificationState).toBe("production_verified");
      expect(result.evidence.exactCommitMatch).toBe(true);
      console.info(`M157_ACCEPTANCE_RESULT ${JSON.stringify(result)}`);
    },
    180_000,
  );
});
