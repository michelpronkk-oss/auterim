import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BUCKET = "fix-engine-artifacts";
const MAX_ARTIFACT_BYTES = 128 * 1024;

export interface PrivatePatchArtifactStore {
  put(input: {
    fixRunId: string;
    attemptId: string;
    diff: string;
  }): Promise<{ bucket: string; path: string; byteCount: number }>;
  get(input: { path: string }): Promise<Uint8Array>;
  createSignedUrl(input: { path: string; expiresIn?: number }): Promise<string>;
  createSignedReference(input: {
    path: string;
    sha256: string;
    byteCount: number;
    expiresIn?: number;
  }): Promise<{
    bucket: string;
    path: string;
    sha256: string;
    byteCount: number;
    signedUrl: string;
  }>;
  remove(input: { paths: string[] }): Promise<void>;
}

export class SupabasePrivatePatchArtifactStore implements PrivatePatchArtifactStore {
  async put(input: { fixRunId: string; attemptId: string; diff: string }) {
    if (!/^[0-9a-f-]{36}$/i.test(input.fixRunId) || !/^[0-9a-f-]{36}$/i.test(input.attemptId))
      throw new Error("invalid_patch_artifact_identity");
    const bytes = Buffer.from(input.diff, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("patch_artifact_size_invalid");
    const path = `${input.fixRunId}/${input.attemptId}.diff`;
    const { error } = await createSupabaseServerClient().storage.from(BUCKET).upload(path, bytes, {
      contentType: "text/x-diff",
      upsert: false,
      cacheControl: "0",
    });
    if (error) throw new Error("private_patch_artifact_upload_failed");
    return { bucket: BUCKET, path, byteCount: bytes.byteLength };
  }

  async get(input: { path: string }) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i.test(input.path))
      throw new Error("invalid_patch_artifact_path");
    const { data, error } = await createSupabaseServerClient()
      .storage.from(BUCKET)
      .download(input.path);
    if (error || !data) throw new Error("private_patch_artifact_read_failed");
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("patch_artifact_size_invalid");
    return bytes;
  }

  async createSignedUrl(input: { path: string; expiresIn?: number }) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i.test(input.path))
      throw new Error("invalid_patch_artifact_path");
    const { data, error } = await createSupabaseServerClient()
      .storage.from(BUCKET)
      .createSignedUrl(input.path, Math.min(Math.max(input.expiresIn ?? 600, 30), 600));
    if (error || !data?.signedUrl) throw new Error("private_patch_artifact_sign_failed");
    return data.signedUrl;
  }

  async createSignedReference(input: {
    path: string;
    sha256: string;
    byteCount: number;
    expiresIn?: number;
  }) {
    if (
      !/^[0-9a-f-]{36}\/([0-9a-f-]{36})\.diff$/i.test(input.path) ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.byteCount) ||
      input.byteCount < 1 ||
      input.byteCount > MAX_ARTIFACT_BYTES
    )
      throw new Error("invalid_patch_artifact_reference");
    const signedUrl = await this.createSignedUrl({ path: input.path, expiresIn: input.expiresIn });
    return {
      bucket: BUCKET,
      path: input.path,
      sha256: input.sha256,
      byteCount: input.byteCount,
      signedUrl,
    };
  }

  async remove(input: { paths: string[] }) {
    const safe = input.paths
      .filter((path) => /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i.test(path))
      .slice(0, 100);
    if (safe.length === 0) return;
    const { error } = await createSupabaseServerClient().storage.from(BUCKET).remove(safe);
    if (error) throw new Error("private_patch_artifact_cleanup_failed");
  }
}
