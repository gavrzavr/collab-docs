"use client";

/**
 * LinkPicker — Notion-style fuzzy-search modal for picking an
 * intra-document link target (a tab or any block on any tab).
 *
 * Rendered at the document root (DocClient) so it overlays the
 * editor cleanly. Opened via the slash-command "Link to block"
 * item in `Editor.tsx`. On select, the chosen target is handed
 * back to DocClient, which inserts a markdown link at the editor
 * cursor with the right URL.
 *
 * Search is intentionally simple: case-insensitive substring on
 * the joined "pageTitle text" string, ranked by:
 *   1. Tabs before blocks (tabs are landmarks, blocks are details)
 *   2. Headings before paragraphs (headings are stable navigation)
 *   3. Earlier match position in the text
 * That's enough to feel right without a fuzzy-search dependency.
 *
 * Keyboard nav: ↑/↓ to move, Enter to pick, Esc to close. The
 * search input autofocuses on mount.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export type LinkTarget =
  | { kind: "page"; pageId: string; pageTitle: string }
  | {
      kind: "block";
      pageId: string;
      pageTitle: string;
      blockId: string;
      blockType: string;
      level?: number;
      text: string;
    };

interface LinkPickerProps {
  open: boolean;
  targets: LinkTarget[];
  onSelect: (target: LinkTarget) => void;
  onClose: () => void;
}

const MAX_RESULTS = 50;

function rankTarget(t: LinkTarget): number {
  // Lower is better.
  if (t.kind === "page") return 0;
  if (t.blockType === "heading") return 1 + (t.level ?? 1) * 0.1;
  return 5;
}

function matchScore(query: string, t: LinkTarget): number | null {
  if (!query) return rankTarget(t);
  const q = query.toLowerCase();
  const haystack = (
    t.kind === "page"
      ? t.pageTitle
      : `${t.pageTitle} ${t.text}`
  ).toLowerCase();
  const idx = haystack.indexOf(q);
  if (idx < 0) return null;
  return rankTarget(t) + idx * 0.001;
}

function formatBlockType(t: LinkTarget): string {
  if (t.kind === "page") return "Tab";
  if (t.blockType === "heading") return `H${t.level ?? 1}`;
  if (t.blockType === "paragraph") return "Text";
  if (t.blockType === "bulletListItem") return "Bullet";
  if (t.blockType === "numberedListItem") return "List";
  if (t.blockType === "checkListItem") return "Task";
  if (t.blockType === "quote") return "Quote";
  if (t.blockType === "table") return "Table";
  if (t.blockType === "htmlViz") return "Viz";
  return t.blockType;
}

export default function LinkPicker({ open, targets, onSelect, onClose }: LinkPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const scored: Array<{ t: LinkTarget; score: number }> = [];
    for (const t of targets) {
      const s = matchScore(query, t);
      if (s !== null) scored.push({ t, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.t);
  }, [query, targets]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    // Defer focus until after the modal is in the DOM.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Keep the active row in view as the user arrows down.
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const child = container.children[activeIdx] as HTMLElement | undefined;
    if (child) child.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[activeIdx];
      if (target) onSelect(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center pt-[15vh] bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Link to a block or tab"
    >
      <div
        className="w-[min(560px,calc(100vw-2rem))] bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tabs and blocks…"
          className="w-full px-4 py-3 border-b border-gray-200 text-sm outline-none"
          aria-label="Search"
        />
        <div
          ref={listRef}
          className="max-h-[50vh] overflow-y-auto"
          role="listbox"
        >
          {results.length === 0 && (
            <div className="px-4 py-8 text-sm text-gray-500 text-center">
              {query ? "No matching blocks or tabs." : "Nothing to link to yet."}
            </div>
          )}
          {results.map((t, i) => {
            const key =
              t.kind === "page"
                ? `p:${t.pageId}`
                : `b:${t.pageId}.${t.blockId}`;
            const active = i === activeIdx;
            const primary =
              t.kind === "page"
                ? t.pageTitle
                : t.text.trim() || "(empty)";
            const secondary =
              t.kind === "page"
                ? "Tab"
                : `${formatBlockType(t)} · in ${t.pageTitle}`;
            return (
              <div
                key={key}
                role="option"
                aria-selected={active}
                className={
                  "px-4 py-2.5 cursor-pointer flex items-baseline gap-3 " +
                  (active ? "bg-blue-50" : "hover:bg-gray-50")
                }
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => onSelect(t)}
              >
                <span className="text-[10px] uppercase tracking-wide text-gray-400 font-medium shrink-0 w-12">
                  {t.kind === "page" ? "Tab" : formatBlockType(t)}
                </span>
                <span className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900 truncate">{primary}</div>
                  <div className="text-xs text-gray-500 truncate">{secondary}</div>
                </span>
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400 flex gap-3">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
