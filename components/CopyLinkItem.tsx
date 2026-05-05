"use client";

/**
 * "Copy link" item for the drag-handle menu (sidemenu).
 *
 * Notion-equivalent UX: click the 6-dot grip on any block → Copy link
 * → URL ends up in the clipboard. Paste it anywhere in the same doc
 * (or send it to a teammate who has access) and it deep-links to that
 * exact block: clicking jumps to the right tab and highlights the
 * block briefly.
 *
 * URL format:    https://postpaper.co/doc/<id>#<pageId>.<blockId>
 *
 * The dot separator is intentional — nanoids never contain dots, so
 * `pageId.blockId` is unambiguous on parse. Hash without a dot stays
 * backward-compatible with the existing tab anchors (`#pageId`).
 *
 * The "Copy" button briefly flips to "Copied!" for feedback. We try
 * `navigator.clipboard.writeText` first (modern path) and fall back
 * to a hidden textarea + execCommand('copy') for browsers/contexts
 * where clipboard permissions are denied (some embedded webviews).
 */
import { ReactNode, useState } from "react";
import { RiLinkM } from "react-icons/ri";
import { useComponentsContext, useBlockNoteEditor, useExtensionState } from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";

interface CopyLinkItemProps {
  children: ReactNode;
  /** Document id from the route — used to construct the absolute URL. */
  docId: string;
  /** Active tab id at the moment the menu was opened. The block's
   *  page is the active one because the drag-handle is, by definition,
   *  attached to a block on the rendered page. */
  activePageId: string;
}

export function CopyLinkItem({ children, docId, activePageId }: CopyLinkItemProps) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const [copied, setCopied] = useState(false);

  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  if (!block) return null;

  const handleCopy = async () => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://postpaper.co";
    const url = `${origin}/doc/${docId}#${activePageId}.${block.id}`;
    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      /* fall through to legacy path */
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        ok = true;
      } catch {
        /* ignore */
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Components.Generic.Menu.Item
      className={"bn-menu-item"}
      icon={<RiLinkM size={16} />}
      onClick={handleCopy}
    >
      {copied ? "Copied!" : children}
    </Components.Generic.Menu.Item>
  );
}
