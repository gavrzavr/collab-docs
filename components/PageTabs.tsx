"use client";

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

/**
 * PageTabs — Excel-style tab bar for multi-page documents.
 *
 * Data model (Yjs):
 *   ydoc.getArray<string>("pageOrder")   — page IDs in display order
 *   ydoc.getMap<string>("pageTitles")    — id → title
 *
 * Fragment convention: each page stores its blocks in
 *   ydoc.getXmlFragment(pageId)
 * The first page historically uses id "blocknote" for backward compat with
 * single-page docs that existed before multi-page landed.
 *
 * All mutations go through a single Yjs transaction — reorder/rename/delete
 * are atomic and CRDT-safe across collaborators.
 */

export interface PageMeta {
  id: string;
  title: string;
}

interface PageTabsProps {
  ydoc: Y.Doc;
  pages: PageMeta[];
  activeId: string;
  onSwitch: (id: string) => void;
  readOnly?: boolean;
}

function newPageId(): string {
  // 10 random chars — matches generateBlockId shape in ws-server.
  // Ordinary pages use random IDs; the first page keeps "blocknote".
  return Math.random().toString(36).slice(2, 12);
}

export default function PageTabs({ ydoc, pages, activeId, onSwitch, readOnly }: PageTabsProps) {
  // Context menu state
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // ID of the tab currently in rename-mode
  const [renameId, setRenameId] = useState<string | null>(null);
  // Drag state — id being dragged, and the target (id + side) under the pointer
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);

  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Close menu on any outside click / Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Focus the rename input when entering rename mode
  useEffect(() => {
    if (renameId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameId]);

  // ─── Yjs mutations ──────────────────────────────────────
  const addPage = () => {
    const id = newPageId();
    const defaultTitle = `Page ${pages.length + 1}`;
    ydoc.transact(() => {
      ydoc.getArray<string>("pageOrder").push([id]);
      ydoc.getMap<string>("pageTitles").set(id, defaultTitle);
    });
    onSwitch(id);
  };

  const duplicatePage = (srcId: string) => {
    const src = pages.find((p) => p.id === srcId);
    if (!src) return;
    const id = newPageId();
    const titles = ydoc.getMap<string>("pageTitles");
    const order = ydoc.getArray<string>("pageOrder");
    const srcIdx = order.toArray().indexOf(srcId);

    // We intentionally do NOT deep-copy the XmlFragment content here — for V1
    // "Duplicate" creates a new empty page positioned after the source tab.
    // Deep-copying Yjs structures is non-trivial and rarely what users actually
    // want (they expect an empty template more often than a content clone).
    ydoc.transact(() => {
      order.insert(srcIdx >= 0 ? srcIdx + 1 : order.length, [id]);
      titles.set(id, `${src.title} (copy)`);
    });
    onSwitch(id);
  };

  const deletePage = (id: string) => {
    if (pages.length <= 1) {
      alert("A document must have at least one page.");
      return;
    }
    if (!confirm("Delete this page? This cannot be undone.")) return;

    const order = ydoc.getArray<string>("pageOrder");
    const titles = ydoc.getMap<string>("pageTitles");
    const idx = order.toArray().indexOf(id);
    if (idx < 0) return;

    ydoc.transact(() => {
      order.delete(idx, 1);
      titles.delete(id);
      // Note: the XmlFragment keyed by this id lingers in the Y.Doc. Yjs
      // doesn't expose a "delete fragment" primitive — the cost is tiny
      // (empty fragment ≈ a few bytes) and we preserve the ability to
      // undo the deletion via Yjs history.
    });

    // If we just deleted the active tab, switch to a neighbor.
    if (activeId === id) {
      const remaining = order.toArray();
      const nextId = remaining[Math.min(idx, remaining.length - 1)];
      if (nextId) onSwitch(nextId);
    }
  };

  const renamePage = (id: string, title: string) => {
    const trimmed = title.trim() || "Untitled";
    ydoc.getMap<string>("pageTitles").set(id, trimmed);
  };

  const reorder = (fromId: string, toId: string, side: "before" | "after") => {
    if (fromId === toId) return;
    const order = ydoc.getArray<string>("pageOrder");
    const arr = order.toArray();
    const fromIdx = arr.indexOf(fromId);
    const toIdx = arr.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;

    // Compute the final insertion index *after* removing the source — this
    // matches the HTML prototype's arithmetic so drop behavior feels the same.
    const insertAt = toIdx + (side === "after" ? 1 : 0) - (fromIdx < toIdx ? 1 : 0);
    ydoc.transact(() => {
      order.delete(fromIdx, 1);
      order.insert(insertAt, [fromId]);
    });
  };

  // ─── Render ──────────────────────────────────────────────
  return (
    <>
      <div
        className="flex items-stretch gap-[2px] px-4 border-b border-gray-200 bg-gray-50 overflow-x-auto select-none"
        role="tablist"
      >
        {pages.map((p) => {
          const isActive = p.id === activeId;
          const isDragging = dragId === p.id;
          const dropBefore = dropTarget?.id === p.id && dropTarget.side === "before";
          const dropAfter = dropTarget?.id === p.id && dropTarget.side === "after";

          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={isActive}
              draggable={!readOnly && renameId !== p.id}
              onDragStart={(e) => {
                if (readOnly) return;
                setDragId(p.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropTarget(null);
              }}
              onDragOver={(e) => {
                if (readOnly || !dragId || dragId === p.id) return;
                e.preventDefault();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const before = e.clientX < rect.left + rect.width / 2;
                setDropTarget({ id: p.id, side: before ? "before" : "after" });
              }}
              onDrop={(e) => {
                if (readOnly || !dragId || dragId === p.id) return;
                e.preventDefault();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const before = e.clientX < rect.left + rect.width / 2;
                reorder(dragId, p.id, before ? "before" : "after");
                setDragId(null);
                setDropTarget(null);
              }}
              onClick={() => {
                if (renameId !== p.id) onSwitch(p.id);
              }}
              onDoubleClick={() => {
                if (!readOnly) setRenameId(p.id);
              }}
              onContextMenu={(e) => {
                if (readOnly) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: p.id });
              }}
              className={[
                "group relative flex items-center gap-1.5 px-3.5 py-2.5 text-[13px] min-h-[36px] whitespace-nowrap cursor-pointer rounded-t-md border border-transparent border-b-0 -mb-px",
                isActive
                  ? "bg-white text-gray-900 border-gray-200 font-medium"
                  : "text-gray-600 hover:text-gray-800 hover:bg-gray-100",
                isDragging ? "opacity-40" : "",
                dropBefore ? "shadow-[-2px_0_0_#4F46E5]" : "",
                dropAfter ? "shadow-[2px_0_0_#4F46E5]" : "",
              ].join(" ")}
            >
              {renameId === p.id ? (
                <input
                  ref={renameInputRef}
                  defaultValue={p.title}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    renamePage(p.id, e.target.value);
                    setRenameId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      renamePage(p.id, (e.target as HTMLInputElement).value);
                      setRenameId(null);
                    } else if (e.key === "Escape") {
                      setRenameId(null);
                    }
                  }}
                  className="bg-white border border-indigo-500 rounded-sm px-1 outline-none min-w-[80px] text-gray-900"
                />
              ) : (
                <span className="pointer-events-none">{p.title}</span>
              )}

              {/* Close button (not shown in read-only or while renaming) */}
              {!readOnly && renameId !== p.id && (
                <span
                  role="button"
                  aria-label="Delete page"
                  title="Delete page"
                  onClick={(e) => {
                    e.stopPropagation();
                    deletePage(p.id);
                  }}
                  className={[
                    "w-4 h-4 rounded text-gray-500 text-xs leading-[14px] text-center",
                    isActive ? "inline-block" : "hidden group-hover:inline-block",
                    "hover:bg-gray-300 hover:text-gray-900",
                  ].join(" ")}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}

        {!readOnly && (
          <div
            role="button"
            aria-label="Add page"
            title="Add page"
            onClick={addPage}
            className="flex items-center justify-center w-8 my-1 rounded text-gray-500 text-lg cursor-pointer hover:bg-gray-200 hover:text-gray-900"
          >
            +
          </div>
        )}
      </div>

      {/* Context menu */}
      {menu && (
        <div
          className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-1 min-w-[160px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={() => { setRenameId(menu.id); setMenu(null); }}>Rename</MenuItem>
          <MenuItem onClick={() => { duplicatePage(menu.id); setMenu(null); }}>Duplicate</MenuItem>
          <div className="h-px bg-gray-200 mx-0.5 my-1" />
          <MenuItem danger onClick={() => { deletePage(menu.id); setMenu(null); }}>Delete</MenuItem>
        </div>
      )}
    </>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={[
        "px-2.5 py-1.5 text-[13px] rounded cursor-pointer",
        danger ? "text-red-600 hover:bg-red-50" : "text-gray-800 hover:bg-gray-100",
      ].join(" ")}
    >
      {children}
    </div>
  );
}
