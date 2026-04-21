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
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  extractBlocks,
  extractDocumentMarkdown as sharedExtractDocumentMarkdown,
  extractTitle as sharedExtractTitle,
} from "../lib/yjs-blocks";

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
  CREATE INDEX IF NOT EXISTS idx_documents_owner_updated
    ON documents (owner_id, updated_at DESC);
  -- Analytics event log: MCP tool calls, REST bridge writes, etc.
  -- Deliberately append-only + indexed on (kind, ts) to keep admin aggregates fast.
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    doc_id TEXT,
    owner_id TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events (kind, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_doc_ts ON events (doc_id, ts DESC);
  -- Share tokens: each (doc_id, role) pair has at most one token.
  -- Roles: 'viewer' (read-only), 'commenter' (read + comments map only), 'editor' (full).
  -- Tokens are long-lived; revoking is a DELETE.
  CREATE TABLE IF NOT EXISTS share_tokens (
    token TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_share_tokens_doc ON share_tokens (doc_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_share_tokens_doc_role
    ON share_tokens (doc_id, role);
`);

// ─── Event logging ───────────────────────────────────────────────────
//
// Best-effort: an analytics insert must never take down an MCP call.
// Owner attribution is done at write time so admin queries are cheap
// (no JOIN on the hot path of daily aggregation).
const insertEventStmt = db.prepare(
  "INSERT INTO events (kind, doc_id, owner_id, meta) VALUES (?, ?, ?, ?)"
);
const getDocOwnerStmt = db.prepare(
  "SELECT owner_id FROM documents WHERE id = ?"
);

// ─── Share tokens ────────────────────────────────────────────────────
//
// A token is an opaque random string in the URL that grants a role
// (viewer/commenter/editor) on one specific doc. Enforcement happens on
// WS connect (see `wss.on("connection", ...)` below). We keep one token
// per (doc, role) pair — mint is idempotent.
const insertShareTokenStmt = db.prepare(
  "INSERT INTO share_tokens (token, doc_id, role) VALUES (?, ?, ?)"
);
const getShareTokenStmt = db.prepare(
  "SELECT token, doc_id, role, created_at FROM share_tokens WHERE token = ?"
);
const getShareTokenByDocRoleStmt = db.prepare(
  "SELECT token, doc_id, role, created_at FROM share_tokens WHERE doc_id = ? AND role = ?"
);
const listShareTokensForDocStmt = db.prepare(
  "SELECT token, role, created_at FROM share_tokens WHERE doc_id = ? ORDER BY role"
);
const deleteShareTokenStmt = db.prepare(
  "DELETE FROM share_tokens WHERE token = ?"
);

type ShareRole = "viewer" | "commenter" | "editor";
const VALID_SHARE_ROLES: readonly ShareRole[] = ["viewer", "commenter", "editor"] as const;
function isValidShareRole(x: unknown): x is ShareRole {
  return typeof x === "string" && (VALID_SHARE_ROLES as readonly string[]).includes(x);
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return email; // not an email, leave as-is
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.slice(0, 1) + "***";
  return `${shown}@${domain}`;
}

function logEvent(
  kind: string,
  docId: string | null,
  meta?: Record<string, unknown>
): void {
  try {
    let ownerId: string | null = null;
    if (docId) {
      const row = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
      ownerId = row?.owner_id ?? null;
    }
    insertEventStmt.run(kind, docId, ownerId, meta ? JSON.stringify(meta) : null);
  } catch (e) {
    console.error("[events] logEvent failed", kind, e);
  }
}

// ─── Admin analytics aggregator ──────────────────────────────────────
//
// All queries are UTC-normalized on the SQL side via strftime() so the
// Next.js layer can render them as-is without re-bucketing.
//
// Definitions:
//   - "user"           = distinct non-null documents.owner_id
//   - "active user"    = user whose doc's updated_at falls in the window
//                        (we don't have login events, and this is a tight
//                         proxy in a collab editor — you only update_at when
//                         someone actually types)
//   - "new user"       = owner_id whose first-ever doc was created in the bucket
//   - "AI user"        = user whose doc appears in events where kind LIKE 'mcp.%'

interface DailyBucket {
  date: string;          // YYYY-MM-DD
  newDocs: number;
  activeDocs: number;
  newUsers: number;
  activeUsers: number;
  aiCalls: number;
}

interface AdminStats {
  generatedAt: string;
  windowDays: number;
  totals: {
    users: number;
    docs: number;
    activeUsers7d: number;
    activeUsers30d: number;
    docsWithAi: number;
    usersWithAi: number;
    aiCallsAllTime: number;
  };
  daily: DailyBucket[];
  toolBreakdown: Array<{ kind: string; count: number }>;
  topDocs: Array<{ doc_id: string; owner_id: string | null; title: string | null; ai_calls: number; last_edited: string | null }>;
  cohorts: {
    // weeks: ISO week labels (newest last)
    weeks: string[];
    // rows[i] = cohort registered in weeks[i]; rows[i][j] = count of users
    // from that cohort who were active in weeks[j] (j >= i)
    rows: Array<{ cohort: string; size: number; retained: number[] }>;
  };
  activationFunnel: {
    usersSignedUp: number;   // distinct owner_id (proxy: created ≥1 doc)
    usersWithEdits: number;  // owner_id whose doc updated_at != created_at
    usersWithAi: number;
  };
}

function computeAdminStats(days: number): AdminStats {
  // ── Totals ───────────────────────────────────────────────────────────
  const usersRow = db.prepare(
    "SELECT COUNT(DISTINCT owner_id) AS n FROM documents WHERE owner_id IS NOT NULL"
  ).get() as { n: number };
  const docsRow = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
  const active7Row = db.prepare(
    `SELECT COUNT(DISTINCT owner_id) AS n FROM documents
     WHERE owner_id IS NOT NULL AND updated_at >= datetime('now', '-7 days')`
  ).get() as { n: number };
  const active30Row = db.prepare(
    `SELECT COUNT(DISTINCT owner_id) AS n FROM documents
     WHERE owner_id IS NOT NULL AND updated_at >= datetime('now', '-30 days')`
  ).get() as { n: number };
  const docsWithAiRow = db.prepare(
    "SELECT COUNT(DISTINCT doc_id) AS n FROM events WHERE kind LIKE 'mcp.%' AND doc_id IS NOT NULL"
  ).get() as { n: number };
  const usersWithAiRow = db.prepare(
    "SELECT COUNT(DISTINCT owner_id) AS n FROM events WHERE kind LIKE 'mcp.%' AND owner_id IS NOT NULL"
  ).get() as { n: number };
  const aiCallsAllTimeRow = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE kind LIKE 'mcp.%'"
  ).get() as { n: number };

  // ── Daily buckets for last `days` days ───────────────────────────────
  //
  // Build an empty date scaffold in JS (so days with zero activity still
  // show up), then fold three SQL queries into it: new docs, doc updates,
  // and AI calls. New-users-per-day is trickier: a user "arrives" the day
  // their first doc is created, so we compute per-owner first_created
  // once and count how many land on each date.

  const today = new Date();
  const daily: DailyBucket[] = [];
  const byDate = new Map<string, DailyBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const bucket: DailyBucket = {
      date: key, newDocs: 0, activeDocs: 0,
      newUsers: 0, activeUsers: 0, aiCalls: 0,
    };
    daily.push(bucket);
    byDate.set(key, bucket);
  }

  const newDocsRows = db.prepare(
    `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n
       FROM documents
      WHERE created_at >= datetime('now', ?)
      GROUP BY d`
  ).all(`-${days} days`) as Array<{ d: string; n: number }>;
  for (const r of newDocsRows) {
    const b = byDate.get(r.d); if (b) b.newDocs = r.n;
  }

  const activeDocsRows = db.prepare(
    `SELECT substr(updated_at, 1, 10) AS d, COUNT(*) AS n
       FROM documents
      WHERE updated_at >= datetime('now', ?)
      GROUP BY d`
  ).all(`-${days} days`) as Array<{ d: string; n: number }>;
  for (const r of activeDocsRows) {
    const b = byDate.get(r.d); if (b) b.activeDocs = r.n;
  }

  const activeUsersRows = db.prepare(
    `SELECT substr(updated_at, 1, 10) AS d, COUNT(DISTINCT owner_id) AS n
       FROM documents
      WHERE owner_id IS NOT NULL
        AND updated_at >= datetime('now', ?)
      GROUP BY d`
  ).all(`-${days} days`) as Array<{ d: string; n: number }>;
  for (const r of activeUsersRows) {
    const b = byDate.get(r.d); if (b) b.activeUsers = r.n;
  }

  // New users: owner's first doc created on that day
  const newUsersRows = db.prepare(
    `SELECT substr(first_created, 1, 10) AS d, COUNT(*) AS n FROM (
       SELECT owner_id, MIN(created_at) AS first_created
         FROM documents
        WHERE owner_id IS NOT NULL
        GROUP BY owner_id
     )
     WHERE first_created >= datetime('now', ?)
     GROUP BY d`
  ).all(`-${days} days`) as Array<{ d: string; n: number }>;
  for (const r of newUsersRows) {
    const b = byDate.get(r.d); if (b) b.newUsers = r.n;
  }

  const aiCallsRows = db.prepare(
    `SELECT substr(ts, 1, 10) AS d, COUNT(*) AS n
       FROM events
      WHERE kind LIKE 'mcp.%'
        AND ts >= datetime('now', ?)
      GROUP BY d`
  ).all(`-${days} days`) as Array<{ d: string; n: number }>;
  for (const r of aiCallsRows) {
    const b = byDate.get(r.d); if (b) b.aiCalls = r.n;
  }

  // ── Tool breakdown (last window) ─────────────────────────────────────
  const toolBreakdown = db.prepare(
    `SELECT kind, COUNT(*) AS count
       FROM events
      WHERE kind LIKE 'mcp.%'
        AND ts >= datetime('now', ?)
      GROUP BY kind
      ORDER BY count DESC`
  ).all(`-${days} days`) as Array<{ kind: string; count: number }>;

  // ── Top docs by AI activity (last window) ────────────────────────────
  const topDocsRaw = db.prepare(
    `SELECT e.doc_id, d.owner_id, d.title, d.updated_at AS last_edited,
            COUNT(*) AS ai_calls
       FROM events e
       LEFT JOIN documents d ON d.id = e.doc_id
      WHERE e.kind LIKE 'mcp.%'
        AND e.ts >= datetime('now', ?)
        AND e.doc_id IS NOT NULL
      GROUP BY e.doc_id
      ORDER BY ai_calls DESC
      LIMIT 10`
  ).all(`-${days} days`) as Array<{
    doc_id: string; owner_id: string | null; title: string | null;
    last_edited: string | null; ai_calls: number;
  }>;
  // Mask owner emails to avoid leaking PII over a public endpoint.
  // "mikhail@gmail.com" → "m***@gmail.com"; falls through for non-emails.
  const topDocs = topDocsRaw.map((d) => ({
    ...d,
    owner_id: maskEmail(d.owner_id),
  }));

  // ── Weekly cohort retention ──────────────────────────────────────────
  //
  // For each user, pair (first_week_they_registered) × (week_they_were_active).
  // strftime('%Y-%W') gives "year-weeknum", sufficient for sorting/labels.
  // Active = any doc of theirs updated in that week. Limit to last 8 weeks so
  // the matrix stays readable; older cohorts fall off the bottom.

  const N_WEEKS = 8;
  const cohortRows = db.prepare(
    `WITH user_cohorts AS (
        SELECT owner_id,
               strftime('%Y-%W', MIN(created_at)) AS cohort_week
          FROM documents
         WHERE owner_id IS NOT NULL
         GROUP BY owner_id
      ),
      user_activity AS (
        SELECT DISTINCT owner_id,
               strftime('%Y-%W', updated_at) AS active_week
          FROM documents
         WHERE owner_id IS NOT NULL
      )
      SELECT uc.cohort_week, ua.active_week, COUNT(DISTINCT uc.owner_id) AS n
        FROM user_cohorts uc
        JOIN user_activity ua USING (owner_id)
       WHERE uc.cohort_week >= strftime('%Y-%W', datetime('now', ?))
         AND ua.active_week >= uc.cohort_week
       GROUP BY uc.cohort_week, ua.active_week`
  ).all(`-${N_WEEKS * 7} days`) as Array<{
    cohort_week: string; active_week: string; n: number;
  }>;

  // Build matrix: compute which weeks to show (current week backwards)
  const weeks: string[] = [];
  {
    const seen = new Set<string>();
    for (const r of cohortRows) { seen.add(r.cohort_week); seen.add(r.active_week); }
    const sorted = [...seen].sort();
    // Trim to most recent N_WEEKS so the heatmap doesn't explode
    for (const w of sorted.slice(-N_WEEKS)) weeks.push(w);
  }
  const weekIdx = new Map<string, number>();
  weeks.forEach((w, i) => weekIdx.set(w, i));

  // Cohort sizes: count distinct owners per cohort week (overall, not restricted)
  const cohortSizeRows = db.prepare(
    `WITH user_cohorts AS (
        SELECT owner_id,
               strftime('%Y-%W', MIN(created_at)) AS cohort_week
          FROM documents
         WHERE owner_id IS NOT NULL
         GROUP BY owner_id
      )
      SELECT cohort_week, COUNT(*) AS size
        FROM user_cohorts
       GROUP BY cohort_week`
  ).all() as Array<{ cohort_week: string; size: number }>;
  const cohortSizeMap = new Map<string, number>();
  for (const r of cohortSizeRows) cohortSizeMap.set(r.cohort_week, r.size);

  const cohortRowsOut: Array<{ cohort: string; size: number; retained: number[] }> = [];
  for (const w of weeks) {
    const cohortWeekIdx = weekIdx.get(w)!;
    const retained = new Array(weeks.length - cohortWeekIdx).fill(0);
    cohortRowsOut.push({
      cohort: w,
      size: cohortSizeMap.get(w) ?? 0,
      retained,
    });
  }
  for (const r of cohortRows) {
    const cohortI = weekIdx.get(r.cohort_week);
    const activeI = weekIdx.get(r.active_week);
    if (cohortI === undefined || activeI === undefined) continue;
    if (activeI < cohortI) continue;
    const row = cohortRowsOut.find((x) => x.cohort === r.cohort_week);
    if (!row) continue;
    row.retained[activeI - cohortI] = r.n;
  }

  // ── Activation funnel ────────────────────────────────────────────────
  const usersSignedUp = usersRow.n;
  const usersWithEditsRow = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT owner_id FROM documents
        WHERE owner_id IS NOT NULL AND updated_at > created_at
        GROUP BY owner_id
     )`
  ).get() as { n: number };

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totals: {
      users: usersRow.n,
      docs: docsRow.n,
      activeUsers7d: active7Row.n,
      activeUsers30d: active30Row.n,
      docsWithAi: docsWithAiRow.n,
      usersWithAi: usersWithAiRow.n,
      aiCallsAllTime: aiCallsAllTimeRow.n,
    },
    daily,
    toolBreakdown,
    topDocs,
    cohorts: { weeks, rows: cohortRowsOut },
    activationFunnel: {
      usersSignedUp,
      usersWithEdits: usersWithEditsRow.n,
      usersWithAi: usersWithAiRow.n,
    },
  };
}

// Document IDs are user-controllable input (URL path segment). Restrict them
// to the same alphabet that the UI generates (nanoid-style) so nothing can
// collide with SQL parameters, filesystem paths, or MCP routing.
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function isValidDocId(id: string): boolean {
  return DOC_ID_PATTERN.test(id);
}
function assertValidDocId(id: string): void {
  if (!isValidDocId(id)) {
    throw new Error(`Invalid document ID: ${JSON.stringify(id)}`);
  }
}

const messageSync = 0;
const messageAwareness = 1;

// y-protocols/sync sub-types. Kept here so the viewer filter can branch on
// them without importing internals.
const messageYjsSyncStep1 = 0;
const messageYjsSyncStep2 = 1;
const messageYjsUpdate = 2;

// In-memory docs and their connections
interface DocEntry {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
  persistTimeout: ReturnType<typeof setTimeout> | null;
  persistNow: () => void;
}
const docs = new Map<string, DocEntry>();

// Document-level text extraction lives in lib/yjs-blocks.ts (shared with the
// Next.js REST bridge). Re-export locally for backwards compatibility with
// call sites in this file.
const extractTitle = sharedExtractTitle;
const extractDocumentText = sharedExtractDocumentMarkdown;

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
    blockEl.setAttribute("isToggleable", "false");
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
const extractBlocksWithIds = extractBlocks;

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

  ydoc.transact(() => {
    found.parent.insert(found.index + 1, [newBlock]);
  });

  // getAttribute() returns "" on a detached Y.XmlElement — read the ID
  // ONLY after the element has been integrated into the tree inside the
  // transaction above. Before that it's still a prelim element and the
  // id attribute isn't observable yet. (See CLAUDE.md under "Critical
  // quirks" — this was the cause of spurious not_found errors from the
  // MCP insert_block tool.)
  return newBlock.getAttribute("id") || null;
}

/** Create a table block from a 2D array of cell text.
 *  Normalizes every row to the header row's column count — shorter rows are
 *  padded with empty strings, longer rows are truncated. This is a defensive
 *  guard: MCP callers sometimes pass ragged grids (e.g. the analytics updater
 *  emitting rows with trailing empty pipes), and any ragged row silently
 *  becomes real Y.XmlElement cells that bloat the CRDT state and make the
 *  document laggy to render. The header is the schema; anything past it is
 *  a bug. */
function createTableBlock(rows: string[][]): { element: Y.XmlElement; id: string } {
  const container = new Y.XmlElement("blockContainer");
  const id = generateBlockId();
  container.setAttribute("id", id);

  const table = new Y.XmlElement("table");

  const cols = rows[0]?.length ?? 0;
  const normalized = rows.map((r) => {
    if (r.length === cols) return r;
    if (r.length > cols) return r.slice(0, cols);
    return [...r, ...Array(cols - r.length).fill("")];
  });

  for (const rowData of normalized) {
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

function getOrCreateDoc(docName: string): DocEntry {
  const existing = docs.get(docName);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);

  // Load persisted state
  const row = db.prepare("SELECT state FROM yjs_documents WHERE doc_id = ?").get(docName) as
    | { state: Buffer }
    | undefined;
  if (row?.state) {
    Y.applyUpdate(ydoc, new Uint8Array(row.state));
  }

  const persistNow = () => {
    try {
      const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
      db.prepare(
        "INSERT INTO yjs_documents (doc_id, state) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET state = ?"
      ).run(docName, state, state);

      const title = extractTitle(ydoc);
      db.prepare(
        "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(title, docName);
    } catch (e) {
      console.error(`Failed to persist doc ${docName}:`, e);
    }
  };

  const entry: DocEntry = {
    ydoc,
    awareness,
    conns: new Set(),
    persistTimeout: null,
    persistNow,
  };

  // Persist on updates (debounced). The timer lives on the entry so cleanup
  // can clear it without leaving a pending write against a destroyed ydoc.
  ydoc.on("update", () => {
    if (entry.persistTimeout) clearTimeout(entry.persistTimeout);
    entry.persistTimeout = setTimeout(() => {
      entry.persistTimeout = null;
      persistNow();
    }, 500);
  });

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

const VERCEL_URL = process.env.VERCEL_URL || "https://postpaper.co";

/** Build an MCP error result with a structured code the model can read.
 *  Output format: `[code: <code>] <human message>` + isError=true.
 *  Codes: `not_found`, `invalid_input`, `internal`. */
function mcpError(code: "not_found" | "invalid_input" | "internal", message: string) {
  return {
    content: [{ type: "text" as const, text: `[code: ${code}] ${message}` }],
    isError: true,
  };
}

function mcpErrorFromException(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  // Invalid docId validation throws a specific message we can surface cleanly.
  if (/Invalid document ID/i.test(message)) {
    return mcpError("invalid_input", message);
  }
  return mcpError("internal", message);
}

function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "PostPaper",
    version: "0.3.0",
    instructions: MCP_INSTRUCTIONS,
  });

  mcp.tool(
    "read_document",
    "Read a PostPaper document. This is a live, multi-user, block-based editor: each block has a stable ID and is an independent unit of meaning. ALWAYS call this before editing — returns blocks with IDs so you can make surgical edits via update_block / insert_block / delete_block (preferred) instead of rewriting. Core mindset: think in blocks, not pages; one idea per block; headings are navigation, not decoration; preserve collaborators' work — do not touch blocks unrelated to the task.",
    {
      doc_url: z.string().describe("Document URL (e.g. https://postpaper.co/doc/ABC123) or just the document ID"),
    },
    async ({ doc_url }) => {
      const docId = extractDocIdFromUrl(doc_url);
      logEvent("mcp.read_document", docId);
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
            text: `Document "${extractTitle(entry.ydoc)}" (ID: ${docId}), ${blocks.length} blocks:\n\n${lines.join("\n")}\n\n--- HOW TO EDIT ---\nThink in blocks, not pages. Each line above is one addressable block with a stable ID.\n- Change one block: update_block(block_id, text)\n- Add between blocks: insert_block(after_block_id, text)\n- Remove a block: delete_block(block_id)\n- Append at the end: edit_document(mode="append")\n- Tables: create_table(rows)\nNEVER use edit_document(mode="replace") unless the user explicitly asks to rewrite.\n\nPRESERVE COLLABORATORS' WORK: do not touch blocks unrelated to the task, even if you think they could be improved. One logical change per operation.\n\nFORMATTING: most blocks should be paragraphs (no prefix). Use "- " only for 3+ short parallel items; headings only for section titles; bold only on key terms. Inline: **bold**, *italic*, \`code\`, ~~strike~~, __underline__, [text](url).\n\nCOLORS: supported via text_color / background_color on update_block and insert_block. Palette: default, gray, brown, red, orange, yellow, green, blue, purple, pink. Use at most 1–2 accent colors per document, with consistent semantics (red=warning, green=success, blue=info, yellow bg=highlight).`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  mcp.tool(
    "edit_document",
    "Append (or replace) markdown content in a PostPaper document. Each line becomes one block; prefix sets type — no prefix = paragraph, # = heading, - = bullet, 1. = numbered, - [ ] = task. Inline: **bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url). For targeted edits ALWAYS prefer update_block / insert_block / delete_block — they preserve block IDs and don't disturb other collaborators. mode='replace' is a last resort; never use it unless the user explicitly asks to rewrite the whole document. For tables use create_table. For colors, write content first, then update_block with text_color/background_color.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      content: z.string().describe("Markdown text. NO prefix = paragraph. # = heading. - = bullet. 1. = numbered. - [ ] = checklist. **bold** *italic* `code` [text](url)"),
      mode: z.enum(["append", "replace"]).default("append").describe("'append' adds to end (default). ONLY use 'replace' when user explicitly asks to rewrite the whole document."),
    },
    async ({ doc_url, content, mode }) => {
      const docId = extractDocIdFromUrl(doc_url);
      logEvent("mcp.edit_document", docId, { mode, chars: content.length });
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
            text: `Done! ${mode === "replace" ? "Replaced" : "Appended"} ${count} blocks. View: ${VERCEL_URL}/doc/${docId}\nTip: To add colors, use read_document to get block IDs, then update_block with text_color/background_color.`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  mcp.tool(
    "update_block",
    "Edit ONE block by ID — the preferred tool for targeted changes. Preserves the block's identity (other editors' cursors and references stay valid) and leaves unrelated blocks untouched. Use read_document first to get IDs. For multiple changes, call update_block multiple times rather than rewriting via edit_document. Supports inline formatting (**bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url)), text/background color, alignment, type change, and heading level.",
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
      logEvent("mcp.update_block", docId, { block_id });
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
          return mcpError("not_found", `Block "${block_id}" not found. Use read_document to get current block IDs.`);
        }
        return {
          content: [{ type: "text" as const, text: `Updated block ${block_id}. View: ${VERCEL_URL}/doc/${docId}` }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  mcp.tool(
    "delete_block",
    "Delete ONE block by ID. Only delete blocks that are clearly part of the requested change — other humans and agents may be editing in parallel, so do not delete blocks you did not author unless the user explicitly asks. Use read_document first to get IDs.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      block_id: z.string().describe("The block ID to delete"),
    },
    async ({ doc_url, block_id }) => {
      const docId = extractDocIdFromUrl(doc_url);
      logEvent("mcp.delete_block", docId, { block_id });
      try {
        const entry = getOrCreateDoc(docId);
        const ok = deleteBlock(entry.ydoc, block_id);
        if (!ok) {
          return mcpError("not_found", `Block "${block_id}" not found.`);
        }
        return {
          content: [{ type: "text" as const, text: `Deleted block ${block_id}. View: ${VERCEL_URL}/doc/${docId}` }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  mcp.tool(
    "insert_block",
    "Insert ONE new block immediately after a given block ID. Prefer this over edit_document when adding content between existing blocks; use edit_document(mode='append') only to append at the end. One idea per block — the first line should carry the gist so scanners get the point. Supports inline formatting (**bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url)), text/background color, alignment, type, and heading level.",
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
      logEvent("mcp.insert_block", docId, { after_block_id, block_type });
      try {
        const entry = getOrCreateDoc(docId);
        const style: BlockStyle = {};
        if (text_color) style.textColor = text_color;
        if (background_color) style.backgroundColor = background_color;
        const newId = insertBlockAfter(entry.ydoc, after_block_id, block_type, text, level, style);
        if (!newId) {
          return mcpError("not_found", `Block "${after_block_id}" not found. Use read_document to get current block IDs.`);
        }
        return {
          content: [{ type: "text" as const, text: `Inserted new block ${newId} after ${after_block_id}. View: ${VERCEL_URL}/doc/${docId}` }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  mcp.tool(
    "create_table",
    "Insert a table. Use for genuinely tabular or comparative data (schedules, comparisons, specs, pricing). Do NOT use when a short list would suffice — tables are visually heavy. Provide rows as a 2D array; first row is the header. Cells support inline formatting (**bold**, *italic*, [text](url), etc.). Pass after_block_id to place precisely; omit to append at the end.",
    {
      doc_url: z.string().describe("Document URL or ID"),
      rows: z.array(z.array(z.string())).describe('2D array of cell text. Example: [["Name","Score"],["Alice","95"],["Bob","87"]]'),
      after_block_id: z.string().optional().describe("Insert table after this block ID. If omitted, appends to end of document."),
    },
    async ({ doc_url, rows, after_block_id }) => {
      const docId = extractDocIdFromUrl(doc_url);
      logEvent("mcp.create_table", docId, { rows: rows?.length ?? 0, cols: rows?.[0]?.length ?? 0 });
      try {
        if (!rows || rows.length === 0) {
          return mcpError("invalid_input", "rows must have at least one row.");
        }
        const entry = getOrCreateDoc(docId);
        let tableId: string | null;
        if (after_block_id) {
          tableId = insertTableAfter(entry.ydoc, after_block_id, rows);
          if (!tableId) {
            return mcpError("not_found", `Block "${after_block_id}" not found. Use read_document to get current block IDs.`);
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
        return mcpErrorFromException(e);
      }
    }
  );

  // ─── MCP Prompt: Formatting Guide ────────────────────────────────────
  mcp.prompt(
    "formatting_guide",
    "Comprehensive guide to PostPaper formatting. Use this to create beautifully formatted documents.",
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
You are editing a PostPaper document — a live, multi-user, block-based editor.
You are not writing prose into a text file. You are shaping a structured document
where every block is an independent, addressable unit of meaning. Other humans
and AI agents may be editing alongside you in real time.

# CORE PRINCIPLES — think in blocks, not pages

## Structure & rhythm
- Think in blocks, not pages. Each block is a unit of meaning, not just a container.
- Give each block a single clear function. One idea per block.
- First line of each block carries the gist — readers scan first, read second.
- Use headings as navigation, not decoration. Hierarchy comes from document
  structure, not only from visual styling.
- Vary block types to create rhythm; avoid long runs of visually identical blocks.
- Spacing between blocks is a semantic signal, not padding — never insert empty
  blocks for visual space.
- Group related blocks by order and proximity.
- Break long thoughts into manageable modular units.
- Make dense content feel calm, structured, and premium. Elegance comes from restraint.

## Use real blocks, not typographic tricks
- Headings for sections, lists for lists, tables for tabular data.
  Do not imitate structure with characters inside a paragraph.
- One H1 per document (or per major section); use H2/H3 below.
- Headings are noun phrases, not full sentences ("Deployment", not "How we deploy").
- Lists must be parallel — same grammatical form, comparable length per item.
- Bullet lists only for 3+ short parallel items; numbered lists only for sequential steps.
- Callouts, quotes, and accent blocks are for genuine asides — not for ordinary emphasis.
- Bold and color only where they earn attention. If you can't explain why a word
  is bold or colored, it shouldn't be.

## Editing discipline — a live document is not a draft
- Prefer surgical edits: update_block / insert_block / delete_block by ID.
  Avoid edit_document(mode="replace") unless the user explicitly asks to rewrite.
- One logical change per operation — easier to review, easier to revert.
- Preserve existing block IDs. Use update_block instead of delete+insert when the
  block's purpose is unchanged.
- Do not rewrite from scratch when asked to change one thing.
- Match the document's existing voice, tone, and terminology. Do not impose your own style.
- No filler ("In this section, we will discuss…") — get to the point.

## Collaboration awareness
- Humans and other agents may be editing in parallel. Minimize churn.
- Do not touch blocks unrelated to the task, even if you think they could be improved.
- Do not reorder or delete sections you did not author unless explicitly asked.
- Always call read_document before editing to see current state and real block IDs.

# CAPABILITIES

## Block types — edit_document uses one line per block; the prefix sets the type
- (no prefix)   → paragraph (default; most content is paragraphs)
- # / ## / ###  → H1 / H2 / H3
- -             → bullet list item
- 1.            → numbered list item
- - [ ] / - [x] → unchecked / checked task
For tables use the create_table tool (2D array; first row is the header).

## Inline formatting (within any block text)
**bold**   *italic*   \`code\`   ~~strike~~   __underline__   [label](url)

## Block styling (on update_block / insert_block)
- text_color, background_color: default, gray, brown, red, orange, yellow, green, blue, purple, pink
- text_alignment: left, center, right

Color semantics (stay consistent; 1–2 accent colors per document max):
- red → warning / critical       green → success / approved     blue → info / reference
- orange → caution               gray → metadata / secondary    purple → creative / special
- yellow bg → highlight          red bg → critical warning      blue bg → info box

# WORKFLOW
1. read_document — see current content and block IDs.
2. Pick the smallest set of operations that achieves the goal.
3. Prefer update_block / insert_block / delete_block for targeted edits.
4. Use edit_document(mode="append") only to add new content at the end.
5. edit_document(mode="replace") is a last resort — only when explicitly asked to rewrite.
6. Use create_table for genuinely tabular data (not as a replacement for lists).

# HARD NO
- Do not make every line a bullet. This is the #1 mistake.
- Do not use headings for regular content.
- Do not put all text in one giant block.
- Do not bold entire paragraphs.
- Do not use more than 2–3 accent colors per document.
- Do not use "---" as a separator — use a heading.
- Toggle/collapsible headings are disabled in this editor.
- Do not claim "PostPaper doesn't support colors" — it does (see above).

# EXAMPLE — well-formed document

# Quarterly Business Review
Summary of Q1 2026 results and Q2 plans.
## Revenue
Revenue reached **$2.4M**, up 18% from Q4 2025. Growth came from enterprise
contracts signed in January. See the [full revenue report](https://example.com/revenue).
- Enterprise ARR grew to **$1.8M** (+25%)
- SMB segment stable at **$600K**
- Churn rate fell to **2.1%**
## Product
We shipped **14 features**, including the [new dashboard](https://example.com/dashboard)
and [API v2](https://example.com/api).
### Dashboard redesign
The new dashboard cut average task completion time by **34%**.
### API v2
Migration is 80% complete. Remaining endpoints ship by April 30.
## Action items
- [ ] Finalize Q2 hiring plan — **Sarah**, Apr 15
- [ ] Launch marketing campaign — **Tom**, Apr 20
- [x] Complete SOC2 audit — **Mike**

Paragraphs carry context. Lists only appear where items are genuinely parallel.
Headings are short noun phrases. Bold only on the data that matters.
`.trim();

const FORMATTING_GUIDE = MCP_INSTRUCTIONS;

function extractDocIdFromUrl(docUrl: string): string {
  const match = docUrl.match(/\/doc\/([^/?#]+)/);
  const id = match ? match[1] : docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
  assertValidDocId(id);
  return id;
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

  // ─── Share tokens ──────────────────────────────────────────────────────
  //
  // Trust model (MVP): the Next.js layer authenticates the user via
  // NextAuth and confirms they own the doc before calling us. We verify
  // the doc has an owner and that the caller's claimed ownerId matches —
  // same lightweight pattern as the rest of the doc metadata API. If
  // ws-server is ever exposed beyond trusted callers, tighten this.

  // POST /api/docs/:id/share-tokens — mint (or return existing) token
  const shareTokensMatch = pathname.match(/^\/api\/docs\/([^/]+)\/share-tokens$/);
  if (req.method === "POST" && shareTokensMatch) {
    const docId = shareTokensMatch[1];
    if (!isValidDocId(docId)) {
      sendJson(res, 400, { error: "invalid doc id" });
      return;
    }
    try {
      const body = await parseBody(req);
      const role = body.role;
      const ownerId = (body.ownerId as string) || null;
      if (!isValidShareRole(role)) {
        sendJson(res, 400, { error: "invalid role", validRoles: VALID_SHARE_ROLES });
        return;
      }
      const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
      if (!ownerRow) {
        sendJson(res, 404, { error: "doc not found" });
        return;
      }
      // No ownership check for POST: anyone with the /doc/:id URL can
      // already edit the document, so gating view-link creation on
      // "must be the owner" buys nothing and confuses collaborators.
      // GET (list tokens) and DELETE (revoke) stay owner-only — those
      // are more sensitive. `ownerId` is still required (supplied by
      // the Next.js layer from an authenticated session) so random
      // unauthenticated callers can't flood the table.
      if (!ownerId) {
        sendJson(res, 400, { error: "ownerId required" });
        return;
      }
      // Idempotent: if a token already exists for this (doc, role), return it.
      const existing = getShareTokenByDocRoleStmt.get(docId, role) as
        | { token: string; doc_id: string; role: string; created_at: string }
        | undefined;
      if (existing) {
        sendJson(res, 200, { token: existing.token, docId, role, createdAt: existing.created_at, created: false });
        return;
      }
      const token = crypto.randomBytes(12).toString("base64url");
      insertShareTokenStmt.run(token, docId, role);
      sendJson(res, 201, { token, docId, role, created: true });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // GET /api/docs/:id/share-tokens?ownerId=... — list tokens for this doc
  if (req.method === "GET" && shareTokensMatch) {
    const docId = shareTokensMatch[1];
    if (!isValidDocId(docId)) {
      sendJson(res, 400, { error: "invalid doc id" });
      return;
    }
    const ownerId = url.searchParams.get("ownerId");
    const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
    if (!ownerRow) {
      sendJson(res, 404, { error: "doc not found" });
      return;
    }
    if (!ownerRow.owner_id || ownerRow.owner_id !== ownerId) {
      sendJson(res, 403, { error: "not the owner" });
      return;
    }
    const rows = listShareTokensForDocStmt.all(docId);
    sendJson(res, 200, { tokens: rows });
    return;
  }

  // DELETE /api/share-tokens/:token — revoke token (owner of the doc only)
  const shareTokenDeleteMatch = pathname.match(/^\/api\/share-tokens\/([A-Za-z0-9_-]+)$/);
  if (req.method === "DELETE" && shareTokenDeleteMatch) {
    const token = shareTokenDeleteMatch[1];
    try {
      const body = (await parseBody(req).catch(() => ({}))) as Record<string, unknown>;
      const ownerId = (body.ownerId as string) || url.searchParams.get("ownerId") || null;
      const row = getShareTokenStmt.get(token) as
        | { token: string; doc_id: string; role: string; created_at: string }
        | undefined;
      if (!row) {
        sendJson(res, 404, { error: "token not found" });
        return;
      }
      const ownerRow = getDocOwnerStmt.get(row.doc_id) as { owner_id: string | null } | undefined;
      if (!ownerRow?.owner_id || ownerRow.owner_id !== ownerId) {
        sendJson(res, 403, { error: "not the owner" });
        return;
      }
      deleteShareTokenStmt.run(token);
      sendJson(res, 200, { revoked: true });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // GET /api/share-tokens/:token — resolve token (public: callers need
  // this to route /v/:token → /doc/:id). Returns docId+role plus the
  // doc's ownerId so the Next.js layer can redirect an owner landing on
  // their own view-link into full edit mode.
  if (req.method === "GET" && shareTokenDeleteMatch) {
    const token = shareTokenDeleteMatch[1];
    const row = getShareTokenStmt.get(token) as
      | { token: string; doc_id: string; role: string; created_at: string }
      | undefined;
    if (!row) {
      sendJson(res, 404, { error: "token not found" });
      return;
    }
    const ownerRow = getDocOwnerStmt.get(row.doc_id) as
      | { owner_id: string | null }
      | undefined;
    sendJson(res, 200, {
      docId: row.doc_id,
      role: row.role,
      ownerId: ownerRow?.owner_id ?? null,
    });
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

  // ─── Analytics endpoint ─────────────────────────────────────────────────
  //
  // Public on purpose: returns aggregates only, and owner emails are masked
  // (m***@domain.com) so no PII leaks. Safe enough for an MVP hobby app;
  // revisit if we ever have competitive value in private metrics.
  //
  // Reads do some heavy-ish SQL (cohort retention) but still cheap on hobby
  // dataset; revisit if we ever run this on tens of thousands of docs.
  if (
    req.method === "GET" &&
    (pathname === "/api/admin/stats" || pathname === "/api/stats")
  ) {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
    try {
      sendJson(res, 200, computeAdminStats(days));
    } catch (e) {
      console.error("[stats] failed", e);
      sendJson(res, 500, { error: String(e) });
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

  // Internal: force an immediate persist of a document.
  // Used by the Next.js REST bridge so it doesn't have to sleep waiting for
  // the 500 ms debounce. Safe to call even if the doc isn't in memory.
  // Protected by INTERNAL_SECRET; bridge sends it in `x-internal-secret`.
  if (req.method === "POST" && pathname.startsWith("/internal/flush/")) {
    const docId = pathname.slice("/internal/flush/".length);
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        console.log(`[flush] 403 docId=${docId} reason=${got ? "bad_secret" : "missing_secret"}`);
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    }
    if (!isValidDocId(docId)) {
      console.log(`[flush] 400 docId=${JSON.stringify(docId)} reason=invalid_id`);
      sendJson(res, 400, { error: "invalid doc id" });
      return;
    }
    const entry = docs.get(docId);
    if (!entry) {
      // Not in memory — nothing to flush (it's already on disk or doesn't exist).
      console.log(`[flush] 200 docId=${docId} flushed=false reason=not_in_memory`);
      sendJson(res, 200, { flushed: false, reason: "not_in_memory" });
      return;
    }
    if (entry.persistTimeout) {
      clearTimeout(entry.persistTimeout);
      entry.persistTimeout = null;
    }
    entry.persistNow();
    console.log(`[flush] 200 docId=${docId} flushed=true`);
    sendJson(res, 200, { flushed: true });
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
  const rawUrl = req.url || "/";
  const docName = rawUrl.slice(1).split("?")[0] || "default";
  if (!isValidDocId(docName)) {
    console.warn(`Rejected WS connection with invalid docId: ${JSON.stringify(docName)}`);
    ws.close(1008, "Invalid document ID");
    return;
  }

  // ─── Share-token gating ────────────────────────────────────────────────
  //
  // When the client connects via /v/:token (viewer link) or similar, the
  // Next.js layer passes `?token=...` on the WS URL. We look it up and pin
  // the connection's role to whatever the token grants. Absence of a token
  // means "owner/editor path" — current default until PR 2 adds full ACL.
  //
  // Important: we still accept tokenless connections (the authenticated
  // owner editing their own doc goes through this branch). PR 2 will
  // tighten that.
  let role: ShareRole = "editor";
  try {
    const qs = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const token = params.get("token");
    if (token) {
      const row = getShareTokenStmt.get(token) as
        | { token: string; doc_id: string; role: string; created_at: string }
        | undefined;
      if (!row || row.doc_id !== docName || !isValidShareRole(row.role)) {
        console.warn(`[ws] rejected connection: bad token for doc=${docName}`);
        ws.close(1008, "Invalid share token");
        return;
      }
      role = row.role;
    }
  } catch (e) {
    console.error("[ws] token parse failed:", e);
    ws.close(1011, "Internal error");
    return;
  }
  // Stash on the ws so message/broadcast handlers can consult it.
  (ws as unknown as { role: ShareRole }).role = role;

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
          // Viewers are a special case: we have to answer their syncStep1
          // (otherwise they'd never get the document state) but MUST drop
          // any syncStep2 / update they push back to us, otherwise a
          // tampered client could edit a read-only doc. readSyncMessage()
          // processes all three opaquely, so we branch by sub-type.
          if (role === "viewer") {
            const subType = decoding.readVarUint(decoder);
            if (subType === messageYjsSyncStep1) {
              const sv = decoding.readVarUint8Array(decoder);
              const respEncoder = encoding.createEncoder();
              encoding.writeVarUint(respEncoder, messageSync);
              encoding.writeVarUint(respEncoder, messageYjsSyncStep2);
              encoding.writeVarUint8Array(
                respEncoder,
                Y.encodeStateAsUpdate(entry.ydoc, sv)
              );
              send(ws, encoding.toUint8Array(respEncoder));
            }
            // syncStep2 / update from a viewer are silently dropped.
            break;
          }
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

    // Cleanup empty docs after a delay.
    // Re-check from `docs` (not the captured `entry`) so a doc that was
    // reloaded during the grace period isn't destroyed.
    if (entry.conns.size === 0) {
      setTimeout(() => {
        const current = docs.get(docName);
        if (!current || current.conns.size > 0) return;
        if (current.persistTimeout) {
          clearTimeout(current.persistTimeout);
          current.persistTimeout = null;
        }
        current.persistNow();
        current.ydoc.destroy();
        docs.delete(docName);
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
