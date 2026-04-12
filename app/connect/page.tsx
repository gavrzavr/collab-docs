"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const MCP_URL = "https://collab-docs-production.up.railway.app/mcp";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors"
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function ConnectContent() {
  const searchParams = useSearchParams();
  const docId = searchParams.get("doc");

  const desktopConfig = JSON.stringify({
    mcpServers: {
      collabdocs: {
        type: "url",
        url: MCP_URL,
      },
    },
  }, null, 2);

  const codeCommand = `claude mcp add collabdocs --transport http ${MCP_URL}`;

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="border-b border-gray-200 px-6 py-4">
        <Link href="/" className="text-sm font-medium text-gray-700 hover:text-black transition-colors">
          CollabDocs
        </Link>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Connect Claude to CollabDocs</h1>
        <p className="text-gray-600 mb-10">
          One-time setup. After this, just paste any document link in chat — Claude will read and edit it in real-time.
        </p>

        {docId && (
          <div className="mb-8 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <p className="text-sm text-blue-800">
              After setup, go back to your document and ask Claude to work with it:
            </p>
            <p className="text-sm font-mono text-blue-900 mt-1">
              collab-docs-rose.vercel.app/doc/{docId}
            </p>
          </div>
        )}

        {/* Claude.ai */}
        <section className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center text-lg">C</div>
            <h2 className="text-xl font-semibold">Claude.ai (Web)</h2>
          </div>
          <div className="bg-gray-50 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">1</span>
              <div>
                <p className="font-medium">Open Settings</p>
                <p className="text-sm text-gray-600">Claude.ai → Settings (bottom left) → Integrations</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-medium">Add integration</p>
                <p className="text-sm text-gray-600">Click &quot;Add&quot; → Choose &quot;Custom MCP Server&quot; or &quot;Remote MCP&quot;</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <p className="font-medium">Paste MCP server URL</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono select-all">
                    {MCP_URL}
                  </code>
                  <CopyButton text={MCP_URL} label="Copy URL" />
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-green-500 text-white rounded-full flex items-center justify-center text-xs font-bold">4</span>
              <div>
                <p className="font-medium">Done!</p>
                <p className="text-sm text-gray-600">Now paste any CollabDocs link in chat. Claude will read and edit it.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Claude Desktop */}
        <section className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center text-lg">D</div>
            <h2 className="text-xl font-semibold">Claude Desktop</h2>
          </div>
          <div className="bg-gray-50 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">1</span>
              <div>
                <p className="font-medium">Open Settings</p>
                <p className="text-sm text-gray-600">Claude Desktop → Settings → Developer → Edit Config</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-medium">Add this to your config file:</p>
                <div className="mt-2 relative">
                  <pre className="bg-white border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono overflow-x-auto">
                    {desktopConfig}
                  </pre>
                  <div className="mt-2">
                    <CopyButton text={desktopConfig} label="Copy config" />
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <p className="font-medium">Restart Claude Desktop</p>
                <p className="text-sm text-gray-600">Close and reopen the app. You&apos;ll see CollabDocs in the tools list.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Claude Code */}
        <section className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center text-lg">&gt;_</div>
            <h2 className="text-xl font-semibold">Claude Code (Terminal)</h2>
          </div>
          <div className="bg-gray-50 rounded-xl p-6">
            <p className="font-medium mb-3">Run this one command:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono select-all">
                {codeCommand}
              </code>
              <CopyButton text={codeCommand} label="Copy" />
            </div>
            <p className="text-sm text-gray-600 mt-3">That&apos;s it. Claude Code can now read and edit any CollabDocs document.</p>
          </div>
        </section>

        {/* Cursor / Windsurf / Other MCP clients */}
        <section className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center text-lg">+</div>
            <h2 className="text-xl font-semibold">Cursor, Windsurf, and other MCP clients</h2>
          </div>
          <div className="bg-gray-50 rounded-xl p-6">
            <p className="text-sm text-gray-600 mb-3">Any AI tool that supports MCP can connect to CollabDocs. Just add this URL as a remote MCP server:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono select-all">
                {MCP_URL}
              </code>
              <CopyButton text={MCP_URL} label="Copy URL" />
            </div>
          </div>
        </section>

        {/* What happens after */}
        <section className="border-t border-gray-200 pt-8">
          <h2 className="text-lg font-semibold mb-3">After connecting</h2>
          <p className="text-gray-600 mb-4">Just paste a document link in any Claude chat and say what you want:</p>
          <div className="space-y-2 text-sm">
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Read the document collab-docs-rose.vercel.app/doc/abc123&quot;
            </div>
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Write a project plan into collab-docs-rose.vercel.app/doc/abc123&quot;
            </div>
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Translate this document to English: collab-docs-rose.vercel.app/doc/abc123&quot;
            </div>
          </div>
          <p className="text-sm text-gray-500 mt-4">Changes appear instantly in the browser for all connected users.</p>
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
