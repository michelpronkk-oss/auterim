# M15.78R verification runtime

## Execution boundary

The Fix Engine selects its verifier from server runtime state. In `NODE_ENV=production`, it requires the remote runner URL, HMAC authentication secret, protocol version, and cache-signature public key. Non-production runtimes use the local Docker executor. No request field or customer input can select an executor.

The Trigger task remains the orchestrator. Repository code runs only in the pinned verification container. The dedicated runner control process downloads short-lived private artifact URLs, verifies the request and signed cache, prepares an ephemeral workspace, starts Docker, and persists the bounded job result. The control process does not execute repository code itself.

## Runner deployment contract

Deploy the runner as a dedicated, single-replica service with a durable private volume mounted at `FIX_VERIFICATION_RUNNER_WORK_ROOT`. Multiple replicas are unsupported because nonce replay protection, admission reservations, and dispatch queues are process-local. Do not autoscale this service horizontally. The persistent volume holds authenticated job records; completed records are retained to preserve replay/idempotency behavior. The runner fails closed at 50,000 retained records and returns `verification_runner_job_store_full` for new identities. Operators must provision/rotate the runner store through a reviewed retention migration before reaching that limit; do not delete completed records ad hoc.

The runner control service needs access to a Docker daemon to start the pinned verifier container. Treat that daemon as host-level authority: use a dedicated isolated runner host/VM with no unrelated workloads, do not share its daemon with customer services, and never mount the Docker socket into the verification container. The verifier runs non-root with dropped capabilities, read-only root and dependency-cache mounts, a bounded writable workspace/tmpfs, no network, no credentials, and CPU, memory, PID, time, and output limits.

## Artifact and cache flow

Repository snapshots and patches are uploaded to private storage under exact fix-run/job identities. Snapshot packing excludes `.git`, rejects symlinks and special files, skips sensitive paths, and has a 25 MiB bound. The runner rechecks archive paths, types, byte limits, secret-like values across the complete bounded snapshot, and the artifact fingerprints. Patches are checked against the immutable plan path allowlist, exact patch/base/evidence identities, sensitive-path rules, secret patterns, and size limits before application.

Only the trusted dependency-cache builder has network access. V1 supports npm lockfiles only, verifies the source checkout is clean at the exact commit, accepts registry URLs only from `registry.npmjs.org`, disables lifecycle scripts, and builds under a bounded pinned container. It signs an immutable manifest with Ed25519. The runner verifies the signature, repository/commit/manifest/lockfile/runtime identity, archive digest, and complete dependency-tree fingerprint before mounting the tree read-only. pnpm and Yarn fail closed as `verification_unsupported`.

The remote verifier sends only a signed, short-lived job capability containing artifact fingerprints and time-limited private artifact URLs. It does not send GitHub, Supabase, coding-model, or customer runtime credentials. Runner responses are size-bounded while streaming and authenticated with the request HMAC key; the result signature and identity are validated before stage persistence.

## Configuration names

Production application runtime:

- `FIX_VERIFICATION_RUNNER_URL`
- `FIX_VERIFICATION_RUNNER_AUTH_SECRET`
- `FIX_VERIFICATION_RUNNER_PROTOCOL`
- `FIX_DEPENDENCY_CACHE_PUBLIC_KEY`
- existing private Supabase storage configuration for `fix-engine-verification-artifacts`

Dedicated runner control runtime:

- `FIX_VERIFICATION_RUNNER_AUTH_SECRET`
- `FIX_VERIFICATION_RUNNER_WORK_ROOT`
- `FIX_DEPENDENCY_CACHE_PUBLIC_KEY`
- `NEXT_PUBLIC_SUPABASE_URL` (artifact origin only)
- access to its dedicated Docker daemon

The cache builder is a separate trusted acquisition step and uses `FIX_DEPENDENCY_CACHE_SIGNING_PRIVATE_KEY` only in its isolated process. Its private key is never configured in the application or runner, and never enters the verification container. Existing `FIX_CODING_MODEL_PROVIDER`, `FIX_CODING_MODEL_NAME`, `FIX_CODING_MODEL_ENDPOINT`, `FIX_CODING_MODEL_API_KEY`, and `FIX_GITHUB_DRAFT_PR_WRITES` contracts are unchanged. Draft PR writes are not enabled by this runtime repair.

## Operational limits and failure behavior

The protocol caps requests at 1 MiB, job records at 64 KiB, pending work at 100 jobs, active work at two jobs by default, and retained job identities at 50,000. Limits are fail-closed. Expired capabilities, invalid signatures, identity mismatches, unsupported cache profiles, queue/store capacity, runner timeouts, invalid results, and Docker failures never become verification success. The client reconciles by immutable job ID after ambiguous submission and reuses the completed result without executing the same job again.

This change adds the runtime implementation and local/Docker proof only. Production runner provisioning, Production environment configuration, Trigger deployment, and live Fix Engine acceptance remain separate gates.
