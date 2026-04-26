"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import McpKeyPanel from "@/components/McpKeyPanel";
import { MCP_SERVER_VERSION, notesNewerThan } from "@/lib/release-notes";

const SEEN_VERSION_KEY = "postpaper:dashboard:seen-version";

interface DocMeta {
  id: string;
  title: string;
  updated_at: string;
  owner_id: string | null;
  role: "owner" | "editor" | "commenter";
}

const ROLE_CHIP: Record<DocMeta["role"], { label: string; classes: string }> = {
  owner: { label: "Owner", classes: "bg-gray-100 text-gray-600" },
  editor: { label: "Shared · Editor", classes: "bg-blue-50 text-blue-700" },
  commenter: { label: "Shared · Commenter", classes: "bg-purple-50 text-purple-700" },
};

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return "yesterday";
  return `${Math.floor(seconds / 86400)} days ago`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [user, setUser] = useState<{ name: string; email: string; image?: string } | null>(null);
  // What's-new banner state. Only shown if the user has unseen release
  // notes, dismissable in one click. Mirrors the MCP-server hint that
  // gets injected into Claude's tool responses — same content, same
  // source of truth (lib/release-notes.ts), different surface.
  const [unseenNotes, setUnseenNotes] = useState<Array<{ version: string; note: string }>>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const lastSeen = window.localStorage.getItem(SEEN_VERSION_KEY) || "";
    setUnseenNotes(notesNewerThan(lastSeen));
  }, []);

  function dismissReleaseBanner() {
    try {
      window.localStorage.setItem(SEEN_VERSION_KEY, MCP_SERVER_VERSION);
    } catch { /* Safari private mode etc. — fine */ }
    setUnseenNotes([]);
  }

  useEffect(() => {
    // Fetch session
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data?.user) {
          setUser(data.user);
        } else {
          router.push("/");
        }
      });

    // Fetch documents
    fetch("/api/v1/user/docs")
      .then((r) => r.json())
      .then((data) => {
        setDocs(data.documents || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [router]);

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await fetch("/api/v1/docs", { method: "POST" });
      if (!res.ok) {
        // Most likely ws-server briefly unreachable (Railway redeploy,
        // network flake). The previous version of this handler swallowed
        // the failure and redirected into a phantom doc that had no row
        // in the `documents` table — leading to a confusing "No access"
        // page right after the user clicked New Document.
        const data = await res.json().catch(() => ({}));
        alert(
          data.error ||
            "Couldn't create the document right now. Please try again in a moment."
        );
        setCreating(false);
        return;
      }
      const data = await res.json();
      router.push(`/doc/${data.id}`);
    } catch {
      alert("Network error — please check your connection and try again.");
      setCreating(false);
    }
  }

  async function handleSignOut() {
    const res = await fetch("/api/auth/signout", { method: "POST" });
    if (res.redirected) {
      window.location.href = res.url;
    } else {
      // CSRF token needed — use form submission
      const csrfRes = await fetch("/api/auth/csrf");
      const { csrfToken } = await csrfRes.json();
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/api/auth/signout";
      const input = document.createElement("input");
      input.name = "csrfToken";
      input.value = csrfToken;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">PostPaper</h1>
        <div className="flex items-center gap-4">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 bg-black text-white text-sm rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {creating ? "Creating..." : "New Document"}
          </button>
          {user && (
            <div className="flex items-center gap-3">
              {user.image && (
                <img
                  src={user.image}
                  alt={user.name}
                  className="w-8 h-8 rounded-full"
                  referrerPolicy="no-referrer"
                />
              )}
              <span className="text-sm text-gray-700">{user.name}</span>
              <button
                onClick={handleSignOut}
                className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-4xl mx-auto px-6 py-10">
        {/* What's-new banner. Shows once after each MCP-server bump,
            until dismissed. Tells the user new tools are available and
            how to refresh their MCP client to see them. */}
        {unseenNotes.length > 0 && (
          <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-blue-900 mb-2">
                  What&apos;s new in PostPaper
                </h3>
                <ul className="space-y-1.5 text-sm text-blue-900">
                  {unseenNotes.map(({ version, note }) => (
                    <li key={version}>
                      <span className="text-xs font-medium text-blue-700 mr-1">v{version}</span>
                      {note}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-blue-800">
                  If new tools don&apos;t appear in your MCP client, reconnect to refresh the tool list:
                  Claude.ai (web/Desktop) → <em>Settings → Connectors → PostPaper → Disconnect → Connect</em>;
                  Claude Code (CLI) → <code className="bg-blue-100 px-1 rounded">claude mcp remove postpaper</code> then re-add.
                </p>
              </div>
              <button
                onClick={dismissReleaseBanner}
                aria-label="Dismiss"
                className="flex-shrink-0 px-2 py-1 text-blue-700 hover:bg-blue-100 rounded text-sm font-medium"
              >
                Got it
              </button>
            </div>
          </div>
        )}
        {user && <McpKeyPanel />}
        {loading ? (
          <div className="text-center text-gray-400 py-20">Loading documents...</div>
        ) : docs.length === 0 ? (
          /* Empty state */
          <div className="text-center py-20">
            <h2 className="text-xl font-semibold text-gray-700 mb-2">No documents yet</h2>
            <p className="text-gray-400 mb-6">
              Create a document and share it with people and AI agents
            </p>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="px-6 py-3 bg-black text-white rounded-lg text-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              Create your first document
            </button>
          </div>
        ) : (
          /* Document grid */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {docs.map((doc) => {
              const chip = ROLE_CHIP[doc.role];
              return (
                <button
                  key={doc.id}
                  onClick={() => router.push(`/doc/${doc.id}`)}
                  className="text-left p-5 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-md transition-all"
                >
                  <h3 className="font-medium text-gray-900 mb-2 truncate">
                    {doc.title || "Untitled"}
                  </h3>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${chip.classes}`}
                    >
                      {chip.label}
                    </span>
                    <span className="text-xs text-gray-400">{timeAgo(doc.updated_at)}</span>
                  </div>
                  {doc.role !== "owner" && doc.owner_id && (
                    <p className="text-xs text-gray-400 mt-2 truncate">
                      from {doc.owner_id}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
