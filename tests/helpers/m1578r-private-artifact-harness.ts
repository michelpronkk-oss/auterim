import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const patchPath = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i;
const verificationPath =
  /^(?:snapshots\/[0-9a-f-]{36}\/[a-f0-9]{64}\.tar\.gz|caches\/[0-9a-f-]{36}\/[a-f0-9]{40,64}\/[a-f0-9]{64}\/(?:manifest\.json|manifest\.sig|dependencies\.tar\.gz))$/i;
const bucketContentTypes: Record<string, ReadonlySet<string>> = {
  "fix-engine-artifacts": new Set(["text/x-diff", "text/plain", "application/octet-stream"]),
  "fix-engine-verification-artifacts": new Set([
    "application/gzip",
    "application/json",
    "application/octet-stream",
  ]),
};

function validObjectPath(bucket: string, objectPath: string) {
  return bucket === "fix-engine-artifacts"
    ? patchPath.test(objectPath)
    : bucket === "fix-engine-verification-artifacts" && verificationPath.test(objectPath);
}

function hmac(secret: Buffer, value: string) {
  return createHmac("sha256", secret).update(value).digest();
}

/** Ephemeral, private local artifact transport for Docker acceptance only. */
export async function createM1578RPrivateArtifactHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "auterim-m1578r-private-artifacts-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  let origin = "";

  const signedUrl = (bucket: string, objectPath: string, expiresIn = 600) => {
    if (!origin || !validObjectPath(bucket, objectPath))
      throw new Error("local_artifact_path_invalid");
    const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(expiresIn, 30), 600);
    const signature = hmac(secret, `${bucket}\n${objectPath}\n${expiresAt}`).toString("hex");
    const url = new URL(`/storage/v1/object/sign/${bucket}/${objectPath}`, origin);
    url.searchParams.set("expires", String(expiresAt));
    url.searchParams.set("signature", signature);
    return url.toString();
  };

  const storage = {
    from(bucket: string) {
      if (!Object.hasOwn(bucketContentTypes, bucket))
        throw new Error("local_artifact_bucket_invalid");
      return {
        async upload(
          objectPath: string,
          data: Buffer | Uint8Array | Blob | string,
          options: { contentType?: string; upsert?: boolean; cacheControl?: string },
        ) {
          if (
            !validObjectPath(bucket, objectPath) ||
            !bucketContentTypes[bucket]!.has(options.contentType ?? "")
          ) {
            return { data: null, error: { name: "StorageApiError", statusCode: "400" } };
          }
          const bytes =
            typeof data === "string"
              ? Buffer.from(data)
              : data instanceof Blob
                ? Buffer.from(await data.arrayBuffer())
                : Buffer.from(data);
          const maxBytes = bucket === "fix-engine-artifacts" ? 128 * 1024 : 512 * 1024 * 1024;
          if (bytes.byteLength < 1 || bytes.byteLength > maxBytes)
            return { data: null, error: { name: "StorageApiError", statusCode: "413" } };
          const destination = path.join(root, bucket, ...objectPath.split("/"));
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          try {
            await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
            return { data: { path: objectPath }, error: null };
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EEXIST"
            )
              return { data: null, error: { name: "StorageApiError", statusCode: "409" } };
            throw error;
          }
        },
        async download(objectPath: string) {
          if (!validObjectPath(bucket, objectPath))
            return { data: null, error: { name: "StorageApiError", statusCode: "400" } };
          try {
            return {
              data: new Blob([await readFile(path.join(root, bucket, ...objectPath.split("/")))]),
              error: null,
            };
          } catch {
            return { data: null, error: { name: "StorageApiError", statusCode: "404" } };
          }
        },
        async createSignedUrl(objectPath: string, expiresIn = 600) {
          if (!validObjectPath(bucket, objectPath))
            return { data: null, error: { name: "StorageApiError", statusCode: "400" } };
          try {
            await readFile(path.join(root, bucket, ...objectPath.split("/")));
            return { data: { signedUrl: signedUrl(bucket, objectPath, expiresIn) }, error: null };
          } catch {
            return { data: null, error: { name: "StorageApiError", statusCode: "404" } };
          }
        },
        async remove(objectPaths: string[]) {
          for (const objectPath of objectPaths.slice(0, 100)) {
            if (!validObjectPath(bucket, objectPath))
              return { data: null, error: { name: "StorageApiError", statusCode: "400" } };
            await rm(path.join(root, bucket, ...objectPath.split("/")), { force: true });
          }
          return { data: [], error: null };
        },
      };
    },
  };

  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://artifact.invalid");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const match =
      /^\/storage\/v1\/object\/sign\/(fix-engine-artifacts|fix-engine-verification-artifacts)\/(.+)$/.exec(
        url.pathname,
      );
    const bucket = match?.[1];
    const objectPath = match?.[2];
    const expiresAt = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature");
    if (
      !bucket ||
      !objectPath ||
      !validObjectPath(bucket, objectPath) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < Math.floor(Date.now() / 1000) ||
      expiresAt > Math.floor(Date.now() / 1000) + 600 ||
      !signature ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      response.writeHead(403).end();
      return;
    }
    const expected = hmac(secret, `${bucket}\n${objectPath}\n${expiresAt}`);
    const supplied = Buffer.from(signature, "hex");
    if (!timingSafeEqual(expected, supplied)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(path.join(root, bucket, ...objectPath.split("/")));
      response
        .writeHead(200, {
          "content-length": bytes.byteLength,
          "cache-control": "private, no-store",
        })
        .end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local_artifact_server_unavailable");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    storage,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
