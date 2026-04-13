import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT) || Number(process.env.WS_PORT) || 1234;
// On Railway with a Volume mounted at /app/data, use that for persistence.
// Locally, fall back to ./data/ in the project directory.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/app/data") ? "/app/data" : path.join(process.cwd(), "data"));
const DB_PATH = path.join(DATA_DIR, "collab-docs.db");

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS yjs_documents (
    doc_id TEXT PRIMARY KEY,
    state BLOB
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled',
    owner_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const messageSync = 0;
const messageAwareness = 1;

// In-memory docs and their connections
const docs = new Map<string, { ydoc: Y.Doc; awareness: awarenessProtocol.Awareness; conns: Set<WebSocket> }>();

/** Extract first heading text from a Yjs doc for title */
function extractTitle(ydoc: Y.Doc): string {
  try {
    const fragment = ydoc.getXmlFragment("blocknote");
    for (let i = 0; i < fragment.length; i++) {
      const child = fragment.get(i);
      if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
        for (let j = 0; j < child.length; j++) {
          const bc = child.get(j);
          if (bc instanceof Y.XmlElement && bc.nodeName === "blockContainer") {
            for (let k = 0; k < bc.length; k++) {
              const block = bc.get(k);
              if (block instanceof Y.XmlElement && block.nodeName === "heading") {
                let text = "";
                for (let l = 0; l < block.length; l++) {
                  const t = block.get(l);
                  if (t instanceof Y.XmlText) text += t.toJSON();
                }
                if (text.trim()) return text.trim();
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return "Untitled";
}

/** Extract all text from a Yjs doc as markdown */
function extractDocumentText(ydoc: Y.Doc): string {
  const fragment = ydoc.getXmlFragment("blocknote");
  const lines: string[] = [];

  function walkBlockGroup(bg: Y.XmlElement) {
    for (let i = 0; i < bg.length; i++) {
      const bc = bg.get(i);
      if (bc instanceof Y.XmlElement && bc.nodeName === "blockContainer") {
        walkBlockContainer(bc);
      }
    }
  }

  function getTextContent(el: Y.XmlElement): string {
    let text = "";
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i);
      if (child instanceof Y.XmlText) {
        text += child.toJSON();
      } else if (child instanceof Y.XmlElement) {
        text += getTextContent(child);
      }
    }
    return text;
  }

  function extractTableMarkdown(tableEl: Y.XmlElement): string {
    const rows: string[][] = [];
    for (let r = 0; r < tableEl.length; r++) {
      const row = tableEl.get(r);
      if (row instanceof Y.XmlElement && row.nodeName === "tableRow") {
        const cells: string[] = [];
        for (let c = 0; c < row.length; c++) {
          const cell = row.get(c);
          if (cell instanceof Y.XmlElement && cell.nodeName === "tableCell") {
            cells.push(getTextContent(cell));
          }
        }
        rows.push(cells);
      }
    }
    if (rows.length === 0) return "";
    const header = "| " + rows[0].join(" | ") + " |";
    const separator = "| " + rows[0].map(() => "---").join(" | ") + " |";
    const body = rows.slice(1).map(r => "| " + r.join(" | ") + " |").join("\n");
    return [header, separator, body].filter(Boolean).join("\n");
  }

  function walkBlockContainer(bc: Y.XmlElement) {
    for (let i = 0; i < bc.length; i++) {
      const child = bc.get(i);
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === "blockGroup") {
          walkBlockGroup(child);
        } else if (child.nodeName === "table") {
          lines.push(extractTableMarkdown(child));
        } else {
          const text = getTextContent(child);
          const type = child.nodeName;
          if (type === "heading") {
            const level = child.getAttribute("level") || "1";
            lines.push("#".repeat(Number(level)) + " " + text);
          } else if (type === "bulletListItem") {
            lines.push("- " + text);
          } else if (type === "numberedListItem") {
            lines.push("1. " + text);
          } else {
            lines.push(text);
          }
        }
      }
    }
  }

  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
      walkBlockGroup(child);
    }
  }

  return lines.join("\n");
}

/** Parse markdown into block descriptors */
function parseMarkdown(text: string): Array<{ type: string; text: string; level?: number }> {
  // Normalize line endings: handle escaped \n from JSON, \r\n, and real \n
  const normalized = text.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  return normalized.split("\n").map(line => {
    const trimmed = line.trimEnd();
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      return { type: "heading", text: headingMatch[2], level: headingMatch[1].length };
    } else if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("[] ")) {
      const checked = trimmed.includes("[x]");
      const text = trimmed.replace(/^-?\s*\[[ x]?\]\s*/, "");
      return { type: "checkListItem", text, checked };
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      return { type: "bulletListItem", text: trimmed.slice(2) };
    } else if (/^\d+\.\s/.test(trimmed)) {
      return { type: "numberedListItem", text: trimmed.replace(/^\d+\.\s/, "") };
    }
    return { type: "paragraph", text: trimmed };
  }).filter(b => b.text.length > 0); // skip empty lines
}

/** Generate a random block ID */
function generateBlockId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id + "-" + Date.now().toString(36);
}

/** Block styling options */
interface BlockStyle {
  textColor?: string;
  backgroundColor?: string;
  textAlignment?: string;
}

/** Parse inline markdown formatting into XmlText with attributes.
 *  Supports: **bold**, *italic*, ~~strikethrough~~, `code`, __underline__, [text](url)
 */
function createFormattedText(text: string): Y.XmlText {
  const xmlText = new Y.XmlText();
  let pos = 0;

  // Regex for inline formatting tokens (link MUST be checked before bold/italic to avoid conflicts)
  const regex = /(\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|__(.+?)__)/g;
  let match;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    // Insert plain text before this match
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      xmlText.insert(pos, plain, {});
      pos += plain.length;
    }

    if (match[2] && match[3]) {
      // [text](url) — link (y-prosemirror stores mark attrs as objects)
      xmlText.insert(pos, match[2], { link: { href: match[3] } });
      pos += match[2].length;
    } else if (match[4]) {
      // **bold**
      xmlText.insert(pos, match[4], { bold: true });
      pos += match[4].length;
    } else if (match[5]) {
      // *italic*
      xmlText.insert(pos, match[5], { italic: true });
      pos += match[5].length;
    } else if (match[6]) {
      // ~~strikethrough~~
      xmlText.insert(pos, match[6], { strike: true });
      pos += match[6].length;
    } else if (match[7]) {
      // `code`
      xmlText.insert(pos, match[7], { code: true });
      pos += match[7].length;
    } else if (match[8]) {
      // __underline__
      xmlText.insert(pos, match[8], { underline: true });
      pos += match[8].length;
    }

    lastIndex = regex.lastIndex;
  }

  // Insert remaining plain text (explicit empty attrs to avoid inheriting previous formatting)
  if (lastIndex < text.length) {
    xmlText.insert(pos, text.slice(lastIndex), {});
  }

  return xmlText;
}

/** Create a BlockNote-compatible blockContainer XML element.
 *  Must match exact structure that BlockNote creates:
 *  <blockContainer id="xxx">
 *    <paragraph backgroundColor="default" textColor="default" textAlignment="left">
 *      [XmlText: "content"]
 *  No inline-content wrapper — text goes directly into the block element.
 */
function createBlock(ydoc: Y.Doc, type: string, text: string, level?: number, style?: BlockStyle): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", generateBlockId());

  const blockEl = new Y.XmlElement(type);
  blockEl.setAttribute("backgroundColor", style?.backgroundColor || "default");
  blockEl.setAttribute("textColor", style?.textColor || "default");
  blockEl.setAttribute("textAlignment", style?.textAlignment || "left");
  if (type === "heading") {
    blockEl.setAttribute("level", String(level || 1));
  }
  if (type === "checkListItem") {
    blockEl.setAttribute("checked", "false");
  }

  // Use formatted text if it contains inline markdown, otherwise plain
  const hasFormatting = /(\[.+?\]\(.+?\)|\*\*.+?\*\*|\*.+?\*|~~.+?~~|`.+?`|__.+?__)/.test(text);
  if (hasFormatting) {
    blockEl.insert(0, [createFormattedText(text)]);
  } else {
    blockEl.insert(0, [new Y.XmlText(text)]);
  }

  container.insert(0, [blockEl]);
  return container;
}

/** Append markdown text to a Yjs document */
function appendTextToDoc(ydoc: Y.Doc, markdownText: string): number {
  const blocks = parseMarkdown(markdownText);
  const fragment = ydoc.getXmlFragment("blocknote");

  ydoc.transact(() => {
    // Find or create the blockGroup
    let blockGroup: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const child = fragment.get(i);
      if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
        blockGroup = child;
        break;
      }
    }

    if (!blockGroup) {
      blockGroup = new Y.XmlElement("blockGroup");
      fragment.insert(0, [blockGroup]);
    }

    // Append new blocks at the end
    for (const block of blocks) {
      const el = createBlock(ydoc, block.type, block.text, block.level);
      blockGroup.insert(blockGroup.length, [el]);
    }
  });

  return blocks.length;
}

/** Replace entire document content with markdown */
function replaceDocContent(ydoc: Y.Doc, markdownText: string): number {
  const blocks = parseMarkdown(markdownText);
  const fragment = ydoc.getXmlFragment("blocknote");

  ydoc.transact(() => {
    // Clear everything
    while (fragment.length > 0) {
      fragment.delete(0);
    }

    // Create fresh blockGroup with new blocks
    const blockGroup = new Y.XmlElement("blockGroup");
    for (const block of blocks) {
      const el = createBlock(ydoc, block.type, block.text, block.level);
      blockGroup.insert(blockGroup.length, [el]);
    }
    fragment.insert(0, [blockGroup]);
  });

  return blocks.length;
}

/** Extract blocks with IDs for block-level editing */
function extractBlocksWithIds(ydoc: Y.Doc): Array<{ id: string; type: string; text: string; level?: number }> {
  const fragment = ydoc.getXmlFragment("blocknote");
  const blocks: Array<{ id: string; type: string; text: string; level?: number }> = [];

  function getTextContent(el: Y.XmlElement): string {
    let text = "";
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i);
      if (child instanceof Y.XmlText) {
        // Use toDelta to get clean text with formatting info
        try {
          const delta = child.toDelta();
          for (const op of delta) {
            if (typeof op.insert === "string") {
              const attrs = op.attributes || {};
              let t = op.insert;
              if (attrs.bold) t = `**${t}**`;
              if (attrs.italic) t = `*${t}*`;
              if (attrs.strike) t = `~~${t}~~`;
              if (attrs.code) t = `\`${t}\``;
              if (attrs.underline) t = `__${t}__`;
              if (attrs.link) {
                const href = typeof attrs.link === "object" ? attrs.link.href : attrs.link;
                t = `[${t}](${href})`;
              }
              text += t;
            }
          }
        } catch {
          text += child.toString().replace(/<[^>]+>/g, "");
        }
      } else if (child instanceof Y.XmlElement) {
        text += getTextContent(child);
      }
    }
    return text;
  }

  function extractTableText(tableEl: Y.XmlElement): string {
    const rows: string[][] = [];
    for (let r = 0; r < tableEl.length; r++) {
      const row = tableEl.get(r);
      if (row instanceof Y.XmlElement && row.nodeName === "tableRow") {
        const cells: string[] = [];
        for (let c = 0; c < row.length; c++) {
          const cell = row.get(c);
          if (cell instanceof Y.XmlElement && cell.nodeName === "tableCell") {
            cells.push(getTextContent(cell));
          }
        }
        rows.push(cells);
      }
    }
    // Format as markdown-style table
    if (rows.length === 0) return "(empty table)";
    const header = "| " + rows[0].join(" | ") + " |";
    const separator = "| " + rows[0].map(() => "---").join(" | ") + " |";
    const body = rows.slice(1).map(r => "| " + r.join(" | ") + " |").join("\n");
    return [header, separator, body].filter(Boolean).join("\n");
  }

  function walkBlockGroup(bg: Y.XmlElement) {
    for (let i = 0; i < bg.length; i++) {
      const bc = bg.get(i);
      if (bc instanceof Y.XmlElement && bc.nodeName === "blockContainer") {
        const id = bc.getAttribute("id") || "";
        for (let j = 0; j < bc.length; j++) {
          const child = bc.get(j);
          if (child instanceof Y.XmlElement) {
            if (child.nodeName === "blockGroup") {
              walkBlockGroup(child);
            } else if (child.nodeName === "table") {
              const text = extractTableText(child);
              blocks.push({ id, type: "table", text });
            } else {
              const text = getTextContent(child);
              const type = child.nodeName;
              const level = type === "heading" ? Number(child.getAttribute("level") || "1") : undefined;
              blocks.push({ id, type, text, level });
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
      walkBlockGroup(child);
    }
  }

  return blocks;
}

/** Find a blockContainer by its ID and return it with parent info */
function findBlockContainer(fragment: Y.XmlFragment, blockId: string): { container: Y.XmlElement; parent: Y.XmlElement; index: number } | null {
  function search(parent: Y.XmlElement | Y.XmlFragment): { container: Y.XmlElement; parent: Y.XmlElement; index: number } | null {
    for (let i = 0; i < parent.length; i++) {
      const child = parent.get(i);
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) {
          return { container: child, parent: parent as Y.XmlElement, index: i };
        }
        const found = search(child);
        if (found) return found;
      }
    }
    return null;
  }
  return search(fragment);
}

/** Update text of a specific block by ID */
function updateBlockText(ydoc: Y.Doc, blockId: string, newText: string, newType?: string, newLevel?: number, style?: BlockStyle): boolean {
  const fragment = ydoc.getXmlFragment("blocknote");
  const found = findBlockContainer(fragment, blockId);
  if (!found) return false;

  ydoc.transact(() => {
    const { parent, index } = found;
    // Remove old container and insert new one at same position
    parent.delete(index, 1);
    const type = newType || "paragraph";
    const block = createBlock(ydoc, type, newText, newLevel, style);
    // Preserve the original block ID
    block.setAttribute("id", blockId);
    parent.insert(index, [block]);
  });

  return true;
}

/** Delete a block by ID */
function deleteBlock(ydoc: Y.Doc, blockId: string): boolean {
  const fragment = ydoc.getXmlFragment("blocknote");
  const found = findBlockContainer(fragment, blockId);
  if (!found) return false;

  ydoc.transact(() => {
    found.parent.delete(found.index, 1);
  });

  return true;
}

/** Insert a block after a specific block ID */
function insertBlockAfter(ydoc: Y.Doc, afterBlockId: string, type: string, text: string, level?: number, style?: BlockStyle): string | null {
  const fragment = ydoc.getXmlFragment("blocknote");
  const found = findBlockContainer(fragment, afterBlockId);
  if (!found) return null;

  const newBlock = createBlock(ydoc, type, text, level, style);
  const newId = newBlock.getAttribute("id") || "";

  ydoc.transact(() => {
    found.parent.insert(found.index + 1, [newBlock]);
  });

  return newId;
}

/** Create a table block from a 2D array of cell text */
function createTableBlock(rows: string[][]): { element: Y.XmlElement; id: string } {
  const container = new Y.XmlElement("blockContainer");
  const id = generateBlockId();
  container.setAttribute("id", id);

  const table = new Y.XmlElement("table");

  for (const rowData of rows) {
    const row = new Y.XmlElement("tableRow");
    for (const cellText of rowData) {
      const cell = new Y.XmlElement("tableCell");
      cell.setAttribute("colspan", "1");
      cell.setAttribute("rowspan", "1");
      const para = new Y.XmlElement("tableParagraph");
      const hasFormatting = /(\[.+?\]\(.+?\)|\*\*.+?\*\*|\*.+?\*|~~.+?~~|`.+?`|__.+?__)/.test(cellText);
      if (hasFormatting) {
        para.insert(0, [createFormattedText(cellText)]);
      } else {
        para.insert(0, [new Y.XmlText(cellText)]);
      }
      cell.insert(0, [para]);
      row.insert(row.length, [cell]);
    }
    table.insert(table.length, [row]);
  }

  container.insert(0, [table]);
  return { element: container, id };
}

/** Append a table to the document */
function appendTable(ydoc: Y.Doc, rows: string[][]): string {
  const fragment = ydoc.getXmlFragment("blocknote");
  const { element: tableBlock, id: blockId } = createTableBlock(rows);

  ydoc.transact(() => {
    let blockGroup: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const child = fragment.get(i);
      if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
        blockGroup = child;
        break;
      }
    }
    if (!blockGroup) {
      blockGroup = new Y.XmlElement("blockGroup");
      fragment.insert(0, [blockGroup]);
    }
    blockGroup.insert(blockGroup.length, [tableBlock]);
  });

  return blockId;
}

/** Insert a table after a specific block */
function insertTableAfter(ydoc: Y.Doc, afterBlockId: string, rows: string[][]): string | null {
  const fragment = ydoc.getXmlFragment("blocknote");
  const found = findBlockContainer(fragment, afterBlockId);
  if (!found) return null;

  const { element: tableBlock, id: newId } = createTableBlock(rows);

  ydoc.transact(() => {
    found.parent.insert(found.index + 1, [tableBlock]);
  });

  return newId;
}

/** Dump XML structure for debugging */
function dumpXml(element: Y.XmlElement | Y.XmlText | Y.XmlFragment, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (element instanceof Y.XmlText) return `${pad}[TEXT: "${element.toJSON()}"]\n`;
  // Check XmlElement BEFORE XmlFragment (XmlElement extends XmlFragment)
  if (element instanceof Y.XmlElement) {
    const attrs = element.getAttributes();
    const attrStr = Object.keys(attrs).length > 0 ? " " + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ") : "";
    let r = `${pad}<${element.nodeName}${attrStr}>\n`;
    for (let i = 0; i < element.length; i++) {
      const c = element.get(i);
      if (c instanceof Y.XmlElement || c instanceof Y.XmlText || c instanceof Y.XmlFragment) r += dumpXml(c, indent + 1);
    }
    return r;
  }
  // Pure XmlFragment (root)
  let r = `${pad}[Fragment] (${element.length} children)\n`;
  for (let i = 0; i < element.length; i++) {
    const c = element.get(i);
    if (c instanceof Y.XmlElement || c instanceof Y.XmlText || c instanceof Y.XmlFragment) r += dumpXml(c, indent + 1);
  }
  return r;
}

function getOrCreateDoc(docName: string) {
  let entry = docs.get(docName);
  if (entry) return entry;

  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);

  // Load persisted state
  const row = db.prepare("SELECT state FROM yjs_documents WHERE doc_id = ?").get(docName) as
    | { state: Buffer }
    | undefined;
  if (row?.state) {
    Y.applyUpdate(ydoc, new Uint8Array(row.state));
  }

  // Persist on updates (debounced) + update title
  let persistTimeout: ReturnType<typeof setTimeout> | null = null;
  const persistDoc = () => {
    const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    db.prepare(
      "INSERT INTO yjs_documents (doc_id, state) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET state = ?"
    ).run(docName, state, state);

    // Update document title from first heading
    const title = extractTitle(ydoc);
    db.prepare(
      "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title, docName);
  };

  ydoc.on("update", () => {
    if (persistTimeout) clearTimeout(persistTimeout);
    persistTimeout = setTimeout(persistDoc, 500);
  });

  entry = { ydoc, awareness, conns: new Set() };
  docs.set(docName, entry);
  return entry;
}

function send(ws: WebSocket, message: Uint8Array) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  }
}

// ─── MCP Server Factory ───────────────────────────────────────────────────
// Creates a new MCP server instance with tools for reading and editing docs.
// Each HTTP request gets its own instance (stateless mode).

const VERCEL_URL = process.env.VERCEL_URL || "https://collab-docs-rose.vercel.app";

function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "CollabDocs",
    version: "0.3.0",
    instructions: MCP_INSTRUCTIONS,
  });

  mcp.tool(
    "read_document",
    "Read the content of a CollabDocs document. Returns each block with its ID, type, and text. Use the block IDs to make targeted edits with update_block, delete_block, or insert_block.",
    {
      doc_url: z.string().describe("Document URL (e.g. https://collab-docs-rose.vercel.app/doc/ABC123) or just the document ID"),
    },
    async ({ doc_url }) => {
      const docId = extractDocIdFromUrl(doc_url);
      try {
        const entry = getOrCreateDoc(docId);
        const blocks = extractBlocksWithIds(entry.ydoc);
        if (blocks.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Document (ID: ${docId}) is empty. Use edit_document to add content.`,
            }],
          };
        }

        const lines = blocks.map(b => {
          const prefix = b.type === "heading" ? "#".repeat(b.level || 1) + " "
            : b.type === "bulletListItem" ? "- "
            : b.type === "numberedListItem" ? "1. "
            : "";
          return `[${b.id}] ${prefix}${b.text}`;
        });

        return {
          content: [{
            type: "text" as const,
            text: `Document "${extractTitle(entry.ydoc)}" (ID: ${docId}), ${blocks.length} blocks:\n\n${lines.join("\n")}\n\n--- EDITING INSTRUCTIONS ---\nUse update_block(block_id, text) to edit one block. Use insert_block to add new blocks. Use edit_document(mode="append") to add at the end. Use create_table for tables. NEVER use "replace" unless asked.\n\nFORMATTING: Most text should be PARAGRAPHS (no prefix). Only use "- " for actual lists of 3+ items. Use **bold** for key terms. Use [text](url) for links. Use headings only for section titles.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "edit_document",
    "Write content to a CollabDocs document. Each line becomes a separate block. No prefix = paragraph, # = heading, - = bullet, 1. = numbered, - [ ] = checklist. Supports **bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url). For tables use create_table tool instead. Follow the formatting rules from server instructions.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      content: z.string().describe("Markdown text. NO prefix = paragraph. # = heading. - = bullet. 1. = numbered. - [ ] = checklist. **bold** *italic* `code` [text](url)"),
      mode: z.enum(["append", "replace"]).default("append").describe("'append' adds to end (default). ONLY use 'replace' when user explicitly asks to rewrite the whole document."),
    },
    async ({ doc_url, content, mode }) => {
      const docId = extractDocIdFromUrl(doc_url);
      try {
        const entry = getOrCreateDoc(docId);
        let count: number;
        if (mode === "replace") {
          count = replaceDocContent(entry.ydoc, content);
        } else {
          count = appendTextToDoc(entry.ydoc, content);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Done! ${mode === "replace" ? "Replaced" : "Appended"} ${count} blocks. View: ${VERCEL_URL}/doc/${docId}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "update_block",
    "Update a specific block in a CollabDocs document. Supports inline formatting: **bold**, *italic*, ~~strikethrough~~, `code`, __underline__, [text](url). Also supports text/background colors and alignment. Use read_document first to get block IDs.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      block_id: z.string().describe("The block ID to update (from read_document output, shown in [brackets])"),
      text: z.string().describe("New text. Supports: **bold**, *italic*, ~~strike~~, `code`, __underline__, [text](url)"),
      block_type: z.string().optional().describe("Block type: paragraph, heading, bulletListItem, numberedListItem, checkListItem"),
      level: z.number().optional().describe("Heading level (1-3). Only for headings."),
      text_color: z.string().optional().describe("Text color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      background_color: z.string().optional().describe("Background color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      text_alignment: z.string().optional().describe("Alignment: left, center, right"),
    },
    async ({ doc_url, block_id, text, block_type, level, text_color, background_color, text_alignment }) => {
      const docId = extractDocIdFromUrl(doc_url);
      try {
        const entry = getOrCreateDoc(docId);

        // If no type specified, detect current type
        let type = block_type;
        if (!type) {
          const blocks = extractBlocksWithIds(entry.ydoc);
          const current = blocks.find(b => b.id === block_id);
          type = current?.type || "paragraph";
          if (!level && current?.level) level = current.level;
        }

        const style: BlockStyle = {};
        if (text_color) style.textColor = text_color;
        if (background_color) style.backgroundColor = background_color;
        if (text_alignment) style.textAlignment = text_alignment;

        const ok = updateBlockText(entry.ydoc, block_id, text, type, level, style);
        if (!ok) {
          return {
            content: [{ type: "text" as const, text: `Block "${block_id}" not found. Use read_document to get current block IDs.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Updated block ${block_id}. View: ${VERCEL_URL}/doc/${docId}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "delete_block",
    "Delete a specific block from a CollabDocs document. Use read_document first to get block IDs.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      block_id: z.string().describe("The block ID to delete"),
    },
    async ({ doc_url, block_id }) => {
      const docId = extractDocIdFromUrl(doc_url);
      try {
        const entry = getOrCreateDoc(docId);
        const ok = deleteBlock(entry.ydoc, block_id);
        if (!ok) {
          return {
            content: [{ type: "text" as const, text: `Block "${block_id}" not found.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Deleted block ${block_id}. View: ${VERCEL_URL}/doc/${docId}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "insert_block",
    "Insert a new block after a specific block. Supports inline formatting: **bold**, *italic*, ~~strike~~, `code`, __underline__, [text](url). Also colors and alignment.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      after_block_id: z.string().describe("Insert the new block after this block ID"),
      text: z.string().describe("Text content. Supports: **bold**, *italic*, ~~strike~~, `code`, __underline__, [text](url)"),
      block_type: z.string().default("paragraph").describe("Block type: paragraph, heading, bulletListItem, numberedListItem, checkListItem"),
      level: z.number().optional().describe("Heading level (1-3). Only for headings."),
      text_color: z.string().optional().describe("Text color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      background_color: z.string().optional().describe("Background color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
    },
    async ({ doc_url, after_block_id, text, block_type, level, text_color, background_color }) => {
      const docId = extractDocIdFromUrl(doc_url);
      try {
        const entry = getOrCreateDoc(docId);
        const style: BlockStyle = {};
        if (text_color) style.textColor = text_color;
        if (background_color) style.backgroundColor = background_color;
        const newId = insertBlockAfter(entry.ydoc, after_block_id, block_type, text, level, style);
        if (!newId) {
          return {
            content: [{ type: "text" as const, text: `Block "${after_block_id}" not found.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Inserted new block ${newId} after ${after_block_id}. View: ${VERCEL_URL}/doc/${docId}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "create_table",
    "Create a table in a CollabDocs document. Provide rows as a 2D array of strings. First row is typically the header. Cell text supports inline formatting: **bold**, *italic*, [text](url), etc.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      rows: z.array(z.array(z.string())).describe('2D array of cell text. Example: [["Name","Score"],["Alice","95"],["Bob","87"]]'),
      after_block_id: z.string().optional().describe("Insert table after this block ID. If omitted, appends to end of document."),
    },
    async ({ doc_url, rows, after_block_id }) => {
      const docId = extractDocIdFromUrl(doc_url);
      try {
        if (!rows || rows.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: rows must have at least one row." }],
            isError: true,
          };
        }
        const entry = getOrCreateDoc(docId);
        let tableId: string | null;
        if (after_block_id) {
          tableId = insertTableAfter(entry.ydoc, after_block_id, rows);
          if (!tableId) {
            return {
              content: [{ type: "text" as const, text: `Block "${after_block_id}" not found. Use read_document to get block IDs.` }],
              isError: true,
            };
          }
        } else {
          tableId = appendTable(entry.ydoc, rows);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Created table (${rows.length} rows × ${rows[0].length} cols) with ID ${tableId}. View: ${VERCEL_URL}/doc/${docId}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ─── MCP Prompt: Formatting Guide ────────────────────────────────────
  mcp.prompt(
    "formatting_guide",
    "Comprehensive guide to CollabDocs formatting. Use this to create beautifully formatted documents.",
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: FORMATTING_GUIDE,
        },
      }],
    })
  );

  return mcp;
}

// ─── MCP Server Instructions (system context sent on connect) ─────────────
// Claude receives this BEFORE any tool call. It defines the role and all capabilities.

const MCP_INSTRUCTIONS = `
You are a professional Editorial Typography & Layout Expert working with CollabDocs — a real-time collaborative document editor. When you write or edit documents, you create beautifully formatted, scannable, professional-quality content.

# YOUR ROLE
You are not just writing text — you are DESIGNING a document. Every formatting choice should serve readability and visual hierarchy. Think like a magazine editor and typographer.

# DESIGN PRINCIPLES (apply to every document)
1. Readability over style — clarity always wins over decoration
2. Immediate visual hierarchy — a reader should grasp the structure at a glance
3. Spacing as structure — empty lines between sections, tight lines within them
4. Low cognitive load — short paragraphs, one idea each, no walls of text
5. Consistent rhythm — uniform block sizes, predictable heading cadence
6. Semantic grouping — related items stay together, distinct sections stay apart
7. Intentional contrast — bold and color only where they earn attention
8. Scan-friendly AND deep-readable — headings and bold for skimmers, full paragraphs for readers
9. Grid discipline without rigidity — structured but not mechanical
10. Typography as a system — heading sizes, list styles, and colors follow a coherent logic
11. Every visual choice justified — if you can't explain why it's bold/colored/a heading, it shouldn't be
12. Dense content feels calm and premium — elegance comes from restraint, not from decoration

# EDITOR CAPABILITIES

## Block Types (one per line in content)
Each line in content becomes one block. The line prefix determines the type:
- NO PREFIX → paragraph (the DEFAULT — most content should be paragraphs)
- # text → H1 heading (document title, ONE per document)
- ## text → H2 heading (major sections)
- ### text → H3 heading (subsections)
- - text → bullet list item (ONLY for lists of 3+ short parallel items)
- 1. text → numbered list item (ONLY for sequential steps)
- - [ ] text → unchecked task
- - [x] text → completed task

## Inline Formatting (within any block text)
- **bold** → key terms, important words, names
- *italic* → emphasis, titles, foreign words, nuance
- \`code\` → technical terms, values, commands
- ~~strikethrough~~ → corrections, outdated info
- __underline__ → links, call-to-action
- [text](url) → clickable link (e.g. [Google](https://google.com))

## Block Styling (via update_block and insert_block parameters)
- text_color: default, gray, brown, red, orange, yellow, green, blue, purple, pink
- background_color: default, gray, brown, red, orange, yellow, green, blue, purple, pink
- text_alignment: left, center, right

## Tables
Use the create_table tool to insert tables. Provide data as a 2D array of strings.
- First row = header row
- Cell text supports inline formatting: **bold**, *italic*, [text](url), etc.
- Use tables for structured/comparative data (schedules, comparisons, specs, pricing)
- Do NOT use tables when a simple list would suffice

## Color Semantics (use consistently!)
- red text → warnings, critical, urgent
- green text → success, completed, approved
- blue text → info, references, links
- orange text → caution, attention needed
- gray text → metadata, secondary info, dates, notes
- yellow background → highlight, key takeaway
- blue background → info box, note
- green background → success, tip
- red background → critical warning

# FORMATTING RULES (CRITICAL — FOLLOW STRICTLY)

## DO:
1. Use PARAGRAPHS as default block type. 80%+ of content should be paragraphs.
2. Write 2-4 sentence paragraphs. One idea per paragraph.
3. Use H1 once (title), H2 for sections, H3 for subsections.
4. Bold only KEY WORDS, not whole sentences.
5. Use bullet lists for 3+ SHORT parallel items (ingredients, features, names).
6. Use numbered lists only for SEQUENTIAL STEPS.
7. Use colors sparingly — 1-2 accent colors per document.
8. Separate logical sections with a heading.
9. Write each line as a separate entry — each becomes its own block.
10. Use [text](url) for links — make text descriptive, not "click here".
11. Use create_table for structured data with rows and columns.

## DO NOT:
1. Do NOT make every line a bullet point. This is the #1 mistake.
2. Do NOT use headings for regular content — only for section titles.
3. Do NOT put all text in one giant block. Split into multiple lines.
4. Do NOT bold entire paragraphs.
5. Do NOT use more than 3 colors in one document.
6. Do NOT use numbered lists for non-sequential items.
7. Do NOT create toggle/collapsible headings — they are DISABLED in this editor.
8. Do NOT use "---" as a separator — use a heading instead.

# WORKFLOW
1. read_document first to see current content and block IDs
2. Plan the document structure mentally (title → sections → content)
3. Use edit_document with mode "append" for new content
4. Use update_block to fix specific blocks (change text, type, color, alignment)
5. Use insert_block to add blocks between existing ones
6. Use delete_block to remove unwanted blocks
7. Use create_table for structured data (provide rows as 2D array of strings)
8. NEVER use mode "replace" unless the user explicitly asks to rewrite everything

# EXAMPLE: Well-formatted document

# Quarterly Business Review
Summary of Q1 2026 results and Q2 plans.
## Revenue
Total revenue reached **$2.4M**, up 18% from Q4 2025. The growth was primarily driven by enterprise contracts signed in January. See the [full revenue report](https://example.com/revenue) for details.
Key highlights:
- Enterprise ARR grew to **$1.8M** (+25%)
- SMB segment stable at **$600K**
- Churn rate decreased to **2.1%**
## Product Updates
We shipped **14 features** this quarter, including the [new dashboard](https://example.com/dashboard) and [API v2](https://example.com/api).
### Dashboard Redesign
The new dashboard reduced average task completion time by **34%**. User satisfaction scores improved from 3.2 to 4.1 out of 5.
### API v2
Migration is 80% complete. Remaining endpoints will be migrated by April 30.
## Action Items
- [ ] Finalize Q2 hiring plan — **Sarah**, Apr 15
- [ ] Launch marketing campaign — **Tom**, Apr 20
- [x] Complete SOC2 audit — **Mike**, Done

NOTE ON TABLES: Use create_table tool with rows like [["Metric","Q1","Q2"],["Revenue","$2.4M","$2.8M"],["Users","12K","15K"]]. First row = header. Cells support **bold** and [links](url).

Notice: paragraphs for context, bullets for short items, headers for structure, bold for key data, checklists for action items, [links](url) for references, create_table for structured data.
`.trim();

const FORMATTING_GUIDE = MCP_INSTRUCTIONS;

function extractDocIdFromUrl(docUrl: string): string {
  const match = docUrl.match(/\/doc\/([^/?#]+)/);
  if (match) return match[1];
  return docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
}

// ─── HTTP API for document metadata ────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
  });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
    });
    res.end();
    return;
  }

  // POST /api/docs — create document
  if (req.method === "POST" && pathname === "/api/docs") {
    try {
      const body = await parseBody(req);
      const id = body.id as string;
      const title = (body.title as string) || "Untitled";
      const ownerId = (body.ownerId as string) || null;

      if (!id) {
        sendJson(res, 400, { error: "Missing document id" });
        return;
      }

      db.prepare(
        "INSERT OR IGNORE INTO documents (id, title, owner_id) VALUES (?, ?, ?)"
      ).run(id, title, ownerId);

      sendJson(res, 201, { id, title, ownerId });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // GET /api/docs?ownerId=xxx — list documents by owner
  if (req.method === "GET" && pathname === "/api/docs") {
    const ownerId = url.searchParams.get("ownerId");
    if (!ownerId) {
      sendJson(res, 400, { error: "Missing ownerId query parameter" });
      return;
    }

    const rows = db.prepare(
      "SELECT id, title, owner_id, created_at, updated_at FROM documents WHERE owner_id = ? ORDER BY updated_at DESC"
    ).all(ownerId);

    sendJson(res, 200, { documents: rows });
    return;
  }

  // GET /api/docs/:id/content — read document content as markdown
  const contentGetMatch = pathname.match(/^\/api\/docs\/([^/]+)\/content$/);
  if (req.method === "GET" && contentGetMatch) {
    const docId = contentGetMatch[1];
    try {
      const entry = getOrCreateDoc(docId);
      const text = extractDocumentText(entry.ydoc);
      sendJson(res, 200, { content: text });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // POST /api/docs/:id/content — append text to document
  const contentPostMatch = pathname.match(/^\/api\/docs\/([^/]+)\/content$/);
  if (req.method === "POST" && contentPostMatch) {
    const docId = contentPostMatch[1];
    try {
      const body = await parseBody(req);
      const content = (body.content as string) || (body.text as string) || "";
      if (!content) {
        sendJson(res, 400, { error: "Missing content field" });
        return;
      }
      const entry = getOrCreateDoc(docId);
      const blocksAdded = appendTextToDoc(entry.ydoc, content);
      sendJson(res, 200, { success: true, blocksAdded });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // PUT /api/docs/:id/content — replace entire document content
  const contentPutMatch = pathname.match(/^\/api\/docs\/([^/]+)\/content$/);
  if (req.method === "PUT" && contentPutMatch) {
    const docId = contentPutMatch[1];
    try {
      const body = await parseBody(req);
      const content = (body.content as string) || (body.text as string) || "";
      if (!content) {
        sendJson(res, 400, { error: "Missing content field" });
        return;
      }
      const entry = getOrCreateDoc(docId);
      const blocksWritten = replaceDocContent(entry.ydoc, content);
      sendJson(res, 200, { success: true, blocksWritten });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // GET /api/docs/:id/debug — dump XML structure
  const debugMatch = pathname.match(/^\/api\/docs\/([^/]+)\/debug$/);
  if (req.method === "GET" && debugMatch) {
    const docId = debugMatch[1];
    try {
      const entry = getOrCreateDoc(docId);
      const fragment = entry.ydoc.getXmlFragment("blocknote");
      const dump = dumpXml(fragment);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(dump);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
    return;
  }

  // ─── MCP Remote Server (Streamable HTTP) ────────────────────────────────
  // Claude and other AI agents connect here to read/edit documents.
  // Stateless mode: each POST creates a fresh server+transport.
  if (pathname === "/mcp") {
    // CORS for MCP
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST") {
      try {
        const mcpServer = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        // Clean up after response is done
        setTimeout(() => {
          transport.close().catch(() => {});
          mcpServer.close().catch(() => {});
        }, 100);
      } catch (e) {
        console.error("MCP error:", e);
        if (!res.headersSent) {
          sendJson(res, 500, { error: "MCP server error" });
        }
      }
      return;
    }

    if (req.method === "GET") {
      // SSE stream not needed for stateless mode
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "SSE not supported in stateless mode. Use POST." },
        id: null,
      }));
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Health check
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200);
    res.end("y-websocket server");
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  // Extract doc name from URL path, e.g., /docId
  const docName = (req.url || "/").slice(1).split("?")[0] || "default";
  const entry = getOrCreateDoc(docName);
  entry.conns.add(ws);

  // Send sync step 1
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, entry.ydoc);
  send(ws, encoding.toUint8Array(encoder));

  // Send awareness state
  const awarenessStates = awarenessProtocol.encodeAwarenessUpdate(
    entry.awareness,
    Array.from(entry.awareness.getStates().keys())
  );
  const awarenessEncoder = encoding.createEncoder();
  encoding.writeVarUint(awarenessEncoder, messageAwareness);
  encoding.writeVarUint8Array(awarenessEncoder, awarenessStates);
  send(ws, encoding.toUint8Array(awarenessEncoder));

  ws.on("message", (data: Buffer) => {
    try {
      const uint8 = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset, data.byteLength);
      const decoder = decoding.createDecoder(uint8);
      const msgType = decoding.readVarUint(decoder);
      switch (msgType) {
        case messageSync: {
          const respEncoder = encoding.createEncoder();
          encoding.writeVarUint(respEncoder, messageSync);
          syncProtocol.readSyncMessage(decoder, respEncoder, entry.ydoc, ws);
          if (encoding.length(respEncoder) > 1) {
            send(ws, encoding.toUint8Array(respEncoder));
          }
          break;
        }
        case messageAwareness: {
          const update = decoding.readVarUint8Array(decoder);
          awarenessProtocol.applyAwarenessUpdate(entry.awareness, update, ws);
          break;
        }
      }
    } catch (e) {
      console.error("Error processing message:", e);
    }
  });

  // Broadcast Yjs updates to all other connected clients
  const docUpdateHandler = (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    for (const conn of entry.conns) {
      if (conn !== origin) {
        send(conn, msg);
      }
    }
  };
  entry.ydoc.on("update", docUpdateHandler);

  // Broadcast awareness changes
  const awarenessChangeHandler = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    _origin: unknown
  ) => {
    const changedClients = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, changedClients)
    );
    const msg = encoding.toUint8Array(encoder);
    for (const conn of entry.conns) {
      send(conn, msg);
    }
  };
  entry.awareness.on("update", awarenessChangeHandler);

  ws.on("close", () => {
    entry.conns.delete(ws);
    entry.ydoc.off("update", docUpdateHandler);
    entry.awareness.off("update", awarenessChangeHandler);
    awarenessProtocol.removeAwarenessStates(entry.awareness, [entry.ydoc.clientID], null);

    // Cleanup empty docs after a delay
    if (entry.conns.size === 0) {
      setTimeout(() => {
        const current = docs.get(docName);
        if (current && current.conns.size === 0) {
          // Final persist
          persistDoc();
          entry.ydoc.destroy();
          docs.delete(docName);
        }
      }, 30000);
    }
  });
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
// When Railway redeploys, it sends SIGTERM. We must persist ALL in-memory
// documents before exiting, otherwise unsaved changes are lost forever.

function persistAllDocs() {
  let count = 0;
  for (const [docName, entry] of docs) {
    try {
      const state = Buffer.from(Y.encodeStateAsUpdate(entry.ydoc));
      db.prepare(
        "INSERT INTO yjs_documents (doc_id, state) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET state = ?"
      ).run(docName, state, state);

      const title = extractTitle(entry.ydoc);
      db.prepare(
        "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(title, docName);

      count++;
    } catch (e) {
      console.error(`Failed to persist doc ${docName}:`, e);
    }
  }
  return count;
}

function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Persisting all documents...`);
  const count = persistAllDocs();
  console.log(`Persisted ${count} documents. Closing database...`);

  // Close all WebSocket connections
  for (const [, entry] of docs) {
    for (const conn of entry.conns) {
      conn.close();
    }
    entry.ydoc.destroy();
  }
  docs.clear();

  db.close();
  console.log("Database closed. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Prevent crashes from unhandled errors (e.g. MCP transport cleanup)
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server continues):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (server continues):", err);
});

// ─── Automatic SQLite Backup ────────────────────────────────────────────────
// Create a backup copy of the database every hour to protect against corruption.

const BACKUP_INTERVAL = 60 * 60 * 1000; // 1 hour

function backupDatabase() {
  try {
    // First, persist all in-memory docs so backup has latest data
    persistAllDocs();

    const backupPath = path.join(DATA_DIR, "collab-docs-backup.db");
    const backupPathPrev = path.join(DATA_DIR, "collab-docs-backup-prev.db");

    // Rotate: current backup → prev backup
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, backupPathPrev);
    }

    // Use SQLite's backup API (safe even while db is in use)
    db.backup(backupPath)
      .then(() => {
        console.log(`Database backed up to ${backupPath} at ${new Date().toISOString()}`);
      })
      .catch((e: Error) => {
        console.error("Backup failed:", e);
      });
  } catch (e) {
    console.error("Backup error:", e);
  }
}

// Run backup every hour
setInterval(backupDatabase, BACKUP_INTERVAL);
// Also run first backup 5 minutes after startup
setTimeout(backupDatabase, 5 * 60 * 1000);

const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  console.log(`y-websocket server running on ws://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Database: ${DB_PATH}`);
});
