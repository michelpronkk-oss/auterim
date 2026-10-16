import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

const enabled = process.env.AUTERIM_M1578_DOCKER_ACCEPTANCE === "1";
const url = process.env.AUTERIM_M1578_EXPECTED_URL;
const serviceKey = process.env.AUTERIM_M1578_SERVICE_KEY;
const anonKey = process.env.AUTERIM_M1578_ANON_KEY;

describe.skipIf(!enabled)("M15.78 isolated Docker/Supabase acceptance", () => {
  it("binds to the isolated loopback Supabase stack only", () => {
    expect(url).toBe("http://127.0.0.1:54970");
    expect(serviceKey?.length).toBeGreaterThan(20);
    expect(anonKey?.length).toBeGreaterThan(20);
  });

  it("grants only the service-role RPC path and denies table writes", async () => {
    const service = createClient(url!, serviceKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anonymous = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `m1578-${crypto.randomUUID()}@auterim.local`;
    const password = `${crypto.randomUUID()}aA9!`;
    const authenticated = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(authenticated.error).toBeNull();
    const userId = authenticated.data.user!.id;
    try {
      const member = createClient(url!, anonKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signIn = await member.auth.signInWithPassword({ email, password });
      expect(signIn.error).toBeNull();
      const memberRead = await member.from("fix_runs").select("id");
      expect(memberRead.error).toBeNull();
      expect(memberRead.data).toEqual([]);
      const directMemberWrite = await member.from("fix_runs").insert({});
      expect(directMemberWrite.error).not.toBeNull();

      const directServiceWrite = await service.from("fix_runs").insert({});
      expect(directServiceWrite.error).not.toBeNull();
      const directServiceModelAttemptWrite = await service.from("fix_model_attempts").insert({});
      expect(directServiceModelAttemptWrite.error).not.toBeNull();
      const directAnonymousWrite = await anonymous.from("fix_runs").insert({});
      expect(directAnonymousWrite.error).not.toBeNull();

      const serviceRpc = await service.rpc("create_fix_run_from_graph", {
        p_graph_build_id: crypto.randomUUID(),
      });
      expect(serviceRpc.error?.message).toContain("fix_requires_completed_positive_graph");
      const anonymousRpc = await anonymous.rpc("create_fix_run_from_graph", {
        p_graph_build_id: crypto.randomUUID(),
      });
      expect(anonymousRpc.error).not.toBeNull();

      const { count, error } = await service
        .from("fix_runs")
        .select("id", { count: "exact", head: true });
      expect(error).toBeNull();
      expect(count).toBe(0);
    } finally {
      await service.auth.admin.deleteUser(userId);
    }
  });

  it("keeps patch artifacts private from authenticated workspace users", async () => {
    const service = createClient(url!, serviceKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `m1578-storage-${crypto.randomUUID()}@auterim.local`;
    const password = `${crypto.randomUUID()}aA9!`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const userId = created.data.user!.id;
    try {
      const member = createClient(url!, anonKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signIn = await member.auth.signInWithPassword({ email, password });
      expect(signIn.error).toBeNull();
      const path = `${crypto.randomUUID()}/${crypto.randomUUID()}.diff`;
      const upload = await member.storage.from("fix-engine-artifacts").upload(path, "private test");
      expect(upload.error).not.toBeNull();
      const read = await member.storage.from("fix-engine-artifacts").download(path);
      expect(read.error).not.toBeNull();
    } finally {
      await service.auth.admin.deleteUser(userId);
    }
  });

  it("does not create customer action, Preflight, GitHub, or billing rows", async () => {
    const service = createClient(url!, serviceKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const counts = await Promise.all([
      service.from("customer_impact_dispatch_queue").select("id", { count: "exact", head: true }),
      service.from("preflight_runs").select("id", { count: "exact", head: true }),
      service.from("fix_external_operations").select("id", { count: "exact", head: true }),
      service.from("fix_pr_outcomes").select("id", { count: "exact", head: true }),
      service
        .from("workspace_subscriptions")
        .select("workspace_id", { count: "exact", head: true }),
      service.from("billing_webhook_events").select("id", { count: "exact", head: true }),
    ]);
    for (const result of counts) {
      expect(result.error).toBeNull();
      expect(result.count).toBe(0);
    }
  });
});
