import { describe, expect, it } from "vitest";
import {
  VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
} from "../verification-runner/contracts";
import { EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS } from "../src/lib/fix-engine/runner-identity-attestation";

describe("M15.78R immutable runner image pin", () => {
  it("pins the runner protocol to the image built from the approved diagnostic release", () => {
    expect(VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF).toBe(
      "auterim-verification-runner:f03235a2ddf2d59846fd0062ddcd6df614e1ad40",
    );
    expect(VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH).toBe("/v1/identity-attestation");
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).toEqual([
      "sha256:5c8e5dacc9aab8f84ad41f8a288decb7effdce183e09a4721335a0c3bd552bd3",
      "sha256:0d439b25ab2b717f5cb2f669ccca112e9ab281a1b32bf645c5abaf4a58c9b04b",
    ]);
  });

  it("does not retain the previous mutable image tag or live image identity", () => {
    expect(VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF).not.toBe(
      "auterim-verification-runner:ac73ed8",
    );
    expect(EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS).not.toContain(
      "sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee",
    );
  });
});
