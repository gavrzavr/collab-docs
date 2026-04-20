"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import mammoth from "mammoth";

interface ToolbarProps {
  docId: string;
  sessionUser?: { name: string; email: string; image?: string } | null;
  onImportHtml?: (html: string) => void;
}

export default function Toolbar({ docId, sessionUser, onImportHtml }: ToolbarProps) {
  const [copied, setCopied] = useState<"edit" | "view" | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [mintingView, setMintingView] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);

  async function copyEditLink() {
    const url = `${window.location.origin}/doc/${docId}`;
    await navigator.clipboard.writeText(url);
    setShareOpen(false);
    setCopied("edit");
    setTimeout(() => setCopied(null), 2000);
  }

  async function copyViewLink() {
    if (mintingView) return;
    setMintingView(true);
    try {
      const res = await fetch(`/api/v1/docs/${docId}/share-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error === "Not authenticated"
          ? "Sign in to create a view link."
          : "Could not create view link.");
        return;
      }
      const { token } = await res.json();
      const url = `${window.location.origin}/v/${token}`;
      await navigator.clipboard.writeText(url);
      setShareOpen(false);
      setCopied("view");
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error("Failed to mint view link:", err);
      alert("Could not create view link.");
    } finally {
      setMintingView(false);
    }
  }

  async function exportMarkdown() {
    setExportOpen(false);
    const res = await fetch(`/api/v1/docs/${docId}/export?format=md`);
    const blob = await res.blob();
    downloadBlob(blob, "document.md");
  }

  async function exportDocx() {
    setExportOpen(false);
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

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (result.value) {
        onImportHtml?.(result.value);
      }
      if (result.messages.length > 0) {
        console.warn("Mammoth warnings:", result.messages);
      }
    } catch (err) {
      console.error("Failed to import .docx:", err);
      alert("Could not import file. Please make sure it's a .docx file.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <div className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 border-b border-gray-200 bg-white">
      <Link
        href={sessionUser ? "/dashboard" : "/"}
        className="flex items-center gap-2 text-sm font-medium text-gray-700 mr-auto hover:text-black transition-colors shrink-0"
        aria-label="PostPaper"
      >
        <span
          aria-hidden="true"
          className="inline-block w-4 h-4 rounded-sm bg-[#0BA70B]"
        />
        <span className="hidden sm:inline">PostPaper</span>
      </Link>

      {/* 1. Share (dropdown: edit link + view link) */}
      <div className="relative shrink-0" ref={shareRef}>
        <button
          onClick={() => setShareOpen((v) => !v)}
          className="px-2.5 sm:px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md transition-colors flex items-center gap-1 whitespace-nowrap"
        >
          {copied === "edit" ? "Copied!" : copied === "view" ? "View link copied!" : "Share"}
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {shareOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShareOpen(false)} />
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-20 min-w-[200px]">
              <button
                onClick={copyEditLink}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors rounded-t-md"
              >
                Copy edit link
                <div className="text-xs text-gray-500">for collaborators</div>
              </button>
              <button
                onClick={copyViewLink}
                disabled={mintingView || !sessionUser}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors rounded-b-md disabled:opacity-50 disabled:cursor-not-allowed"
                title={!sessionUser ? "Sign in to create a view link" : undefined}
              >
                {mintingView ? "Creating..." : "Copy view link"}
                <div className="text-xs text-gray-500">read-only</div>
              </button>
            </div>
          </>
        )}
      </div>

      {/* 2. Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={handleFileSelect}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={importing}
        className="px-2.5 sm:px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
      >
        {importing ? "Importing..." : "Import"}
      </button>

      {/* 3. Connect AI */}
      <Link
        href={`/connect?doc=${docId}`}
        className="px-2.5 sm:px-3 py-1.5 text-sm bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-md transition-colors whitespace-nowrap shrink-0"
      >
        Connect AI
      </Link>

      {/* 4. Export (dropdown) */}
      <div className="relative shrink-0" ref={exportRef}>
        <button
          onClick={() => setExportOpen(!exportOpen)}
          className="px-2.5 sm:px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md transition-colors flex items-center gap-1 whitespace-nowrap"
        >
          Export
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {exportOpen && (
          <>
            {/* Backdrop to close dropdown */}
            <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-20 min-w-[140px]">
              <button
                onClick={exportDocx}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors rounded-t-md"
              >
                Export .docx
              </button>
              <button
                onClick={exportMarkdown}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors rounded-b-md"
              >
                Export .md
              </button>
            </div>
          </>
        )}
      </div>

      {sessionUser && (
        <div className="flex items-center gap-2 ml-1 pl-2 sm:ml-2 border-l border-gray-200 shrink-0">
          {sessionUser.image && (
            <img
              src={sessionUser.image}
              alt={sessionUser.name}
              className="w-7 h-7 rounded-full shrink-0"
              referrerPolicy="no-referrer"
            />
          )}
          <span className="hidden md:inline text-sm text-gray-600">{sessionUser.name}</span>
        </div>
      )}
    </div>
  );
}
