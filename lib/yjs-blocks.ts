/**
 * Shared helpers for reading BlockNote content out of a Yjs document.
 *
 * The Yjs document layout produced by y-prosemirror + BlockNote looks like:
 *
 *   Y.XmlFragment ("blocknote")
 *   └── blockGroup
 *       └── blockContainer (id = nanoid)
 *           ├── <type> (heading | paragraph | bulletListItem | table | …)
 *           │   └── Y.XmlText  (inline formatting via marks)
 *           └── blockGroup?   (nested children)
 *
 * Two gotchas that these helpers paper over:
 *
 * 1. `Y.XmlText#toJSON()` on a text node with marks returns ProseMirror XML
 *    like `<link 0="h" 1="t" …>hello</link>` — not the raw text. We use
 *    `toDelta()` instead and rebuild markdown from the deltas.
 *
 * 2. Link marks are stored as `{ link: { href: "…" } }` (an object, not a
 *    string). The legacy shape `{ link: "…"}` also appears in old documents,
 *    so we handle both.
 */
import * as Y from "yjs";

type DeltaAttrs = Record<string, unknown>;

/** Render a block's inline content as markdown. */
export function blockTextToMarkdown(el: Y.XmlElement): string {
  let text = "";
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) {
      try {
        const delta = child.toDelta() as Array<{ insert?: string; attributes?: DeltaAttrs }>;
        for (const op of delta) {
          if (typeof op.insert !== "string") continue;
          text += applyMarksToText(op.insert, op.attributes ?? {});
        }
      } catch {
        // Fallback: strip any embedded XML tags the fallback path might emit.
        text += child.toString().replace(/<[^>]+>/g, "");
      }
    } else if (child instanceof Y.XmlElement) {
      text += blockTextToMarkdown(child);
    }
  }
  return text;
}

function applyMarksToText(raw: string, attrs: DeltaAttrs): string {
  let t = raw;
  if (attrs.bold) t = `**${t}**`;
  if (attrs.italic) t = `*${t}*`;
  if (attrs.strike) t = `~~${t}~~`;
  if (attrs.code) t = `\`${t}\``;
  if (attrs.underline) t = `__${t}__`;
  if (attrs.link) {
    const href = typeof attrs.link === "object" && attrs.link !== null
      ? (attrs.link as { href?: string }).href
      : String(attrs.link);
    t = `[${t}](${href})`;
  }
  return t;
}

/** Render a `<table>` element as a markdown table. */
export function tableToMarkdown(tableEl: Y.XmlElement, emptyPlaceholder = ""): string {
  const rows: string[][] = [];
  for (let r = 0; r < tableEl.length; r++) {
    const row = tableEl.get(r);
    if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") continue;
    const cells: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = row.get(c);
      if (cell instanceof Y.XmlElement && cell.nodeName === "tableCell") {
        cells.push(blockTextToMarkdown(cell));
      }
    }
    rows.push(cells);
  }
  if (rows.length === 0) return emptyPlaceholder;
  const header = "| " + rows[0].join(" | ") + " |";
  const separator = "| " + rows[0].map(() => "---").join(" | ") + " |";
  const body = rows.slice(1).map((r) => "| " + r.join(" | ") + " |").join("\n");
  return [header, separator, body].filter(Boolean).join("\n");
}

export interface ExtractedBlock {
  id: string;
  type: string;
  text: string;
  level?: number;
}

/** Walk the document fragment and return one entry per block. */
export function extractBlocks(ydoc: Y.Doc): ExtractedBlock[] {
  const fragment = ydoc.getXmlFragment("blocknote");
  const blocks: ExtractedBlock[] = [];

  const walkBlockGroup = (bg: Y.XmlElement) => {
    for (let i = 0; i < bg.length; i++) {
      const bc = bg.get(i);
      if (!(bc instanceof Y.XmlElement) || bc.nodeName !== "blockContainer") continue;
      const id = bc.getAttribute("id") || "";
      for (let j = 0; j < bc.length; j++) {
        const child = bc.get(j);
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "blockGroup") {
          walkBlockGroup(child);
        } else if (child.nodeName === "table") {
          blocks.push({ id, type: "table", text: tableToMarkdown(child, "(empty table)") });
        } else {
          const type = child.nodeName;
          const level = type === "heading"
            ? Number(child.getAttribute("level") || "1")
            : undefined;
          blocks.push({ id, type, text: blockTextToMarkdown(child), level });
        }
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
      walkBlockGroup(child);
    }
  }

  return blocks;
}

/** Render the whole document as a single markdown string. */
export function extractDocumentMarkdown(ydoc: Y.Doc): string {
  return extractBlocks(ydoc)
    .map((b) => {
      if (b.type === "heading") return "#".repeat(b.level || 1) + " " + b.text;
      if (b.type === "bulletListItem") return "- " + b.text;
      if (b.type === "numberedListItem") return "1. " + b.text;
      return b.text;
    })
    .join("\n");
}

/** Return the first heading's text, or "Untitled". */
export function extractTitle(ydoc: Y.Doc): string {
  for (const block of extractBlocks(ydoc)) {
    if (block.type === "heading" && block.text.trim()) {
      // Strip inline markdown formatting from the title.
      return stripInlineMarkdown(block.text).trim() || "Untitled";
    }
  }
  return "Untitled";
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // [label](url) → label
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}
