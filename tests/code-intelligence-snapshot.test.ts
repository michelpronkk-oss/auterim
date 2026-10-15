import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeCodeSnapshot } from "@/lib/code-intelligence/analyzer";
import { collectSnapshotFiles } from "@/trigger/analyze-protected-repository-code";
import { describe, expect, it } from "vitest";

describe("bounded code-intelligence snapshot collection", () => {
  it("records source symlinks as explicit incomplete coverage without following them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "auterim-code-snapshot-"));
    const outside = path.join(root, "..", `${path.basename(root)}-outside`);
    try {
      await mkdir(outside);
      await writeFile(path.join(outside, "source.ts"), "export const outsideSecret = 'must not be read';", "utf8");
      await symlink(outside, path.join(root, "linked.ts"), process.platform === "win32" ? "junction" : "dir");
      await symlink(
        outside,
        path.join(root, "linked-directory"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const files = await collectSnapshotFiles(root);
      expect(files).toContainEqual(
        expect.objectContaining({ path: "linked.ts", skipReason: "symlink_excluded", text: "" }),
      );
      expect(files).toContainEqual(
        expect.objectContaining({
          path: "linked-directory",
          skipReason: "symlink_excluded",
          text: "",
        }),
      );
      expect(JSON.stringify(files)).not.toContain("outsideSecret");
      const analysis = analyzeCodeSnapshot(files);
      expect(analysis.coverageState).toBe("partial");
      expect(analysis.coverageReasonCounts.symlink_excluded).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
