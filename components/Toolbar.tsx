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
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      alert("Не удалось импортировать файл. Убедитесь, что это .docx файл.");
    } finally {
      setImporting(false);
      // Reset file input so same file can be re-imported
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white">
      <Link href={sessionUser ? "/dashboard" : "/"} className="text-sm font-medium text-gray-700 mr-auto hover:text-black transition-colors">
        CollabDocs
      </Link>
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
        className="px-3 py-1.5 text-sm bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-md transition-colors disabled:opacity-50"
      >
        {importing ? "Importing..." : "Import .docx"}
      </button>
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
