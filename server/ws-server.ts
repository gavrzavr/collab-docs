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
  return text.split("\n").map(line => {
    const trimmed = line.trimEnd();
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      return { type: "heading", text: headingMatch[2], level: headingMatch[1].length };
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

/** Create a BlockNote-compatible blockContainer XML element */
function createBlock(ydoc: Y.Doc, type: string, text: string, level?: number): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", generateBlockId());
  container.setAttribute("backgroundColor", "default");
  container.setAttribute("textColor", "default");

  const blockEl = new Y.XmlElement(type);
  if (type === "heading" && level) {
    blockEl.setAttribute("level", String(level));
  }
  blockEl.setAttribute("textAlignment", "left");

  const inlineContent = new Y.XmlElement("inline-content");
  inlineContent.insert(0, [new Y.XmlText(text)]);
  blockEl.insert(0, [inlineContent]);

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

/** Dump XML structure for debugging */
function dumpXml(element: Y.XmlElement | Y.XmlText | Y.XmlFragment, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (element instanceof Y.XmlText) return `${pad}[TEXT: "${element.toJSON()}"]\n`;
  if (element instanceof Y.XmlFragment) {
    let r = `${pad}[Fragment] (${element.length} children)\n`;
    for (let i = 0; i < element.length; i++) {
      const c = element.get(i);
      if (c instanceof Y.XmlElement || c instanceof Y.XmlText) r += dumpXml(c, indent + 1);
    }
    return r;
  }
  const attrs = element.getAttributes();
  const attrStr = Object.keys(attrs).length > 0 ? " " + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ") : "";
  let r = `${pad}<${element.nodeName}${attrStr}>\n`;
  for (let i = 0; i < element.length; i++) {
    const c = element.get(i);
    if (c instanceof Y.XmlElement || c instanceof Y.XmlText) r += dumpXml(c, indent + 1);
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
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
