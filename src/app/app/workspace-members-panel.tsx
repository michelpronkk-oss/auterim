"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";

const workspaceMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]),
  created_at: z.string(),
});
type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
type Api = (path: string, init?: RequestInit) => Promise<unknown>;

function parseMembers(value: unknown): WorkspaceMember[] {
  if (!value || typeof value !== "object" || !("members" in value) || !Array.isArray(value.members))
    throw new Error("members_unavailable");
  return z.array(workspaceMemberSchema).parse(value.members);
}

export function WorkspaceMembersPanel({
  workspaceId,
  role,
  api,
}: {
  workspaceId: string;
  role?: string;
  api: Api;
}) {
  const [memberRoster, setMemberRoster] = useState<{
    workspaceId: string;
    members: WorkspaceMember[];
  } | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canManage = role === "owner" || role === "admin";

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId || !canManage) return;
    void api(`/api/account/members?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((result) => {
        if (!cancelled) setMemberRoster({ workspaceId, members: parseMembers(result) });
      })
      .catch(() => {
        if (!cancelled) setMessage("Company members are temporarily unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, canManage, workspaceId]);

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !workspaceId || !email.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await api("/api/account/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, email: email.trim() }),
      });
      setEmail("");
      const result = await api(
        `/api/account/members?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      setMemberRoster({ workspaceId, members: parseMembers(result) });
      setMessage("Request processed. If an existing Auterim account matches, it now has access.");
    } catch {
      setMessage("The member request could not be completed. Check your access and try again.");
    } finally {
      setBusy(false);
    }
  }

  const visibleMembers = memberRoster?.workspaceId === workspaceId ? memberRoster.members : [];

  return (
    <section
      className="surface-card workspace-members-card"
      aria-labelledby="company-members-title"
    >
      <p className="card-kicker">COMPANY ACCESS</p>
      <h2 id="company-members-title">Members</h2>
      {canManage ? (
        <>
          <p>Add an existing Auterim account as a member. This does not send an invitation.</p>
          <ul className="workspace-member-list">
            {visibleMembers.map((member) => (
              <li key={`${member.email}:${member.role}`}>
                <span>{member.email}</span>
                <small>{member.role}</small>
              </li>
            ))}
          </ul>
          <form className="workspace-member-form" onSubmit={(event) => void addMember(event)}>
            <label htmlFor="existing-member-email">Auterim account email</label>
            <div>
              <input
                id="existing-member-email"
                type="email"
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={busy}
              />
              <button className="button-secondary" type="submit" disabled={busy || !email.trim()}>
                {busy ? "Adding…" : "Add member"}
              </button>
            </div>
          </form>
        </>
      ) : (
        <p>Only company owners and admins can manage membership.</p>
      )}
      {message && (
        <p className="workspace-member-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
