"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Heading = { id: string; level: number; text: string };

// Narrow slice of the BlockNote editor we actually use. Avoids bringing a full
// schema generic into this component while still keeping the boundary typed.
type InlineItem = { type?: string; text?: string; content?: unknown } | string;
type EditorBlock = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: InlineItem[] | string;
};
type EditorLike = {
  document: EditorBlock[];
  onChange?: (cb: () => void) => (() => void) | void;
};

interface OutlinePanelProps {
  editor: EditorLike | null;
  scrollContainer: HTMLElement | null;
}

// Walk block.content (BlockNote inline-content tree) and concatenate plain text.
function blockPlainText(block: EditorBlock): string {
  const content = block.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (typeof item === "string") {
      out += item;
    } else if (item?.type === "text" && typeof item.text === "string") {
      out += item.text;
    } else if (Array.isArray((item as { content?: unknown }).content)) {
      out += blockPlainText(item as EditorBlock);
    }
  }
  return out;
}

function extractHeadings(editor: EditorLike): Heading[] {
  if (!editor?.document) return [];
  const list: Heading[] = [];
  for (const block of editor.document) {
    if (block?.type !== "heading") continue;
    // Yjs stores level as a string ("1") — coerce.
    const level = Number(block?.props?.level) || 1;
    const text = blockPlainText(block).trim();
    list.push({ id: String(block.id), level, text });
  }
  return list;
}

// Scroll the container to targetTop reliably.
//
// `scrollTo({behavior:"smooth"})` gives us a nice animation in visible
// tabs, but Chrome silently drops queued smooth scrolls in hidden /
// backgrounded tabs (the compositor's scroll animator is suspended, and
// the work is *not* resumed when the tab is shown again).
//
// Safety net: 600ms after requesting the smooth scroll, if we haven't
// landed at the target, snap the scrollTop directly. In a visible tab
// this is a no-op (animation has already completed). In a hidden tab
// this guarantees the scroll position is correct when the user returns.
// Returns a cancel function in case the component unmounts mid-flight.
function scrollContainerTo(
  container: HTMLElement,
  targetTop: number
): () => void {
  try {
    container.scrollTo({ top: targetTop, behavior: "smooth" });
  } catch {
    container.scrollTop = targetTop;
    return () => {};
  }
  const timer = setTimeout(() => {
    if (Math.abs(container.scrollTop - targetTop) > 2) {
      container.scrollTop = targetTop;
    }
  }, 600);
  return () => clearTimeout(timer);
}

export default function OutlinePanel({ editor, scrollContainer }: OutlinePanelProps) {
  // Bump on every editor change to force re-derivation.
  const [editorTick, setEditorTick] = useState(0);
  // ID observed as topmost visible heading by IntersectionObserver.
  const [observedActiveId, setObservedActiveId] = useState<string | null>(null);

  // When the user clicks a TOC link, we optimistically set a preferred active
  // id and lock the observer briefly so it doesn't flip mid-scroll.
  const [preferredActiveId, setPreferredActiveId] = useState<string | null>(null);
  const observerLockedRef = useRef(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelScrollRef = useRef<(() => void) | null>(null);

  // Subscribe to editor changes — bump tick so derived headings re-compute.
  useEffect(() => {
    if (!editor?.onChange) return;
    const unsubscribe = editor.onChange(() => setEditorTick((t) => t + 1));
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [editor]);

  // Derive headings from the current editor state (no sync-state-in-effect).
  const headings = useMemo<Heading[]>(
    () => (editor ? extractHeadings(editor) : []),
    // editorTick is the subscription trigger — bumping it invalidates the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, editorTick]
  );

  // Effective active id: prefer the click target; fall back to observed; then first heading.
  const activeId = useMemo<string | null>(() => {
    const candidates = [preferredActiveId, observedActiveId];
    for (const c of candidates) {
      if (c && headings.some((h) => h.id === c)) return c;
    }
    return headings[0]?.id ?? null;
  }, [preferredActiveId, observedActiveId, headings]);

  // Stable key of heading ids, so we don't tear down the observer on every
  // keystroke (the `headings` array reference changes every tick even when
  // the set of ids is identical).
  const headingIdsKey = useMemo(() => headings.map((h) => h.id).join(","), [headings]);

  // Track which heading is currently "in view" via IntersectionObserver.
  useEffect(() => {
    if (!scrollContainer || headingIdsKey === "") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (observerLockedRef.current) return;
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const topId = visible[0].target.getAttribute("data-id");
        if (topId) setObservedActiveId(topId);
      },
      {
        root: scrollContainer,
        // Consider a heading "active" once it crosses into the top 30% of the scroll area.
        rootMargin: "0px 0px -70% 0px",
        threshold: 0,
      }
    );

    // Observe each heading's DOM element. BlockNote wraps blocks in [data-id="..."].
    // Delay one frame to let newly-inserted blocks mount.
    const ids = headingIdsKey.split(",");
    const raf = requestAnimationFrame(() => {
      for (const id of ids) {
        const el = scrollContainer.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (el) observer.observe(el);
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [headingIdsKey, scrollContainer]);

  // Clean up any pending unlock timer / scroll fallback on unmount.
  useEffect(() => {
    return () => {
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
      if (cancelScrollRef.current) cancelScrollRef.current();
    };
  }, []);

  const handleClick = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    if (!scrollContainer) return;
    const el = scrollContainer.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    // Compute offset relative to the scroll container (works regardless of
    // layout: offsetTop isn't reliable across nested offsetParents).
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = (el as HTMLElement).getBoundingClientRect();
    const nextScrollTop = scrollContainer.scrollTop + (targetRect.top - containerRect.top);

    setPreferredActiveId(id);
    observerLockedRef.current = true;
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = setTimeout(() => {
      observerLockedRef.current = false;
      unlockTimerRef.current = null;
      // Release preferred so observer takes over smoothly afterward.
      setPreferredActiveId(null);
    }, 500);

    if (cancelScrollRef.current) cancelScrollRef.current();
    cancelScrollRef.current = scrollContainerTo(scrollContainer, Math.max(0, nextScrollTop));
  };

  // Empty state — don't render the panel at all, so layout shifts don't flash.
  if (headings.length === 0) return null;

  return (
    <aside
      aria-label="Document outline"
      className="hidden lg:block flex-shrink-0 w-[240px] overflow-y-auto border-r border-gray-100 py-6 pl-4 pr-2"
    >
      <ul className="list-none p-0 m-0">
        {headings.map((h) => {
          const isActive = h.id === activeId;
          // Clamp level 1-3 — deeper levels collapse to level 3 indent to keep the panel tidy.
          const lvl = Math.min(Math.max(h.level, 1), 3);
          const indent = { 1: "pl-2.5", 2: "pl-6", 3: "pl-10" }[lvl];
          const baseColor = lvl === 3 ? "text-gray-400" : lvl === 1 ? "text-gray-700" : "text-gray-500";
          const fontWeight = lvl === 1 ? "font-medium" : "font-normal";
          const sizeClass = lvl === 3 ? "text-[12.5px]" : "text-[13px]";
          return (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                onClick={(e) => handleClick(e, h.id)}
                className={[
                  "block py-1 rounded leading-snug truncate cursor-pointer transition-colors",
                  indent,
                  sizeClass,
                  isActive
                    ? "text-gray-900 font-semibold"
                    : `${baseColor} ${fontWeight} hover:text-gray-900`,
                ].join(" ")}
                title={h.text || "Untitled"}
              >
                {h.text || <span className="italic text-gray-400">Untitled</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
