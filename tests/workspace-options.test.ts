import { describe, expect, it } from "vitest";
import { normalizeWorkspaceOptions, resolveSelectedWorkspaceId } from "@/lib/app/workspace-options";

const workspace = (workspaceId: string, name: string, active = true, role = "owner") => ({
  workspaceId,
  name,
  role,
  active,
});

describe("workspace selector options", () => {
  it("keeps a single authorized workspace", () => {
    expect(normalizeWorkspaceOptions([workspace("one", "Auterim")])).toMatchObject([
      { workspaceId: "one", name: "Auterim", selectorLabel: "Auterim" },
    ]);
  });

  it("keeps multiple authorized workspaces", () => {
    expect(
      normalizeWorkspaceOptions([workspace("one", "Auterim"), workspace("two", "Test")]),
    ).toHaveLength(2);
  });

  it("disambiguates distinct workspace IDs with the same display name", () => {
    expect(
      normalizeWorkspaceOptions([
        workspace("20e1fd75-c4b4-4330-887b-16768cee860d", "Koronic"),
        workspace("cc4ecb54-901f-4d81-9627-b30d06612525", "Koronic"),
      ]).map((option) => option.selectorLabel),
    ).toEqual(["Koronic · 20e1fd75", "Koronic · cc4ecb54"]);
  });

  it("extends the ID suffix when equal-name workspaces share the initial prefix", () => {
    expect(
      normalizeWorkspaceOptions([
        workspace("12345678-aaaa", "Koronic"),
        workspace("12345678-bbbb", "Koronic"),
      ]).map((option) => option.selectorLabel),
    ).toEqual(["Koronic · 12345678-aaa", "Koronic · 12345678-bbb"]);
  });

  it("deduplicates the same canonical workspace ID across bootstrap sources", () => {
    expect(
      normalizeWorkspaceOptions([
        workspace("same-id", "Test", true),
        workspace("same-id", "Auterim", true, "admin"),
      ]),
    ).toMatchObject([{ workspaceId: "same-id", name: "Test", role: "owner" }]);
  });

  it("retains onboarding and activated workspaces together", () => {
    expect(
      normalizeWorkspaceOptions([
        workspace("onboarding", "Test", false),
        workspace("active", "Auterim", true),
      ]).map((option) => option.workspaceId),
    ).toEqual(["onboarding", "active"]);
  });

  it("restores a saved workspace only while it is still in the authorized set", () => {
    const options = [workspace("active", "Auterim"), workspace("test", "Test", false)];
    expect(resolveSelectedWorkspaceId(options, "test")).toBe("test");
    expect(resolveSelectedWorkspaceId(options, "removed-membership")).toBe("active");
  });

  it("shows a newly created workspace on the next membership refresh", () => {
    const refreshedMemberships = [workspace("existing", "Auterim"), workspace("new", "Test")];
    expect(
      normalizeWorkspaceOptions(refreshedMemberships).map((option) => option.workspaceId),
    ).toEqual(["existing", "new"]);
  });

  it("uses canonical workspace names for the Test, Auterim, and Koronic regression fixture", () => {
    const options = normalizeWorkspaceOptions([
      workspace("e140d48e-9dc0-4552-a9a4-a81fe3872422", "Test"),
      workspace("20e1fd75-c4b4-4330-887b-16768cee860d", "Koronic"),
      workspace("cc4ecb54-901f-4d81-9627-b30d06612525", "Koronic"),
    ]);
    expect(options.map((option) => option.selectorLabel)).toEqual([
      "Test",
      "Koronic · 20e1fd75",
      "Koronic · cc4ecb54",
    ]);
    expect(options.some((option) => option.selectorLabel === "Auterim")).toBe(false);
  });

  it("returns an empty selection when the user has no authorized workspaces", () => {
    expect(resolveSelectedWorkspaceId([], "stale-id")).toBe("");
  });
});
