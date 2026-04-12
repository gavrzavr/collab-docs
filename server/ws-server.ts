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

  function walkBlockContainer(bc: Y.XmlElement) {
    for (let i = 0; i < bc.length; i++) {
      const child = bc.get(i);
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === "blockGroup") {
          walkBlockGroup(child);
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
 *  Supports: **bold**, *italic*, ~~strikethrough~~, `code`, __underline__
 */
function createFormattedText(text: string): Y.XmlText {
  const xmlText = new Y.XmlText();
  let pos = 0;

  // Regex for inline formatting tokens
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|__(.+?)__)/g;
  let match;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    // Insert plain text before this match
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      xmlText.insert(pos, plain);
      pos += plain.length;
    }

    if (match[2]) {
      // **bold**
      xmlText.insert(pos, match[2], { bold: true });
      pos += match[2].length;
    } else if (match[3]) {
      // *italic*
      xmlText.insert(pos, match[3], { italic: true });
      pos += match[3].length;
    } else if (match[4]) {
      // ~~strikethrough~~
      xmlText.insert(pos, match[4], { strike: true });
      pos += match[4].length;
    } else if (match[5]) {
      // `code`
      xmlText.insert(pos, match[5], { code: true });
      pos += match[5].length;
    } else if (match[6]) {
      // __underline__
      xmlText.insert(pos, match[6], { underline: true });
      pos += match[6].length;
    }

    lastIndex = regex.lastIndex;
  }

  // Insert remaining plain text
  if (lastIndex < text.length) {
    xmlText.insert(pos, text.slice(lastIndex));
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
  const hasFormatting = /(\*\*.+?\*\*|\*.+?\*|~~.+?~~|`.+?`|__.+?__)/.test(text);
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
        text += child.toJSON();
      } else if (child instanceof Y.XmlElement) {
        text += getTextContent(child);
      }
    }
    return text;
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
    version: "0.2.0",
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
            text: `Document "${extractTitle(entry.ydoc)}" (ID: ${docId}), ${blocks.length} blocks:\n\n${lines.join("\n")}\n\n--- EDITING INSTRUCTIONS ---\nUse update_block(block_id, text) to edit one block. Use insert_block to add new blocks. Use edit_document(mode="append") to add at the end. NEVER use "replace" unless asked.\n\nFORMATTING: Most text should be PARAGRAPHS (no prefix). Only use "- " for actual lists of 3+ items. Use **bold** for key terms. Use headings only for section titles.`,
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
    `Write content to a CollabDocs document. IMPORTANT FORMATTING RULES:

STRUCTURE: Use proper block types for each line:
- Lines WITHOUT prefix = paragraph (body text, descriptions, notes)
- # / ## / ### = headings (document structure ONLY, not for every line)
- "- " = bullet list (ONLY for short items in a list of 3+)
- "1. " = numbered list (ONLY for sequential steps)
- "- [ ] " = checklist (ONLY for actionable tasks)

COMMON MISTAKES TO AVOID:
- Do NOT make every line a bullet point. Most text should be PARAGRAPHS (no prefix).
- Do NOT use headings for regular content. Headings are for SECTION TITLES only.
- Do NOT write one giant block. Split into multiple paragraphs with blank lines.
- Do NOT overuse lists. A paragraph of 2-3 sentences is better than 3 bullet points.

INLINE FORMATTING: **bold** for key terms, *italic* for emphasis, \`code\` for technical terms.

EXAMPLE of good formatting:
# Project Update
Status report for Q2 2026.
## Completed
We finished the API migration ahead of schedule. **Performance improved by 40%**.
- Migrated all endpoints to v2
- Updated documentation
- Deployed to production
## Next Steps
The frontend refactor starts next week. *John* will lead the effort.`,
    {
      doc_url: z.string().describe("Document URL or ID"),
      content: z.string().describe("Markdown text. NO prefix = paragraph. # = heading. - = bullet. 1. = numbered. - [ ] = checklist. **bold** *italic* `code`"),
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
    "Update a specific block in a CollabDocs document. Supports inline formatting: **bold**, *italic*, ~~strikethrough~~, `code`, __underline__. Also supports text/background colors and alignment. Use read_document first to get block IDs.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      block_id: z.string().describe("The block ID to update (from read_document output, shown in [brackets])"),
      text: z.string().describe("New text. Supports: **bold**, *italic*, ~~strike~~, `code`, __underline__"),
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
    "Insert a new block after a specific block. Supports inline formatting: **bold**, *italic*, ~~strike~~, `code`, __underline__. Also colors and alignment.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      after_block_id: z.string().describe("Insert the new block after this block ID"),
      text: z.string().describe("Text content. Supports: **bold**, *italic*, ~~strike~~, `code`, __underline__"),
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

const FORMATTING_GUIDE = `
# CollabDocs Formatting Guide

You are a typography expert working with CollabDocs — a collaborative document editor. Use ALL available formatting to create beautiful, readable, well-structured documents.

## Block Types

| Type | Syntax | Use for |
|------|--------|---------|
| paragraph | Plain text | Body text |
| heading | # H1, ## H2, ### H3 | Document structure (max 3 levels) |
| bulletListItem | - text | Unordered lists |
| numberedListItem | 1. text | Sequential steps, ranked items |
| checkListItem | [] text | Todo lists, checklists |

## Inline Formatting

Use these within any block text:
- **Bold**: **important text** — for key terms, emphasis
- *Italic*: *subtle emphasis* — for names, titles, foreign words
- ~~Strikethrough~~: ~~deleted text~~ — for corrections, removed items
- \`Code\`: \`variable_name\` — for technical terms, code
- __Underline__: __underlined text__ — for links, highlights

Combine them: **bold and *italic*** works.

## Block Styling

When using update_block or creating blocks, you can set:

### Text Colors
Available: default, gray, brown, red, orange, yellow, green, blue, purple, pink

Use colors purposefully:
- **red** — warnings, errors, urgent items
- **green** — success, completed, positive
- **blue** — links, references, information
- **orange** — caution, important notes
- **gray** — secondary info, metadata, dates
- **purple** — creative, special categories

### Background Colors
Same palette: default, gray, brown, red, orange, yellow, green, blue, purple, pink

Use backgrounds for:
- **yellow** background — highlights, key takeaways
- **blue** background — info boxes, notes
- **red** background — critical warnings
- **green** background — success messages, tips

### Text Alignment
Available: left (default), center, right

- **center** — titles, quotes, section dividers
- **right** — dates, attribution, signatures

## Typography Best Practices

1. **Hierarchy**: Use H1 for document title (one per doc), H2 for main sections, H3 for subsections
2. **Scannability**: Use bullet lists for 3+ related items, numbered for sequential steps
3. **Emphasis**: Bold for key terms (sparingly), italic for nuance. Never bold entire paragraphs.
4. **Color**: Use 1-2 accent colors per document. Too many colors = visual noise.
5. **Whitespace**: Short paragraphs (2-4 sentences). One idea per block.
6. **Structure**: Start sections with a clear heading, then context paragraph, then details.
7. **Consistency**: Same formatting for same types of info throughout the document.

## Examples of Good Formatting

### Meeting Notes
- H1: Meeting title
- Gray text: Date, attendees
- H2: each agenda topic
- Bullet list: discussion points
- **Bold**: decisions made
- Checklist: action items with owners

### Technical Documentation
- H1: Feature name
- H2: Overview, Setup, Usage, API, Troubleshooting
- \`Code\` formatting for technical terms
- Numbered lists for steps
- Yellow background for important notes
- Red text for warnings

### Project Plan
- H1: Project name
- H2: Phases
- H3: Tasks within phases
- Checklists for deliverables
- Green text for completed items
- Orange text for at-risk items
`.trim();

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
