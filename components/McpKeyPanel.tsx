"use client";

import { useEffect, useState } from "react";

// Base URL of the public MCP endpoint. Users paste this (with ?key=...)
// into their Claude / MCP client. Kept here rather than read from env at
// runtime to avoid an NEXT_PUBLIC_ shim — the URL is static anyway.
const MCP_URL = "https://ws.postpaper.co/mcp";

interface KeyInfo {
  hasKey: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

export default function McpKeyPanel() {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/me/mcp-key", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
      .then((data: KeyInfo) => { setInfo(data); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  async function handleMint() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/v1/me/mcp-key", { method: "POST" });
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      const data = (await res.json()) as { key: string; createdAt: string };
      setPlaintext(data.key);
      setInfo({ hasKey: true, createdAt: data.createdAt, lastUsedAt: null });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    if (!confirm("Revoke this MCP key? Any Claude / MCP client using it will stop working until you paste a new key.")) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/v1/me/mcp-key", { method: "DELETE" });
      if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
      setPlaintext(null);
      setInfo({ hasKey: false, createdAt: null, lastUsedAt: null });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(`${MCP_URL}?key=${plaintext}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore — user can select-copy manually.
    }
  }

  if (loading) {
    return (
      <section className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <div className="text-sm text-gray-400">Loading MCP key…</div>
      </section>
    );
  }

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="font-semibold text-gray-900">MCP API Key</h2>
          <p className="text-sm text-gray-500 mt-1">
            Connect Claude (or any MCP client) to your PostPaper documents.
            One key per account — keep it private.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {info?.hasKey ? (
            <>
              <button
                onClick={handleMint}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy ? "…" : "Regenerate"}
              </button>
              <button
                onClick={handleRevoke}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Revoke
              </button>
            </>
          ) : (
            <button
              onClick={handleMint}
              disabled={busy}
              className="px-3 py-1.5 text-sm rounded-lg bg-black text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {busy ? "Generating…" : "Generate key"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
          {error}
        </div>
      )}

      {plaintext ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
          <p className="font-medium text-amber-900 mb-2">
            Copy your key now — it will not be shown again.
          </p>
          <p className="text-gray-700 mb-2">
            Paste this URL into your Claude settings (Integrations → Add MCP server):
          </p>
          <div className="flex items-center gap-2 bg-white border border-amber-200 rounded px-2 py-1.5 font-mono text-xs break-all">
            <span className="flex-1">{MCP_URL}?key={plaintext}</span>
            <button
              onClick={copyUrl}
              className="shrink-0 px-2 py-1 text-xs rounded bg-gray-900 text-white hover:bg-gray-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : info?.hasKey ? (
        <div className="text-sm text-gray-600">
          Key active — created {fmtDate(info.createdAt)}, last used {fmtDate(info.lastUsedAt)}.
          {" "}Regenerating replaces the existing key; any client still using the old one will need to be updated.
        </div>
      ) : (
        <div className="text-sm text-gray-600">
          No key yet. Generate one to let Claude read and edit your documents via MCP.
        </div>
      )}
    </section>
  );
}
