"use client";

import { useEffect, useState } from "react";
import { useProductApp } from "../../app-shell";

type Option = {
  workspaceId: string;
  workspaceRole: string;
  company: { id: string; name: string };
  product: { id: string; name: string; status: string };
};

export function CliConnectApproval({ initialCode }: { initialCode: string }) {
  const { api } = useProductApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState("");
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    api<{ companies: Option[] }>("/api/cli/v1/connect/options")
      .then((result) => {
        if (!active) return;
        setOptions(result.companies ?? []);
        if (result.companies?.length)
          setSelected(`${result.companies[0]!.workspaceId}:${result.companies[0]!.product.id}`);
      })
      .catch(
        () => active && setMessage("Sign in as a workspace owner or admin to authorize the CLI."),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api]);

  async function approve() {
    const option = options.find((item) => `${item.workspaceId}:${item.product.id}` === selected);
    if (!option || !/^[A-F0-9-]{10,12}$/i.test(code)) {
      setMessage("Enter the short code shown by your CLI and select a Product.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api("/api/cli/v1/connect/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userCode: code,
          workspaceId: option.workspaceId,
          companyId: option.company.id,
          productId: option.product.id,
        }),
      });
      setMessage("CLI connected. Return to the terminal to continue.");
    } catch {
      setMessage("This code is unavailable or expired. Start a new connection from the CLI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <p className="text-sm font-medium text-emerald-700">AUTERIM CLI</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Connect Auterim CLI</h1>
      <p className="mt-3 text-sm text-slate-600">
        Authorize local dependency discovery for one existing Product. Draft Products are available
        during setup; this does not activate protection.
      </p>

      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block text-sm font-medium" htmlFor="cli-user-code">
          One-time code
        </label>
        <input
          id="cli-user-code"
          autoComplete="off"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono tracking-widest"
          maxLength={12}
        />

        <label className="mt-6 block text-sm font-medium" htmlFor="cli-product">
          Company and Product
        </label>
        <select
          id="cli-product"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={loading || options.length === 0}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          {options.map((option) => (
            <option
              key={`${option.workspaceId}:${option.product.id}`}
              value={`${option.workspaceId}:${option.product.id}`}
            >
              {option.company.name} · {option.product.name} ·{" "}
              {option.product.status === "draft" ? "Setup" : "Protected"}
            </option>
          ))}
        </select>

        <div className="mt-6 rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
          <p>The CLI submits only derived local dependency metadata for the selected Product.</p>
          <ul className="mt-3 list-inside list-disc space-y-1">
            <li>Source files and file contents are not uploaded.</li>
            <li>Environment variable names only; never values.</li>
            <li>No secrets, private keys, credentials, or full lockfiles.</li>
            <li>Local observations do not confirm or enable monitoring dependencies.</li>
          </ul>
        </div>

        <button
          type="button"
          onClick={() => void approve()}
          disabled={busy || loading || options.length === 0}
          className="mt-6 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Authorizing…" : "Approve CLI connection"}
        </button>
        {message && (
          <p role="status" className="mt-4 text-sm text-slate-700">
            {message}
          </p>
        )}
        {!loading && options.length === 0 && (
          <p className="mt-4 text-sm text-slate-600">
            No existing Product is available. Create a Product in Auterim, then return here.
          </p>
        )}
      </section>
    </main>
  );
}
