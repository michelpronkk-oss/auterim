import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createM1578RPrivateArtifactHarness } from "./helpers/m1578r-private-artifact-harness";

const artifactStorageRef = vi.hoisted(() => ({
  current: null as null | { from: (bucket: string) => unknown },
}));

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return {
    ...actual,
    createSupabaseServerClient: () => {
      const client = actual.createSupabaseServerClient();
      const storage = artifactStorageRef.current;
      if (!storage) return client;
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "storage") return storage;
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
import {
  createDependencyCacheIdentity,
  dependencyCacheManifestForSigning,
  inspectDependencyCacheTree,
  resolveTrustedDependencyCache,
  serializeDependencyCacheManifest,
} from "@/lib/fix-engine/dependency-cache";
import { createFixEngineStageProcessor } from "@/lib/fix-engine/stage-processor";
import type { FixStageProcessor } from "@/lib/fix-engine/stage-runtime";
import { stableFingerprint } from "@/lib/fix-engine/identity";
import type { FixCodingModel, FixModelContext, ModelEnvelope } from "@/lib/fix-engine/model";
import { createPersistedFixRun, runPersistedFixStage } from "@/lib/fix-engine/stage-runtime";
import type { FixStage } from "@/lib/fix-engine/contracts";
import type { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import { dependencyCacheIdentityKey } from "@/lib/fix-engine/dependency-cache";
import { packSafeDirectory } from "../verification-runner/archive";
import {
  canonicalJson,
  sha256 as runnerSha256,
  type DependencyCacheManifestV2,
} from "../verification-runner/contracts";
import {
  createSignedDependencyCacheReference,
  putSignedDependencyCacheArtifacts,
} from "@/lib/fix-engine/verification-artifacts";
import { RemoteVerificationExecutor } from "@/lib/fix-engine/verification-executor";
import { RemoteVerificationRunnerClient } from "@/lib/fix-engine/verification-runner-client";
import { createVerificationRunnerServer } from "../verification-runner/server";

const enabled = process.env.AUTERIM_M1578_DOCKER_ACCEPTANCE === "1";
const url = process.env.AUTERIM_M1578_EXPECTED_URL;
const serviceKey = process.env.AUTERIM_M1578_SERVICE_KEY;
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const productId = "de1f2a12-de3c-4644-8892-b6c2d458a300";
const repositoryId = "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe";
const sha256 = (value: string) => stableFingerprint(value);
const remoteAcceptance = process.env.AUTERIM_M1578R_DOCKER_ACCEPTANCE === "1";
const runnerServers: Array<ReturnType<typeof createVerificationRunnerServer>> = [];
const runnerRoots: string[] = [];
let artifactHarness: Awaited<ReturnType<typeof createM1578RPrivateArtifactHarness>> | null = null;

beforeAll(async () => {
  artifactHarness = await createM1578RPrivateArtifactHarness();
  artifactStorageRef.current = artifactHarness.storage;
});

afterAll(async () => {
  await Promise.all(runnerServers.map((runner) => runner.close()));
  await Promise.all(runnerRoots.map((root) => rm(root, { recursive: true, force: true })));
  artifactStorageRef.current = null;
  await artifactHarness?.close();
});

function envelope<T>(stage: string, modelName: string, value: T): ModelEnvelope<T> {
  return {
    provider: "fixture",
    model: modelName,
    modelVersion: "fixture-v1",
    schemaVersion: "fix-engine-v1",
    promptContractVersion: "fix-engine-docker-fixture-v1",
    inputFingerprint: sha256(`${stage}:input`),
    outputFingerprint: sha256(JSON.stringify(value)),
    usage: { latencyMs: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 },
    value,
  };
}

async function makeSignedFixtureCache(input: {
  identity: NonNullable<ReturnType<typeof createDependencyCacheIdentity>>;
  publicKey: KeyObject;
  privateKey: KeyObject;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "auterim-m1578-verified-cache-"));
  const slot = path.join(
    root,
    input.identity.repositoryId,
    input.identity.commitSha,
    input.identity.runtimeProfile,
  );
  const nodeModules = path.join(slot, "node_modules");
  const vitestDirectory = path.join(nodeModules, "vitest");
  const tscDirectory = path.join(nodeModules, "typescript", "bin");
  await mkdir(vitestDirectory, { recursive: true });
  await mkdir(tscDirectory, { recursive: true });
  await writeFile(
    path.join(vitestDirectory, "vitest.mjs"),
    "if (process.argv[2] !== 'run') process.exit(1); process.exit(0);\n",
  );
  await writeFile(
    path.join(tscDirectory, "tsc"),
    "if (process.argv[2] !== '--noEmit') process.exit(1); process.exit(0);\n",
  );
  const setReadOnly = async (target: string): Promise<void> => {
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) await setReadOnly(fullPath);
      await chmod(fullPath, entry.isDirectory() ? 0o555 : 0o444);
    }
    await chmod(target, 0o555);
  };
  await setReadOnly(nodeModules);
  const tree = await inspectDependencyCacheTree(nodeModules);
  const manifest = dependencyCacheManifestForSigning({
    identity: input.identity,
    treeSha256: tree.treeSha256,
    fileCount: tree.files.length,
    byteCount: tree.byteCount,
  });
  const serialized = serializeDependencyCacheManifest(manifest);
  await writeFile(path.join(slot, "manifest.json"), serialized);
  await writeFile(
    path.join(slot, "manifest.sig"),
    sign(null, Buffer.from(serialized), input.privateKey).toString("base64"),
  );
  await chmod(path.join(slot, "manifest.json"), 0o444);
  await chmod(path.join(slot, "manifest.sig"), 0o444);
  await chmod(slot, 0o555);
  return { root, nodeModulesPath: nodeModules };
}

async function makeSignedRemoteFixtureCache(input: {
  identity: NonNullable<ReturnType<typeof createDependencyCacheIdentity>>;
  privateKey: KeyObject;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "auterim-m1578r-cache-"));
  const nodeModules = path.join(root, "node_modules");
  const vitestDirectory = path.join(nodeModules, "vitest");
  const tscDirectory = path.join(nodeModules, "typescript", "bin");
  await mkdir(vitestDirectory, { recursive: true });
  await mkdir(tscDirectory, { recursive: true });
  await writeFile(
    path.join(vitestDirectory, "vitest.mjs"),
    "if (process.argv[2] !== 'run') process.exit(1); process.exit(0);\n",
  );
  await writeFile(
    path.join(tscDirectory, "tsc"),
    "if (process.argv[2] !== '--noEmit') process.exit(1); process.exit(0);\n",
  );
  const setReadOnly = async (target: string): Promise<void> => {
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) await setReadOnly(fullPath);
      await chmod(fullPath, entry.isDirectory() ? 0o555 : 0o444);
    }
    await chmod(target, 0o555);
  };
  await setReadOnly(nodeModules);
  const tree = await inspectDependencyCacheTree(nodeModules);
  const archivePath = path.join(root, "dependencies.tar.gz");
  const archiveInfo = await packSafeDirectory(nodeModules, archivePath, {
    maxFiles: 50_000,
    maxBytes: 512 * 1024 * 1024,
  });
  expect(archiveInfo.byteCount).toBe(tree.byteCount);
  const archive = await readFile(archivePath);
  const manifestPayload = {
    schemaVersion: 2 as const,
    buildStatus: "complete" as const,
    identity: { ...input.identity, packageManager: "npm" as const },
    identityKey: dependencyCacheIdentityKey({ ...input.identity, packageManager: "npm" }),
    // The V2 signed runner manifest uses the versioned canonical JSON
    // fingerprint format shared with the Linux cache finalizer.
    treeSha256: runnerSha256(canonicalJson(tree.files)),
    archiveSha256: runnerSha256(archive),
    artifactFingerprint: runnerSha256(archive),
    signatureAlgorithm: "ed25519" as const,
    createdAt: new Date().toISOString(),
    fileCount: tree.files.length,
    byteCount: tree.byteCount,
    archiveByteCount: archive.byteLength,
  };
  const manifest: DependencyCacheManifestV2 = {
    ...manifestPayload,
    manifestFingerprint: runnerSha256(canonicalJson(manifestPayload)),
  };
  const serialized = canonicalJson(manifest);
  const signature = sign(null, Buffer.from(serialized), input.privateKey);
  return { root, manifest, signature, archive };
}

describe.skipIf(!enabled)(
  "M15.78 canonical persisted stage processor on isolated Docker Supabase",
  () => {
    // The remote executor can poll for 240 seconds; keep the enclosing Docker test bounded above it.
    it("runs create_fix_run_from_graph through diagnose, plan, patch, real Docker verify and risk", async () => {
      expect(url).toBe(process.env.AUTERIM_M1578_EXPECTED_URL ?? "http://127.0.0.1:54970");
      expect(serviceKey?.length).toBeGreaterThan(20);
      const client = createClient(url!, serviceKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: sources, error: sourceError } = await client
        .from("source_changes")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("scope_product_id", productId)
        .eq("source_mode", "internal_test")
        .eq("processing_mode", "evidence_only");
      expect(sourceError).toBeNull();
      const sourceIds = (sources ?? []).map((source) => source.id);
      expect(sourceIds.length).toBeGreaterThan(0);

      const { data: graph, error: graphError } = await client
        .from("impact_graph_builds")
        .select(
          "id,source_change_id,workspace_id,product_id,repository_id,commit_sha,status,assessment_state",
        )
        .eq("workspace_id", workspaceId)
        .eq("product_id", productId)
        .eq("repository_id", repositoryId)
        .eq("status", "completed")
        .eq("assessment_state", "evidence_present")
        .in("source_change_id", sourceIds)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      expect(graphError).toBeNull();
      expect(graph).not.toBeNull();
      expect(graph?.commit_sha).toMatch(/^[a-f0-9]{40,64}$/);

      const { data: edge, error: edgeError } = await client
        .from("impact_graph_edges")
        .select(
          "id,evidence_type,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column",
        )
        .eq("graph_build_id", graph!.id)
        .eq("edge_kind", "observed")
        .not("evidence_path", "is", null)
        .not("evidence_start_line", "is", null)
        .not("evidence_start_column", "is", null)
        .not("evidence_end_line", "is", null)
        .not("evidence_end_column", "is", null)
        .order("edge_fingerprint", { ascending: true })
        .limit(1)
        .single();
      expect(edgeError).toBeNull();
      if (!edge) throw new Error("fix_fixture_observed_edge_missing");
      const existingPolicy = await client
        .from("product_remediation_policies")
        .select("product_id")
        .eq("workspace_id", workspaceId)
        .eq("product_id", productId)
        .maybeSingle();
      expect(existingPolicy.error).toBeNull();
      if (!existingPolicy.data) {
        const insertedPolicy = await client.from("product_remediation_policies").insert({
          workspace_id: workspaceId,
          product_id: productId,
          enabled: true,
          human_review_required: true,
          draft_pr_preparation_allowed: true,
          automatic_workflow_handoff_allowed: false,
          approval_required: true,
          allowed_repository_ids: [repositoryId],
        });
        expect(insertedPolicy.error).toBeNull();
      }
      const staleCreated = await createPersistedFixRun(graph!.id);
      const { data: policy, error: policyError } = await client
        .from("product_remediation_policies")
        .select("policy_version")
        .eq("workspace_id", workspaceId)
        .eq("product_id", productId)
        .single();
      expect(policyError).toBeNull();
      const policyChange = await client
        .from("product_remediation_policies")
        .update({ policy_version: policy!.policy_version + 1 })
        .eq("workspace_id", workspaceId)
        .eq("product_id", productId)
        .eq("policy_version", policy!.policy_version);
      expect(policyChange.error).toBeNull();
      let staleRunProcessorCalls = 0;
      const staleRunClaim = await runPersistedFixStage({
        fixRunId: staleCreated.fixRunId,
        stage: "diagnose",
        processor: async () => {
          staleRunProcessorCalls += 1;
          throw new Error("stale_policy_must_not_execute");
        },
      });
      expect(staleRunClaim.status).toBe("stale_policy");
      expect(staleRunProcessorCalls).toBe(0);

      const created = await createPersistedFixRun(graph!.id);
      const replayedCreate = await createPersistedFixRun(graph!.id);
      expect(replayedCreate.fixRunId).toBe(created.fixRunId);
      expect(replayedCreate.idempotencyKey).toBe(created.idempotencyKey);

      const { data: run, error: runError } = await client
        .from("fix_runs")
        .select(
          "id,workspace_id,product_id,repository_id,source_change_id,analysis_run_id,commit_sha,evidence_fingerprint,identity_fingerprint,source_mode,processing_mode,provenance_mode,preflight_required,review_disposition,review_reason,production_exposure_state",
        )
        .eq("id", created.fixRunId)
        .single();
      expect(runError).toBeNull();
      expect(run).toMatchObject({
        workspace_id: workspaceId,
        product_id: productId,
        repository_id: repositoryId,
        commit_sha: graph!.commit_sha,
        source_mode: "internal_test",
        processing_mode: "evidence_only",
        provenance_mode: "evidence_only",
        preflight_required: false,
        review_disposition: "review_required",
        review_reason: "critical_change",
        production_exposure_state: "unknown",
      });

      const packageJson =
        JSON.stringify({
          name: "m1578-verification-fixture",
          devDependencies: { vitest: "1.0.0", typescript: "1.0.0" },
        }) + "\n";
      const packageLock =
        JSON.stringify({
          name: "m1578-verification-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "m1578-verification-fixture",
              version: "1.0.0",
              devDependencies: { vitest: "1.0.0", typescript: "1.0.0" },
            },
          },
        }) + "\n";
      const sourceText = 'export const before = "source";\n';
      const cacheKeys = generateKeyPairSync("ed25519");
      let cacheRootPath: string | null = null;
      let verificationExecutor: RemoteVerificationExecutor | undefined;
      let resolveRemoteDependencyCache:
        | ((
            identity: NonNullable<ReturnType<typeof createDependencyCacheIdentity>>,
          ) => ReturnType<typeof createSignedDependencyCacheReference>)
        | undefined;
      if (remoteAcceptance) {
        const runnerRoot = await mkdtemp(path.join(os.tmpdir(), "auterim-m1578r-runner-"));
        runnerRoots.push(runnerRoot);
        const authSecret = randomBytes(32).toString("hex");
        const publicKey = cacheKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
        const runner = createVerificationRunnerServer({
          authSecret,
          artifactOrigin: artifactHarness!.origin,
          cachePublicKey: publicKey,
          jobStorePath: path.join(runnerRoot, "jobs"),
          workRoot: path.join(runnerRoot, "work"),
        });
        const address = await runner.listen(0, "127.0.0.1");
        runnerServers.push(runner);
        verificationExecutor = new RemoteVerificationExecutor(
          new RemoteVerificationRunnerClient({
            url: `http://127.0.0.1:${address.port}`,
            authSecret,
            maxWaitMs: 240_000,
          }),
        );
        resolveRemoteDependencyCache = async (identity) => {
          const cache = await makeSignedRemoteFixtureCache({
            identity,
            privateKey: cacheKeys.privateKey,
          });
          cacheRootPath = cache.root;
          await putSignedDependencyCacheArtifacts({
            identity,
            manifest: cache.manifest,
            signature: cache.signature,
            archive: cache.archive,
          });
          return createSignedDependencyCacheReference({ identity, publicKey });
        };
      }
      let returnInvalidDiagnosis = false;
      let diagnosisProviderCalls = 0;
      const fixtureModel: FixCodingModel = {
        // The deterministic adapter simulates the frozen Production provider
        // identity without making a network model call in Docker.
        provider: "azure-openai",
        modelName: "gpt-6.1-sol",
        diagnose: async (context: FixModelContext) => {
          diagnosisProviderCalls += 1;
          const item = context.graphEvidence[0];
          if (!item) throw new Error("fixture_graph_evidence_missing");
          const proposal = {
            rootCauseCategory: "endpoint_contract_changed",
            affectedLocations: [
              {
                evidenceId: item.id,
                span: { path: item.path, ...item.span },
                symbol: null,
                externalEntity: item.externalEntity,
              },
            ],
            recommendedTransformationClass: "endpoint_replacement",
            confidenceClass: "exact",
            changeFamily: "endpoint",
          };
          return envelope(
            "diagnose",
            "m1578-deterministic-model-v1",
            returnInvalidDiagnosis
              ? { ...proposal, untrustedExtra: "must-not-be-logged" }
              : proposal,
          );
        },
        plan: async (_context: FixModelContext, diagnosis: unknown) => {
          const item = (
            diagnosis as {
              affectedLocations: Array<{ evidenceId: string; span: { path: string } }>;
            }
          ).affectedLocations[0];
          return envelope("plan", "m1578-deterministic-model-v1", {
            allowedFiles: [
              {
                path: item!.span.path,
                evidenceIds: [item!.evidenceId],
                transformations: ["endpoint_replacement"],
              },
            ],
            preconditions: ["the exact observed code location is present"],
            postconditions: ["the bounded endpoint replacement is present"],
            dependencyChanges: [],
            apiSchemaConfigChanges: ["api"],
            expectedTests: [],
            verificationProfile: "javascript-typescript-v1",
            preflightApplicability: "not_applicable",
            riskFactors: [],
            humanReviewRequired: true,
          });
        },
        proposePatch: async (context, _diagnosis, plan) =>
          envelope("patch", "m1578-deterministic-model-v1", {
            unifiedDiff: [
              `diff --git a/${edge.evidence_path} b/${edge.evidence_path}`,
              `--- a/${edge.evidence_path}`,
              `+++ b/${edge.evidence_path}`,
              "@@ -1 +1 @@",
              '-export const before = "source";',
              '+export const after = "candidate";',
              "",
            ].join("\n"),
            baseSha: context.commitSha,
            planFingerprint: stableFingerprint(plan),
            evidenceFingerprint: run!.evidence_fingerprint,
            attemptIdentity: "c0000000-0000-4000-8000-000000000001",
          }),
      };
      const repositoryProvider = {
        getFile: async (_target: unknown, filePath: string) => ({
          path: filePath,
          text: sourceText,
          size: Buffer.byteLength(sourceText),
        }),
        materializeRepository: async (_target: unknown, commitSha: string, destination: string) => {
          if (commitSha !== graph!.commit_sha) throw new Error("fixture_commit_identity_mismatch");
          await mkdir(path.dirname(path.join(destination, edge.evidence_path!)), {
            recursive: true,
          });
          await writeFile(path.join(destination, "package.json"), packageJson);
          await writeFile(path.join(destination, "package-lock.json"), packageLock);
          await writeFile(path.join(destination, edge.evidence_path!), sourceText);
          return { skippedLinks: 0 };
        },
        getHead: async () => graph!.commit_sha,
      } as unknown as Pick<
        GitHubAppRepositoryProvider,
        "getFile" | "materializeRepository" | "getHead"
      >;
      const processor = createFixEngineStageProcessor({
        model: fixtureModel,
        repositoryProvider,
        ...(verificationExecutor ? { verificationExecutor } : {}),
        ...(resolveRemoteDependencyCache ? { resolveRemoteDependencyCache } : {}),
        resolveDependencyCache: async (identity) => {
          if (!identity) return { status: "unavailable", reason: "cache_not_configured" };
          const cache = await makeSignedFixtureCache({ identity, ...cacheKeys });
          cacheRootPath = cache.root;
          const verified = await resolveTrustedDependencyCache({
            root: cache.root,
            publicKey: cacheKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
            identity,
          });
          if (verified.status !== "available") throw new Error(`fixture_cache_${verified.status}`);
          return verified;
        },
      });

      let diagnosisFailureCount = 0;
      const retryTestProcessor: FixStageProcessor = async (input) => {
        if (diagnosisFailureCount >= 2) return processor(input);
        diagnosisFailureCount += 1;
        const failureCategory =
          diagnosisFailureCount === 1
            ? "fix_model_provider_rejected_401"
            : "fix_model_provider_rejected_400";
        const started = await client.rpc("begin_fix_model_attempt", {
          p_stage_id: input.stageId,
          p_claim_token: input.claimToken,
          p_attempt_number: input.attemptNumber,
          p_provider: "azure-openai",
          p_model: "gpt-6.1-sol",
          p_schema_version: "fix-engine-v1",
          p_prompt_contract_version: "fix-coding-contract-v2",
          p_input_fingerprint: "c".repeat(64),
        });
        expect(started.error).toBeNull();
        const attemptId = (started.data as { attemptId?: unknown } | null)?.attemptId;
        expect(typeof attemptId).toBe("string");
        const finished = await client.rpc("finish_fix_model_attempt", {
          p_stage_id: input.stageId,
          p_claim_token: input.claimToken,
          p_attempt_id: attemptId,
          p_status: "failed",
          p_model_version: null,
          p_output_fingerprint: null,
          p_latency_ms: 1,
          p_input_tokens: null,
          p_output_tokens: null,
          p_cost_microusd: null,
          p_failure_category: failureCategory,
        });
        expect(finished.error).toBeNull();
        throw new Error(failureCategory);
      };
      await expect(
        runPersistedFixStage({
          fixRunId: created.fixRunId,
          stage: "diagnose",
          processor: retryTestProcessor,
        }),
      ).rejects.toThrow("fix_model_provider_rejected_401");

      const requeued = await client.rpc("requeue_internal_fix_diagnosis_after_model_auth_repair", {
        p_fix_run_id: created.fixRunId,
      });
      expect(requeued.error).toBeNull();
      expect(requeued.data).toMatchObject({
        status: "retry_queued",
        fixRunId: created.fixRunId,
        retryGeneration: 1,
      });
      const requeueReplay = await client.rpc(
        "requeue_internal_fix_diagnosis_after_model_auth_repair",
        { p_fix_run_id: created.fixRunId },
      );
      expect(requeueReplay.error).toBeNull();
      expect(requeueReplay.data).toMatchObject({
        status: "already_used",
        fixRunId: created.fixRunId,
        retryGeneration: 1,
      });

      await expect(
        runPersistedFixStage({
          fixRunId: created.fixRunId,
          stage: "diagnose",
          processor: retryTestProcessor,
        }),
      ).rejects.toThrow("fix_model_provider_rejected_400");
      const requestShapeRetry = await client.rpc(
        "requeue_internal_fix_diagnosis_after_model_auth_repair",
        { p_fix_run_id: created.fixRunId },
      );
      expect(requestShapeRetry.error).toBeNull();
      expect(requestShapeRetry.data).toMatchObject({
        status: "retry_queued",
        fixRunId: created.fixRunId,
        retryGeneration: 2,
      });
      const requestShapeReplay = await client.rpc(
        "requeue_internal_fix_diagnosis_after_model_auth_repair",
        { p_fix_run_id: created.fixRunId },
      );
      expect(requestShapeReplay.error).toBeNull();
      expect(requestShapeReplay.data).toMatchObject({
        status: "already_used",
        fixRunId: created.fixRunId,
        retryGeneration: 2,
      });
      const anonymousClient = createClient(url!, process.env.AUTERIM_M1578_ANON_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const deniedRetry = await anonymousClient.rpc(
        "requeue_internal_fix_diagnosis_after_model_auth_repair",
        { p_fix_run_id: created.fixRunId },
      );
      expect(deniedRetry.error).not.toBeNull();
      const { data: retryState, error: retryStateError } = await client
        .from("fix_stage_queue")
        .select("status,attempt_count,operator_retry_count")
        .eq("fix_run_id", created.fixRunId)
        .eq("stage", "diagnose")
        .single();
      expect(retryStateError).toBeNull();
      expect(retryState).toEqual({ status: "queued", attempt_count: 2, operator_retry_count: 2 });

      returnInvalidDiagnosis = true;
      await expect(
        runPersistedFixStage({
          fixRunId: created.fixRunId,
          stage: "diagnose",
          processor: retryTestProcessor,
        }),
      ).rejects.toThrow("fix_diagnosis_schema_invalid");
      returnInvalidDiagnosis = false;

      const [
        { data: failedStage, error: failedStageError },
        { data: modelAttempts, error: attemptsError },
      ] = await Promise.all([
        client
          .from("fix_stage_queue")
          .select("status,attempt_count,operator_retry_count,failure_category")
          .eq("fix_run_id", created.fixRunId)
          .eq("stage", "diagnose")
          .single(),
        client
          .from("fix_model_attempts")
          .select(
            "attempt_number,status,failure_category,provider,model,input_tokens,output_tokens,output_fingerprint",
          )
          .eq("fix_run_id", created.fixRunId)
          .eq("stage", "diagnose")
          .order("attempt_number"),
      ]);
      expect(failedStageError).toBeNull();
      expect(attemptsError).toBeNull();
      expect(failedStage).toMatchObject({
        status: "failed",
        attempt_count: 3,
        operator_retry_count: 2,
        failure_category: "fix_diagnosis_schema_invalid",
      });
      expect(modelAttempts).toHaveLength(3);
      expect(modelAttempts?.[0]).toMatchObject({
        attempt_number: 1,
        status: "failed",
        failure_category: "fix_model_provider_rejected_401",
        provider: "azure-openai",
        model: "gpt-6.1-sol",
      });
      expect(modelAttempts?.[1]).toMatchObject({
        attempt_number: 2,
        status: "failed",
        failure_category: "fix_model_provider_rejected_400",
        provider: "azure-openai",
        model: "gpt-6.1-sol",
      });
      expect(modelAttempts?.[2]).toMatchObject({
        attempt_number: 3,
        status: "succeeded",
        failure_category: null,
        provider: "azure-openai",
        model: "gpt-6.1-sol",
        input_tokens: 0,
        output_tokens: 0,
      });
      const diagnosesBeforeRecovery = await client
        .from("fix_diagnoses")
        .select("id")
        .eq("fix_run_id", created.fixRunId);
      expect(diagnosesBeforeRecovery.error).toBeNull();
      expect(diagnosesBeforeRecovery.data).toEqual([]);

      const recovery = await client.rpc("authorize_internal_fix_diagnosis_recovery", {
        p_fix_run_id: created.fixRunId,
        p_authorization_reference: "M15.78R user-authorized single post-model recovery",
        p_trigger_run_id: "run_dockeracceptance12345678",
      });
      expect(recovery.error).toBeNull();
      expect(recovery.data).toMatchObject({
        status: "retry_queued",
        fixRunId: created.fixRunId,
        recoveryGeneration: 1,
      });
      const recoveryReplay = await client.rpc("authorize_internal_fix_diagnosis_recovery", {
        p_fix_run_id: created.fixRunId,
        p_authorization_reference: "M15.78R user-authorized single post-model recovery",
        p_trigger_run_id: "run_dockeracceptance12345678",
      });
      expect(recoveryReplay.error).toBeNull();
      expect(recoveryReplay.data).toMatchObject({
        status: "already_authorized",
        recoveryGeneration: 1,
      });

      const recoveryLedger = await client
        .from("fix_stage_recovery_authorizations")
        .select(
          "workspace_id,product_id,repository_id,source_change_id,commit_sha,graph_build_id,analysis_run_id,identity_fingerprint,evidence_fingerprint,prior_run_status,prior_run_failure_category,prior_stage_status,prior_stage_failure_category,prior_attempt_count,prior_operator_retry_count,prior_model_output_fingerprint,authorization_actor,authorization_reference,authorization_reason",
        )
        .eq("fix_run_id", created.fixRunId)
        .single();
      expect(recoveryLedger.error).toBeNull();
      expect(recoveryLedger.data).toMatchObject({
        workspace_id: workspaceId,
        product_id: productId,
        repository_id: repositoryId,
        source_change_id: run!.source_change_id,
        commit_sha: graph!.commit_sha,
        graph_build_id: graph!.id,
        analysis_run_id: run!.analysis_run_id,
        identity_fingerprint: run!.identity_fingerprint,
        evidence_fingerprint: run!.evidence_fingerprint,
        prior_run_status: "diagnosis_failed",
        prior_attempt_count: 3,
        prior_operator_retry_count: 2,
        prior_run_failure_category: "fix_diagnosis_schema_invalid",
        prior_stage_status: "failed",
        prior_stage_failure_category: "fix_diagnosis_schema_invalid",
        authorization_actor: "codex_operator",
        authorization_reference: "M15.78R user-authorized single post-model recovery",
        authorization_reason: "diagnosis_contract_observability_repair",
      });
      expect(recoveryLedger.data?.prior_model_output_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const recoveryCount = await client
        .from("fix_stage_recovery_authorizations")
        .select("id", { count: "exact", head: true })
        .eq("fix_run_id", created.fixRunId)
        .eq("stage", "diagnose");
      expect(recoveryCount.error).toBeNull();
      expect(recoveryCount.count).toBe(1);

      const deniedRecovery = await anonymousClient.rpc(
        "authorize_internal_fix_diagnosis_recovery",
        {
          p_fix_run_id: created.fixRunId,
          p_authorization_reference: "M15.78R user-authorized single post-model recovery",
          p_trigger_run_id: "run_dockeracceptance12345678",
        },
      );
      expect(deniedRecovery.error).not.toBeNull();

      const recoveredDiagnosis = await runPersistedFixStage({
        fixRunId: created.fixRunId,
        stage: "diagnose",
        processor: retryTestProcessor,
      });
      expect(recoveredDiagnosis).toMatchObject({
        status: "completed",
        nextStage: "plan",
        replayed: false,
      });
      const recoveredStage = await client
        .from("fix_stage_queue")
        .select("status,attempt_count,operator_retry_count")
        .eq("fix_run_id", created.fixRunId)
        .eq("stage", "diagnose")
        .single();
      expect(recoveredStage.data).toEqual({
        status: "completed",
        attempt_count: 4,
        operator_retry_count: 2,
      });
      expect(diagnosisProviderCalls).toBe(2);

      const stages: FixStage[] = ["diagnose"];
      let stage: FixStage | null = recoveredDiagnosis.nextStage;
      while (stage) {
        if (stages.length >= 8) throw new Error("fix_stage_bound_exceeded");
        stages.push(stage);
        const result = await runPersistedFixStage({ fixRunId: created.fixRunId, stage, processor });
        expect(result.status).toBe("completed");
        stage = result.nextStage;
      }
      expect(stages).toEqual([
        "diagnose",
        "plan",
        "generate_patch",
        "apply_patch",
        "verify_patch",
        "risk_assess",
      ]);

      const [
        { data: completedRun, error: completedRunError },
        { data: verification, error: verificationError },
        { data: queues, error: queuesError },
      ] = await Promise.all([
        client
          .from("fix_runs")
          .select(
            "status,current_stage,risk_level,preflight_required,review_disposition,review_reason,production_exposure_state",
          )
          .eq("id", created.fixRunId)
          .single(),
        client
          .from("fix_verification_runs")
          .select("status,profile_id,checks,patch_fingerprint")
          .eq("fix_run_id", created.fixRunId)
          .single(),
        client.from("fix_stage_queue").select("stage,status").eq("fix_run_id", created.fixRunId),
      ]);
      expect(completedRunError).toBeNull();
      expect(verificationError).toBeNull();
      expect(queuesError).toBeNull();
      expect(completedRun).toMatchObject({
        status: "candidate_validated",
        current_stage: "risk_assess",
        preflight_required: false,
        risk_level: "LOW",
        review_disposition: "review_required",
        review_reason: "critical_change",
        production_exposure_state: "unknown",
      });
      expect(verification).toMatchObject({
        status: "passed",
        profile_id: "javascript-typescript-v1",
      });
      if (remoteAcceptance) {
        const { data: retainedSnapshot, error: retainedSnapshotError } = await client
          .from("fix_verification_snapshots")
          .select(
            "workspace_id,fix_run_id,snapshot_sha256,artifact_path,status,terminal_at,purged_at",
          )
          .eq("workspace_id", workspaceId)
          .eq("fix_run_id", created.fixRunId)
          .single();
        expect(retainedSnapshotError).toBeNull();
        expect(retainedSnapshot).toMatchObject({
          workspace_id: workspaceId,
          fix_run_id: created.fixRunId,
          status: "terminal",
          purged_at: null,
        });
        expect(retainedSnapshot?.artifact_path).toBe(
          `snapshots/${created.fixRunId}/${retainedSnapshot?.snapshot_sha256}.tar.gz`,
        );
      }
      expect(
        (verification?.checks as Array<{ status: string }>).every(
          (check) => check.status === "passed",
        ),
      ).toBe(true);
      expect(
        queues?.some((queue) => queue.stage === "preflight" || queue.stage === "create_draft_pr"),
      ).toBe(false);
      const [preflight, external, pr] = await Promise.all([
        client.from("fix_preflight_results").select("id").eq("fix_run_id", created.fixRunId),
        client.from("fix_external_operations").select("id").eq("fix_run_id", created.fixRunId),
        client.from("fix_pr_outcomes").select("id").eq("fix_run_id", created.fixRunId),
      ]);
      expect(preflight.data).toEqual([]);
      expect(external.data).toEqual([]);
      expect(pr.data).toEqual([]);
      let replayCalls = 0;
      const replay = await runPersistedFixStage({
        fixRunId: created.fixRunId,
        stage: "diagnose",
        processor: async () => {
          replayCalls += 1;
          throw new Error("completed_stage_reexecuted");
        },
      });
      expect(replay).toMatchObject({ status: "completed", replayed: true });
      expect(replayCalls).toBe(0);
      expect(diagnosisProviderCalls).toBe(2);
      const diagnosisRows = await client
        .from("fix_diagnoses")
        .select("id,output_fingerprint")
        .eq("fix_run_id", created.fixRunId);
      expect(diagnosisRows.error).toBeNull();
      expect(diagnosisRows.data).toHaveLength(1);
      if (cacheRootPath) await rm(cacheRootPath, { recursive: true, force: true });
    }, 270_000);
  },
);
