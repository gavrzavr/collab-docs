"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import McpKeyPanel from "@/components/McpKeyPanel";

// One source of truth for MCP connection UX: the dashboard's McpKeyPanel.
// It owns key minting, per-user URL assembly (`?key=…`), and per-client
// instructions. This page is a thin wrapper that adds the doc-specific
// "here's what to paste in chat" hint on top when the user lands here
// via the "Connect AI" button from inside a document.

function ConnectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const docId = searchParams.get("doc");

  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [checking, setChecking] = useState(true);

  // Signed-in users only: per-user API keys require a server-side session.
  // Mirrors the dashboard guard so the two entry points behave the same.
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data?.user) {
          setUser(data.user);
          setChecking(false);
        } else {
          // Not signed in — bounce to the landing page. Sign-in there
          // always lands on /dashboard, which has the same MCP panel we
          // render here, so the user ends up with their key either way.
          router.push("/");
        }
      })
      .catch(() => setChecking(false));
  }, [router, docId]);

  if (checking || !user) {
    return <div className="min-h-screen bg-white" />;
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <Link href="/dashboard" className="text-sm font-medium text-gray-700 hover:text-black transition-colors">
          PostPaper
        </Link>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Connect Claude to PostPaper</h1>
        <p className="text-gray-600 mb-10">
          One key per account. Paste it into any MCP client (Claude.ai, Desktop, Code, Cursor, …) once, then
          reference documents by their{" "}
          <code className="bg-gray-100 px-1 rounded text-sm">/doc/:id</code> URL in chat.
        </p>

        {docId && (
          <div className="mb-8 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <p className="text-sm text-blue-800">
              After setup, come back to your document and ask Claude to work with it:
            </p>
            <p className="text-sm font-mono text-blue-900 mt-1 select-all">
              postpaper.co/doc/{docId}
            </p>
          </div>
        )}

        <McpKeyPanel />

        <section className="mt-8 border-t border-gray-200 pt-8">
          <h2 className="text-lg font-semibold mb-3">After connecting</h2>
          <p className="text-gray-600 mb-4">
            Paste a document link in any Claude chat and say what you want:
          </p>
          <div className="space-y-2 text-sm">
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Read postpaper.co/doc/{docId || "abc123"}&quot;
            </div>
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Write a project plan into postpaper.co/doc/{docId || "abc123"}&quot;
            </div>
          </div>
          <p className="text-sm text-gray-500 mt-4">
            Changes appear instantly in the browser for all connected users.
          </p>
        </section>

        <section className="mt-8 border-t border-gray-200 pt-8">
          <h2 className="text-lg font-semibold mb-3">Tools not showing up?</h2>
          <p className="text-gray-600 mb-2">
            Claude clients cache tool descriptions at connection time. After server updates — new tools or new editing rules —
            reconnect to pick up the changes.
          </p>
          <ul className="list-disc ml-6 text-sm text-gray-700 space-y-1.5">
            <li>
              <span className="font-medium">Claude.ai / Desktop:</span> Settings → Connectors → disconnect PostPaper → connect again.
            </li>
            <li>
              <span className="font-medium">Claude Code:</span>{" "}
              <code className="bg-gray-100 px-1 rounded">claude mcp remove postpaper</code>, then re-run the add command.
            </li>
            <li>
              Regenerated your key? Old clients keep trying the old URL — reconnect them with the new one.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <ConnectContent />
    </Suspense>
  );
}
