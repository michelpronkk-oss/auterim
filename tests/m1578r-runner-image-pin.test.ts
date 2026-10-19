import { describe, expect, it } from "vitest";
import {
  VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
} from "../verification-runner/contracts";
import { EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS } from "../src/lib/fix-engine/runner-identity-attestation";

describe("M15.78R immutable runner image pin", () => {
  it("pins the runner protocol to the new self-identity-consistent release", () => {
    expect(VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF).toBe(
      "auterim-verification-runner:m1578r-self-id-20261019-03",
    );
    expect(VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH).toBe("/v1/identity-attestation");
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).toEqual([
      "sha256:86ba0b06d9314a4df98b09fc57ceb185c6584598a8197bba23d78ae446098b7b",
      "sha256:8057869831067a84e653c55cc321b37dbb737892512eed45df743a540532956d",
      "sha256:015a340ef9eaa09ab9e8b7371f75ffe1b9cdf4d2631774c6800128bba89ee993",
    ]);
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).not.toContain(
      "sha256:5c8e5dacc9aab8f84ad41f8a288decb7effdce183e09a4721335a0c3bd552bd3",
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
      "sha256:0d439b25ab2b717f5cb2f669ccca112e9ab281a1b32bf645c5abaf4a58c9b04b",
    );
  });
});
