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

  async remove(input: { paths: string[] }) {
    const safe = input.paths
      .filter((path) => /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i.test(path))
      .slice(0, 100);
    if (safe.length === 0) return;
    const { error } = await createSupabaseServerClient().storage.from(BUCKET).remove(safe);
    if (error) throw new Error("private_patch_artifact_cleanup_failed");
  }
}
