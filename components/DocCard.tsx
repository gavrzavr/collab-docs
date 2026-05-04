"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

export interface DocCardProps {
  id: string;
  title: string;
  updated_at: string;
  owner_id: string | null;
  role: "owner" | "editor" | "commenter";
  /** Called after successful rename/delete so the parent can refresh
   *  the list. Server already wrote — this is a UI-state hint. */
  onChanged: () => void;
}

const ROLE_CHIP: Record<DocCardProps["role"], { label: string; classes: string }> = {
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

/**
 * Dashboard card: clickable surface that opens the doc, plus a `•••`
 * menu in the top-right corner with Rename / Delete / Open in new tab.
 *
 * Mirrors Daria's reference (Google Drive context menu). Native
 * `prompt`/`confirm` dialogs are deliberate — they ship today and
 * unblock the use case. Polished dialogs can come later if needed.
 */
export default function DocCard(props: DocCardProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<"rename" | "delete" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu when clicking outside.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const chip = ROLE_CHIP[props.role];

  async function handleRename() {
    setMenuOpen(false);
    const next = window.prompt("Rename document", props.title || "Untitled");
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === props.title) return;
    setBusy("rename");
    try {
      const res = await fetch(`/api/v1/docs/${props.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Couldn't rename — please try again.");
        return;
      }
      props.onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    setMenuOpen(false);
    const confirmed = window.confirm(
      `Delete "${props.title || "Untitled"}"?\n\nThis can't be undone — the document, its history, share links and collaborator list will be removed.`
    );
    if (!confirmed) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/v1/docs/${props.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Couldn't delete — please try again.");
        return;
      }
      props.onChanged();
    } finally {
      setBusy(null);
    }
  }

  function handleOpenNewTab() {
    setMenuOpen(false);
    window.open(`/doc/${props.id}`, "_blank", "noopener,noreferrer");
  }

  // Only owners can delete; editors can rename (since they could edit
  // the H1 anyway). Commenters get neither.
  const canRename = props.role === "owner" || props.role === "editor";
  const canDelete = props.role === "owner";

  return (
    <div className="relative group">
      <button
        onClick={() => router.push(`/doc/${props.id}`)}
        disabled={busy !== null}
        className="w-full text-left p-5 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-md transition-all disabled:opacity-50"
      >
        <h3 className="font-medium text-gray-900 mb-2 truncate pr-8">
          {props.title || "Untitled"}
        </h3>
        <div className="flex items-center justify-between gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${chip.classes}`}
          >
            {chip.label}
          </span>
          <span className="text-xs text-gray-400">
            {busy === "rename" ? "renaming…" : busy === "delete" ? "deleting…" : timeAgo(props.updated_at)}
          </span>
        </div>
        {props.role !== "owner" && props.owner_id && (
          <p className="text-xs text-gray-400 mt-2 truncate">from {props.owner_id}</p>
        )}
      </button>

      {/* Three-dots menu trigger. Always visible on touch (no hover state),
          fades in on hover for desktop. Top-right corner so it doesn't
          fight the role chip / timestamp on the bottom row. */}
      <div className="absolute top-3 right-3" ref={menuRef}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Document actions"
          className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-9 bg-white border border-gray-200 rounded-md shadow-lg z-10 min-w-[180px] py-1">
            {canRename && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRename();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Rename
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenNewTab();
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Open in new tab
            </button>
            {canDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors border-t border-gray-100 mt-1 pt-2"
              >
                Delete…
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
