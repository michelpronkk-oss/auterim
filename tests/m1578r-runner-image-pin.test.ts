import { describe, expect, it } from "vitest";
import {
  VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
} from "../verification-runner/contracts";
import { EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS } from "../src/lib/fix-engine/runner-identity-attestation";

describe("M15.78R immutable runner image pin", () => {
  it("pins the runner protocol to the immutable snapshot-extraction release", () => {
    expect(VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF).toBe(
      "auterim-verification-runner:m1578r-snapshot-extraction-20261019-04",
    );
    expect(VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH).toBe("/v1/identity-attestation");
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).toEqual([
      "sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4",
      "sha256:e7495ddf158b8ea60adfd210a0115c626c9771756c6e439c13c041b461a56bf4",
      "sha256:fa84bc3808783d7ac0ef10379de187f1ac348f19e995aadb196bb910b8173639",
    ]);
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).not.toContain(
      "sha256:86ba0b06d9314a4df98b09fc57ceb185c6584598a8197bba23d78ae446098b7b",
    );
  });

  it("does not retain either the pre-attestation or current production image identity", () => {
    expect(VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF).not.toBe(
      "auterim-verification-runner:ac73ed8",
    );
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).not.toContain(
      "sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee",
    );
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).not.toContain(
      "sha256:86ba0b06d9314a4df98b09fc57ceb185c6584598a8197bba23d78ae446098b7b",
    );
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).not.toContain(
      "sha256:0d439b25ab2b717f5cb2f669ccca112e9ab281a1b32bf645c5abaf4a58c9b04b",
    );
  });
});
