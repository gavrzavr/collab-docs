"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface DocMeta {
  id: string;
  title: string;
  updated_at: string;
}

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
      const data = await res.json();
      router.push(`/doc/${data.id}`);
    } catch {
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
              <button
                key={doc.id}
                onClick={() => router.push(`/doc/${doc.id}`)}
                className="text-left p-5 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-md transition-all"
              >
                <h3 className="font-medium text-gray-900 mb-2 truncate">
                  {doc.title || "Untitled"}
                </h3>
                <p className="text-xs text-gray-400">{timeAgo(doc.updated_at)}</p>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
