"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const MCP_URL = "https://ws.postpaper.co/mcp";
const APP_HOST = "postpaper.co";

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
              {APP_HOST}/doc/{docId}
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
                <p className="font-medium">Open Connectors</p>
                <p className="text-sm text-gray-600">Claude.ai → Settings (bottom left) → Connectors</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-medium">Click &quot;Add custom connector&quot;</p>
                <p className="text-sm text-gray-600">It&apos;s at the bottom of the connectors list</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <p className="font-medium">Paste the MCP server URL</p>
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
                <p className="font-medium">Verify it&apos;s connected</p>
                <p className="text-sm text-gray-600">
                  Start a new chat and ask: <em>&quot;What tools do you have for collab-docs?&quot;</em>
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  You should see six: <code className="bg-gray-100 px-1 rounded">read_document</code>,{" "}
                  <code className="bg-gray-100 px-1 rounded">edit_document</code>,{" "}
                  <code className="bg-gray-100 px-1 rounded">update_block</code>,{" "}
                  <code className="bg-gray-100 px-1 rounded">insert_block</code>,{" "}
                  <code className="bg-gray-100 px-1 rounded">delete_block</code>,{" "}
                  <code className="bg-gray-100 px-1 rounded">create_table</code>.
                </p>
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
                <p className="font-medium">Open Connectors</p>
                <p className="text-sm text-gray-600">Claude Desktop → Settings → Connectors</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-medium">Click &quot;Add custom connector&quot;</p>
                <p className="text-sm text-gray-600">At the bottom of the connectors list.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-orange-500 text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <p className="font-medium">Paste the MCP server URL</p>
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
                <p className="font-medium">Fully quit and reopen Claude Desktop</p>
                <p className="text-sm text-gray-600">
                  ⌘Q on Mac (or File → Quit on Windows). After reopening, CollabDocs appears in the tools list (hammer icon).
                </p>
              </div>
            </div>
          </div>

          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gray-600 hover:text-black py-2">
              Prefer the JSON config file? (advanced)
            </summary>
            <div className="mt-2 bg-gray-50 rounded-xl p-6 space-y-3">
              <p className="text-sm text-gray-600">
                Settings → Developer → Edit Config opens{" "}
                <code className="bg-gray-200 px-1 rounded">claude_desktop_config.json</code>. Add the{" "}
                <code className="bg-gray-200 px-1 rounded">collabdocs</code> entry inside your existing{" "}
                <code className="bg-gray-200 px-1 rounded">mcpServers</code> block (or paste the whole thing if the file is new):
              </p>
              <div className="relative">
                <pre className="bg-white border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono overflow-x-auto">
                  {desktopConfig}
                </pre>
                <div className="mt-2">
                  <CopyButton text={desktopConfig} label="Copy config" />
                </div>
              </div>
              <p className="text-sm text-gray-500">Save, then fully quit and reopen Claude Desktop.</p>
            </div>
          </details>
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
            <p className="text-sm text-gray-600 mt-3">
              Verify with <code className="bg-gray-100 px-1 rounded">/mcp</code> inside Claude Code —{" "}
              <code className="bg-gray-100 px-1 rounded">collabdocs</code> should be listed as connected.
            </p>
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

        {/* Troubleshooting */}
        <section className="mb-10 border-t border-gray-200 pt-8">
          <h2 className="text-lg font-semibold mb-3">Tools not showing up? Or behaving oddly?</h2>
          <p className="text-gray-600 mb-4">
            Claude clients cache tool descriptions at connection time. When we update the server — new tools, new editing rules — you need to reconnect to pick up the changes.
          </p>
          <ul className="list-disc ml-6 text-sm text-gray-700 space-y-2">
            <li>
              <span className="font-medium">Claude.ai / Desktop:</span> Settings → Connectors → disconnect CollabDocs → connect again.
            </li>
            <li>
              <span className="font-medium">Claude Code:</span>{" "}
              <code className="bg-gray-100 px-1 rounded">claude mcp remove collabdocs</code>, then re-run the add command above.
            </li>
          </ul>
          <p className="text-sm text-gray-500 mt-4">
            Quick sanity check: ask Claude <em>&quot;what&apos;s the first rule of editing collab-docs?&quot;</em> — current descriptions start with <em>&quot;think in blocks, not pages&quot;</em>. If it sounds like <em>&quot;Editorial Typography Expert&quot;</em>, the cache is stale.
          </p>
        </section>

        {/* What happens after */}
        <section className="border-t border-gray-200 pt-8">
          <h2 className="text-lg font-semibold mb-3">After connecting</h2>
          <p className="text-gray-600 mb-4">Just paste a document link in any Claude chat and say what you want:</p>
          <div className="space-y-2 text-sm">
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Read the document {APP_HOST}/doc/abc123&quot;
            </div>
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Write a project plan into {APP_HOST}/doc/abc123&quot;
            </div>
            <div className="bg-gray-50 rounded-lg p-3 font-mono">
              &quot;Translate this document to English: {APP_HOST}/doc/abc123&quot;
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
