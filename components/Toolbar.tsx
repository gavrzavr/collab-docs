"use client";

import { useState } from "react";
import Link from "next/link";

interface ToolbarProps {
  docId: string;
  sessionUser?: { name: string; email: string; image?: string } | null;
}

export default function Toolbar({ docId, sessionUser }: ToolbarProps) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const url = `${window.location.origin}/doc/${docId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function exportMarkdown() {
    const res = await fetch(`/api/v1/docs/${docId}/export?format=md`);
    const blob = await res.blob();
    downloadBlob(blob, "document.md");
  }

  async function exportDocx() {
    const res = await fetch(`/api/v1/docs/${docId}/export?format=docx`);
    const blob = await res.blob();
    downloadBlob(blob, "document.docx");
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white">
      <Link href={sessionUser ? "/dashboard" : "/"} className="text-sm font-medium text-gray-700 mr-auto hover:text-black transition-colors">
        CollabDocs
      </Link>
      <button
        onClick={copyLink}
        className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
      >
        {copied ? "Copied!" : "Share Link"}
      </button>
      <button
        onClick={exportMarkdown}
        className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
      >
        Export .md
      </button>
      <button
        onClick={exportDocx}
        className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
      >
        Export .docx
      </button>
      {sessionUser && (
        <div className="flex items-center gap-2 ml-2 pl-2 border-l border-gray-200">
          {sessionUser.image && (
            <img
              src={sessionUser.image}
              alt={sessionUser.name}
              className="w-7 h-7 rounded-full"
              referrerPolicy="no-referrer"
            />
          )}
          <span className="text-sm text-gray-600">{sessionUser.name}</span>
        </div>
      )}
    </div>
  );
}
