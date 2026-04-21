"use client";

import { useState, useRef, useEffect } from "react";
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
  const [viewLinkError, setViewLinkError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [viewLinkUrl, setViewLinkUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const editLinkUrl = typeof window !== "undefined"
    ? `${window.location.origin}/doc/${docId}`
    : `/doc/${docId}`;

  // Pre-mint the viewer token as soon as the Share dropdown opens so both
  // rows are ready to copy in one click. Idempotent per (docId, viewer) —
  // re-opening doesn't pile up DB rows. Only fires when the user is
  // signed in; otherwise the row stays disabled with a tooltip.
  useEffect(() => {
    if (!shareOpen || !sessionUser || viewLinkUrl || mintingView) return;
    let cancelled = false;
    (async () => {
      setMintingView(true);
      setViewLinkError(null);
      try {
        const res = await fetch(`/api/v1/docs/${docId}/share-tokens`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "viewer" }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const msg =
            res.status === 401 ? "Sign in to create a view link."
            : res.status === 403 ? "Only the document owner can create share links."
            : res.status === 404 ? "Document not found."
            : `Could not create view link (${res.status}).`;
          setViewLinkError(msg);
          return;
        }
        const { token } = await res.json();
        if (cancelled) return;
        setViewLinkUrl(`${window.location.origin}/v/${token}`);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to mint view link:", err);
        setViewLinkError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setMintingView(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shareOpen, sessionUser, docId, viewLinkUrl, mintingView]);

  async function handleSignOut() {
    // NextAuth's POST /api/auth/signout requires a CSRF token. Same
    // approach as app/dashboard/page.tsx.
    try {
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
    } catch (err) {
      console.error("Sign-out failed:", err);
      alert("Could not sign out.");
    }
  }

  // Safari-safe clipboard copy. After an `await fetch(...)` Safari drops
  // the user-gesture token, so plain `navigator.clipboard.writeText()`
  // throws NotAllowedError. Three fallbacks in order:
  //   1. execCommand("copy") on a throwaway textarea (works sync, no gesture check)
  //   2. navigator.clipboard.writeText (works in Chrome/Firefox)
  //   3. prompt() so the user can copy manually
  function copyToClipboard(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return true;
    } catch { /* fall through */ }
    try {
      navigator.clipboard?.writeText(text);
      return true;
    } catch { /* fall through */ }
    window.prompt("Copy this link:", text);
    return true;
  }

  // Single unified copy handler. Called directly from each row's button,
  // so Safari sees a fresh user-gesture and writeText is allowed.
  function copyShareLink(which: "edit" | "view") {
    const url = which === "edit" ? editLinkUrl : viewLinkUrl;
    if (!url) return;
    copyToClipboard(url);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
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
          Share
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {shareOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShareOpen(false)} />
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-20 w-[320px]">
              {/* Edit link row */}
              <div className="px-4 py-3">
                <div className="flex items-baseline justify-between mb-1.5">
                  <div className="text-sm font-medium text-gray-900">Edit link</div>
                  <div className="text-xs text-gray-500">for collaborators</div>
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    readOnly
                    value={editLinkUrl}
                    onFocus={(e) => e.target.select()}
                    className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-200 rounded bg-gray-50 focus:outline-none focus:border-gray-400"
                  />
                  <button
                    onClick={() => copyShareLink("edit")}
                    className="px-3 py-1 text-xs font-medium bg-gray-900 hover:bg-gray-700 text-white rounded transition-colors shrink-0 w-[60px]"
                  >
                    {copied === "edit" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* View link row */}
              <div className="px-4 py-3 border-t border-gray-100">
                <div className="flex items-baseline justify-between mb-1.5">
                  <div className="text-sm font-medium text-gray-900">View link</div>
                  <div className="text-xs text-gray-500">read-only</div>
                </div>
                {!sessionUser ? (
                  <div className="text-xs text-gray-500 py-1">Sign in to create a view link.</div>
                ) : viewLinkError ? (
                  <div className="text-xs text-red-600 py-1">{viewLinkError}</div>
                ) : (
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={viewLinkUrl || ""}
                      placeholder={mintingView ? "Creating..." : ""}
                      onFocus={(e) => e.target.select()}
                      className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-200 rounded bg-gray-50 focus:outline-none focus:border-gray-400"
                    />
                    <button
                      onClick={() => copyShareLink("view")}
                      disabled={!viewLinkUrl}
                      className="px-3 py-1 text-xs font-medium bg-gray-900 hover:bg-gray-700 text-white rounded transition-colors shrink-0 w-[60px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {copied === "view" ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
              </div>
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
        <div className="relative shrink-0 ml-1 pl-2 sm:ml-2 border-l border-gray-200" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-md hover:bg-gray-100 px-1.5 py-1 transition-colors"
            aria-label="Account menu"
          >
            {sessionUser.image && (
              <img
                src={sessionUser.image}
                alt={sessionUser.name}
                className="w-7 h-7 rounded-full shrink-0"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="hidden md:inline text-sm text-gray-600">{sessionUser.name}</span>
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-20 min-w-[220px]">
                <div className="px-4 py-2 border-b border-gray-100">
                  <div className="text-sm font-medium text-gray-900 truncate">{sessionUser.name}</div>
                  <div className="text-xs text-gray-500 truncate">{sessionUser.email}</div>
                </div>
                <button
                  onClick={handleSignOut}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors rounded-b-md"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
