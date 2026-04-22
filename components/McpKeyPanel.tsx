"use client";

import { useEffect, useState } from "react";

// Base URL of the public MCP endpoint. Users paste this (with ?key=...)
// into their Claude / MCP client. Kept here rather than read from env at
// runtime to avoid an NEXT_PUBLIC_ shim — the URL is static anyway.
const MCP_URL = "https://ws.postpaper.co/mcp";

interface KeyInfo {
  hasKey: boolean;
  key: string | null;
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

// Short masked preview of the key so the default render doesn't leak
// the full secret to anyone looking over the user's shoulder. Full key
// is still one click away via the "Show" toggle.
function maskKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

type HelpTab = "web" | "desktop" | "code" | "other";

export default function McpKeyPanel() {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTab, setHelpTab] = useState<HelpTab>("web");

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
      setInfo({ hasKey: true, key: data.key, createdAt: data.createdAt, lastUsedAt: null });
      // Reveal the new key immediately — the user just asked for one.
      setRevealed(true);
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
      setInfo({ hasKey: false, key: null, createdAt: null, lastUsedAt: null });
      setRevealed(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!info?.key) return;
    try {
      await navigator.clipboard.writeText(`${MCP_URL}?key=${info.key}`);
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

  const fullUrl = info?.key ? `${MCP_URL}?key=${info.key}` : null;
  const maskedUrl = info?.key ? `${MCP_URL}?key=${maskKey(info.key)}` : null;

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
                title="Generate a new key; the old one stops working."
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

      {info?.hasKey && fullUrl ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Your personal connection URL — paste it into any MCP client to give it access to your documents:
          </p>
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 font-mono text-xs break-all">
            <span className="flex-1 select-all">{revealed ? fullUrl : maskedUrl}</span>
            <button
              onClick={() => setRevealed((v) => !v)}
              className="shrink-0 px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-100"
              title={revealed ? "Hide key" : "Show full key"}
            >
              {revealed ? "Hide" : "Show"}
            </button>
            <button
              onClick={copyUrl}
              className="shrink-0 px-2 py-1 text-xs rounded bg-gray-900 text-white hover:bg-gray-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-gray-400">
            Created {fmtDate(info.createdAt)} · last used {fmtDate(info.lastUsedAt)}.
            Anyone with this key can read and edit every document you own or are invited to — treat it like a password.
          </p>

          <div className="pt-2">
            <button
              onClick={() => setHelpOpen((v) => !v)}
              className="text-sm text-gray-700 hover:text-black inline-flex items-center gap-1"
              aria-expanded={helpOpen}
            >
              <span
                className={`inline-block transition-transform ${helpOpen ? "rotate-90" : ""}`}
                aria-hidden
              >
                ▸
              </span>
              How do I connect this?
            </button>

            {helpOpen && (
              <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex border-b border-gray-200 bg-gray-50 text-sm">
                  {([
                    ["web", "Claude.ai (web)"],
                    ["desktop", "Claude desktop"],
                    ["code", "Claude Code"],
                    ["other", "Other MCP client"],
                  ] as Array<[HelpTab, string]>).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setHelpTab(id)}
                      className={`px-3 py-2 border-r border-gray-200 last:border-r-0 transition-colors ${
                        helpTab === id
                          ? "bg-white text-gray-900 font-medium"
                          : "text-gray-500 hover:text-gray-800"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="p-4 text-sm text-gray-700 bg-white">
                  {helpTab === "web" && <HelpWeb />}
                  {helpTab === "desktop" && <HelpDesktop />}
                  {helpTab === "code" && <HelpCode fullUrl={fullUrl} />}
                  {helpTab === "other" && <HelpOther />}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-sm text-gray-600">
          No key yet. Generate one to let Claude read and edit your documents via MCP.
        </div>
      )}
    </section>
  );
}

// ─── Per-client instructions ──────────────────────────────────────────
//
// Kept verbose on purpose — target user has never connected an MCP
// server before. Every step they'd ask about is called out inline.

function StepList({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal list-inside space-y-1.5">{children}</ol>;
}

function UrlHint() {
  return (
    <p className="text-xs text-gray-500 mt-3">
      Use the Copy button above to grab the URL — it already includes your key.
    </p>
  );
}

function HelpWeb() {
  return (
    <div>
      <StepList>
        <li>
          Go to{" "}
          <a
            href="https://claude.ai/settings/connectors"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-black"
          >
            claude.ai → Settings → Connectors
          </a>
          .
        </li>
        <li>Click <b>Add custom connector</b>.</li>
        <li>
          Name it <code className="px-1 bg-gray-100 rounded">PostPaper</code> and paste the URL above into the server URL field.
        </li>
        <li>Click <b>Add</b>. No extra auth — the key is in the URL.</li>
        <li>
          Open any chat and check the tools menu: you should see <code className="px-1 bg-gray-100 rounded">read_document</code>, <code className="px-1 bg-gray-100 rounded">edit_document</code>, and a few others.
        </li>
      </StepList>
      <UrlHint />
    </div>
  );
}

function HelpDesktop() {
  return (
    <div>
      <StepList>
        <li>Open the Claude desktop app.</li>
        <li>
          Go to <b>Settings → Connectors</b> (on macOS: <code className="px-1 bg-gray-100 rounded">Claude</code> menu → <b>Settings</b>; on Windows: menu button → <b>Settings</b>).
        </li>
        <li>Click <b>Add custom connector</b>.</li>
        <li>
          Name it <code className="px-1 bg-gray-100 rounded">PostPaper</code> and paste the URL above.
        </li>
        <li>Click <b>Add</b>, then restart the app if prompted.</li>
      </StepList>
      <p className="text-xs text-gray-500 mt-3">
        Don&apos;t see &quot;Connectors&quot;? Make sure the desktop app is up to date — remote MCP support was added in late 2024.
      </p>
      <UrlHint />
    </div>
  );
}

function HelpCode({ fullUrl }: { fullUrl: string }) {
  const cmd = `claude mcp add --transport http postpaper "${fullUrl}"`;
  const [copied, setCopied] = useState(false);

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div>
      <p className="mb-2">Run this once in your terminal:</p>
      <div className="flex items-start gap-2 bg-gray-900 text-gray-100 rounded px-3 py-2 font-mono text-xs break-all">
        <span className="flex-1 select-all">{cmd}</span>
        <button
          onClick={copyCmd}
          className="shrink-0 px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-3">
        The tools become available the next time you start <code className="px-1 bg-gray-100 rounded">claude</code>. Check with <code className="px-1 bg-gray-100 rounded">/mcp</code> inside a session.
      </p>
      <p className="text-xs text-gray-500 mt-2">
        To remove it later: <code className="px-1 bg-gray-100 rounded">claude mcp remove postpaper</code>.
      </p>
    </div>
  );
}

function HelpOther() {
  return (
    <div>
      <p className="mb-2">
        Add a <b>remote HTTP MCP server</b> in your client, using the URL above as the endpoint.
      </p>
      <ul className="list-disc list-inside space-y-1 text-gray-600">
        <li>Transport: <b>HTTP</b> (streamable HTTP, not stdio).</li>
        <li>No auth header needed — the API key is the <code className="px-1 bg-gray-100 rounded">?key=</code> query parameter.</li>
        <li>
          Tools exposed: <code className="px-1 bg-gray-100 rounded">read_document</code>, <code className="px-1 bg-gray-100 rounded">edit_document</code>, <code className="px-1 bg-gray-100 rounded">insert_block</code>, <code className="px-1 bg-gray-100 rounded">update_block</code>, <code className="px-1 bg-gray-100 rounded">delete_block</code>, <code className="px-1 bg-gray-100 rounded">create_table</code>, <code className="px-1 bg-gray-100 rounded">list_pages</code>.
        </li>
      </ul>
      <UrlHint />
    </div>
  );
}
