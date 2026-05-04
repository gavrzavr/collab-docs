"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import McpKeyPanel from "@/components/McpKeyPanel";
import DocCard from "@/components/DocCard";
import { MCP_SERVER_VERSION, notesNewerThan } from "@/lib/release-notes";

const SEEN_VERSION_KEY = "postpaper:dashboard:seen-version";

interface DocMeta {
  id: string;
  title: string;
  updated_at: string;
  owner_id: string | null;
  role: "owner" | "editor" | "commenter";
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
  // Banner starts collapsed — feedback was that the expanded list was
  // eating the entire mobile viewport and pushing the actual dashboard
  // (doc cards) below the fold. Dashboard is the primary surface here;
  // release notes are a secondary nudge.
  const [bannerExpanded, setBannerExpanded] = useState(false);

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

  const refreshDocs = useCallback(() => {
    fetch("/api/v1/user/docs")
      .then((r) => r.json())
      .then((data) => {
        setDocs(data.documents || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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

    refreshDocs();
  }, [router, refreshDocs]);

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
      {/* Top bar — compact on mobile, comfortable on desktop. User name
          and full "New Document" label are hidden on <sm because they
          push the row past the viewport (avatar identifies the user
          well enough; the black button is unmistakably "create"). */}
      <header className="bg-white border-b border-gray-200 px-3 sm:px-6 py-3 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold flex-shrink-0">PostPaper</h1>
        <div className="flex items-center gap-2 sm:gap-4">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-3 sm:px-4 py-2 bg-black text-white text-sm rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 whitespace-nowrap flex-shrink-0"
          >
            {creating ? "Creating..." : (
              <>
                <span className="sm:hidden">+ New</span>
                <span className="hidden sm:inline">New Document</span>
              </>
            )}
          </button>
          {user && (
            <div className="flex items-center gap-2 sm:gap-3">
              {user.image && (
                <img
                  src={user.image}
                  alt={user.name}
                  className="w-8 h-8 rounded-full flex-shrink-0"
                  referrerPolicy="no-referrer"
                />
              )}
              <span className="hidden sm:inline text-sm text-gray-700">{user.name}</span>
              <button
                onClick={handleSignOut}
                className="text-sm text-gray-400 hover:text-gray-600 transition-colors whitespace-nowrap"
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
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50">
            {/* Compact header row, always visible. Single line on mobile;
                acts as the disclosure trigger to expand the full list. */}
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                onClick={() => setBannerExpanded((v) => !v)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                aria-expanded={bannerExpanded}
              >
                <span className="text-sm font-semibold text-blue-900 truncate">
                  What&apos;s new — {unseenNotes.length} update{unseenNotes.length === 1 ? "" : "s"}
                </span>
                <svg
                  className={`w-4 h-4 text-blue-700 flex-shrink-0 transition-transform ${bannerExpanded ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <button
                onClick={dismissReleaseBanner}
                aria-label="Dismiss"
                className="flex-shrink-0 px-2 py-1 text-blue-700 hover:bg-blue-100 rounded text-sm font-medium"
              >
                Got it
              </button>
            </div>
            {/* Expanded body: capped at 40vh with internal scroll so it
                can never push the dashboard past the fold, no matter how
                many releases are queued. */}
            {bannerExpanded && (
              <div className="px-3 pb-3 max-h-[40vh] overflow-y-auto border-t border-blue-200 pt-2">
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
            )}
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
            {docs.map((doc) => (
              <DocCard
                key={doc.id}
                id={doc.id}
                title={doc.title}
                updated_at={doc.updated_at}
                owner_id={doc.owner_id}
                role={doc.role}
                onChanged={refreshDocs}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
