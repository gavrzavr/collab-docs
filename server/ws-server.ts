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
import {
  verifySessionToken,
  BRIDGE_SUBJECT,
} from "../lib/session-jwt";
import {
  MCP_SERVER_VERSION,
  notesNewerThan,
} from "../lib/release-notes";

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

// ─── Migration: legacy hashed mcp_keys → plaintext mcp_keys ────────
//
// MUST run BEFORE the main schema block. The main block tries to
// create `idx_mcp_keys_key ON mcp_keys (key)` which would fail with
// SQLITE_ERROR on a DB whose mcp_keys table still has the old
// `key_hash` column. So: detect the legacy layout and drop the table
// first. Old hashed keys are unrecoverable — users regenerate once.
{
  const cols = db.prepare("PRAGMA table_info(mcp_keys)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const hasHashCol = cols.some((c) => c.name === "key_hash");
    const hasKeyCol = cols.some((c) => c.name === "key");
    if (hasHashCol && !hasKeyCol) {
      console.log("[migration] dropping legacy mcp_keys schema (hashed keys unrecoverable)");
      db.exec(`
        DROP INDEX IF EXISTS idx_mcp_keys_hash;
        DROP TABLE mcp_keys;
      `);
    }
  }
}

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
  -- Per-document collaborator list — the "ACL" for the owner + invited model.
  -- Owner is NOT stored here (lives in documents.owner_id); everyone else who
  -- has write-ish access must have a row here. Viewer access is handled via
  -- anonymous share_tokens (no identity needed) and does not go in this table.
  CREATE TABLE IF NOT EXISTS document_collaborators (
    doc_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('editor','commenter')),
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_via_token TEXT,
    PRIMARY KEY (doc_id, user_email)
  );
  CREATE INDEX IF NOT EXISTS idx_collaborators_user ON document_collaborators (user_email);
  -- Per-user MCP API keys. One row per user; rotating replaces the key.
  -- Stored in plaintext on purpose — the dashboard needs to show the key
  -- whenever the user wants to copy it into a new MCP client. Trade-off
  -- vs. hashing: a DB read leaks usable keys, but losing the key to
  -- "show once" UX makes a one-key-per-user product painful. MVP threat
  -- model, personal docs only — if we add financial / admin scopes we
  -- should reconsider.
  CREATE TABLE IF NOT EXISTS mcp_keys (
    user_email TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_keys_key ON mcp_keys (key);
`);

// ─── Migration: mcp_keys.last_seen_server_version ────────────────────
//
// Tracks which MCP version this user's MCP client was last running with.
// On every authenticated tool call we compare to MCP_SERVER_VERSION; if
// it's behind, we splice "what's new + reconnect instructions" into the
// tool response so Claude sees it and tells the user. Marker advances
// after the hint is shown so we don't spam.
{
  const cols = db.prepare("PRAGMA table_info(mcp_keys)").all() as Array<{ name: string }>;
  const hasCol = cols.some((c) => c.name === "last_seen_server_version");
  if (!hasCol) {
    db.exec(`ALTER TABLE mcp_keys ADD COLUMN last_seen_server_version TEXT`);
  }
}

// ─── Session auth (Next.js ↔ ws-server) ──────────────────────────────
//
// Next.js owns the NextAuth session cookie; ws-server runs on a separate
// host and can't read it. Instead, Next.js mints a short-lived HS256
// token carrying {sub, doc, role, exp} and hands it to DocClient, which
// passes it on the WS connect URL. We verify the HMAC here. Same secret
// also authenticates internal bridge traffic via BRIDGE_SUBJECT.
const WS_SESSION_SECRET = process.env.WS_SESSION_SECRET || "";
if (!WS_SESSION_SECRET) {
  console.error(
    "[ws-server] WS_SESSION_SECRET is not set — all non-share-token WS " +
    "connections will be rejected. Set this env var to match the value " +
    "configured in the Next.js deployment."
  );
}

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

// ─── Collaborator membership ─────────────────────────────────────────
//
// DocAccess resolves "does this email have write-ish access to this doc?".
// Owner (documents.owner_id) and collaborators (document_collaborators)
// are both checked. The ordering matters: "owner" beats "editor" beats
// "commenter", so the most privileged level is returned first.
type DocAccess = "owner" | "editor" | "commenter";
const upsertCollaboratorStmt = db.prepare(
  `INSERT INTO document_collaborators (doc_id, user_email, role, granted_via_token)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(doc_id, user_email) DO UPDATE SET
     role = excluded.role,
     granted_via_token = COALESCE(document_collaborators.granted_via_token, excluded.granted_via_token)`
);
const getCollaboratorStmt = db.prepare(
  "SELECT role FROM document_collaborators WHERE doc_id = ? AND user_email = ?"
);
const removeCollaboratorStmt = db.prepare(
  "DELETE FROM document_collaborators WHERE doc_id = ? AND user_email = ?"
);
const listCollaboratorsStmt = db.prepare(
  "SELECT user_email, role, granted_at FROM document_collaborators WHERE doc_id = ? ORDER BY granted_at"
);

/**
 * Resolve (docId, email) -> access level, or null if the caller has none.
 * Returns null for unknown docs as well — callers should 404 in that case.
 */
function getDocAccess(
  docId: string,
  email: string | null | undefined
): DocAccess | null {
  if (!email) return null;
  const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
  if (!ownerRow) return null;
  if (ownerRow.owner_id && ownerRow.owner_id === email) return "owner";
  const row = getCollaboratorStmt.get(docId, email) as { role: string } | undefined;
  if (row && (row.role === "editor" || row.role === "commenter")) {
    return row.role;
  }
  return null;
}

function isDocOwner(docId: string, email: string | null | undefined): boolean {
  if (!email) return false;
  const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
  return !!ownerRow && ownerRow.owner_id === email;
}

function addCollaborator(
  docId: string,
  email: string,
  role: "editor" | "commenter",
  viaToken: string | null
): void {
  upsertCollaboratorStmt.run(docId, email, role, viaToken);
}

// ─── MCP API keys ────────────────────────────────────────────────────
//
// One key per user. The key is random 32 bytes, base64url-encoded (~43
// chars), stored in plaintext so the dashboard can display it on demand
// (the user will need to paste it into each MCP client they connect).
// On every /mcp request we extract `?key=...`, look it up directly, and
// resolve the owning email. Missing/invalid key → no email → per-tool
// authz returns "mint one".
//
// Rotation: overwrite the row (ON CONFLICT on user_email). last_used_at
// is a best-effort timestamp for "is this key still in use?" UI.
const upsertMcpKeyStmt = db.prepare(
  `INSERT INTO mcp_keys (user_email, key, created_at, last_used_at)
   VALUES (?, ?, datetime('now'), NULL)
   ON CONFLICT(user_email) DO UPDATE SET
     key = excluded.key,
     created_at = excluded.created_at,
     last_used_at = NULL`
);
const getMcpKeyByKeyStmt = db.prepare(
  "SELECT user_email, created_at, last_used_at FROM mcp_keys WHERE key = ?"
);
const getMcpKeyByEmailStmt = db.prepare(
  "SELECT key, created_at, last_used_at FROM mcp_keys WHERE user_email = ?"
);
const deleteMcpKeyStmt = db.prepare(
  "DELETE FROM mcp_keys WHERE user_email = ?"
);
const touchMcpKeyStmt = db.prepare(
  "UPDATE mcp_keys SET last_used_at = datetime('now') WHERE key = ?"
);

// Reads/updates `last_seen_server_version` and returns a one-shot hint
// listing every release the user hasn't seen yet. Marks the user as
// caught up after returning the hint, so the next call is silent until
// MCP_SERVER_VERSION advances again. Anonymous callers (no email) get
// no hint — share-token sessions are one-shot anyway.
const getLastSeenVersionStmt = db.prepare(
  "SELECT last_seen_server_version FROM mcp_keys WHERE user_email = ?"
);
const setLastSeenVersionStmt = db.prepare(
  "UPDATE mcp_keys SET last_seen_server_version = ? WHERE user_email = ?"
);
function buildReleaseHintIfDue(email: string | null): string | null {
  if (!email) return null;
  let lastSeen = "";
  try {
    const row = getLastSeenVersionStmt.get(email) as { last_seen_server_version: string | null } | undefined;
    if (!row) return null; // no key row — anonymous-ish, skip
    lastSeen = row.last_seen_server_version || "";
  } catch {
    return null; // best-effort — never break a tool response
  }
  const fresh = notesNewerThan(lastSeen);
  // Always advance the marker so we don't query forever even when the
  // notes list is empty for this version range.
  try { setLastSeenVersionStmt.run(MCP_SERVER_VERSION, email); } catch { /* ignore */ }
  if (fresh.length === 0) return null;
  const lines: string[] = [];
  lines.push("");
  lines.push("─────");
  lines.push(`PostPaper update — what's new since you last connected:`);
  for (const { version, note } of fresh) {
    lines.push(`  • [v${version}] ${note}`);
  }
  lines.push("");
  lines.push("If new tools don't appear in your tool list, the MCP client cached the old set — reconnect to refresh:");
  lines.push("  • Claude.ai (web) / Desktop: Settings → Connectors → PostPaper → Disconnect → Connect again");
  lines.push("  • Claude Code (CLI): `claude mcp remove postpaper`, then re-add");
  return lines.join("\n");
}

// Append the hint to a tool response without disturbing its structure.
// If the response is an error or has no text payload, leave it alone —
// errors are noisy enough already.
type McpToolResult = {
  content: Array<{ type: string; text?: string } & Record<string, unknown>>;
  isError?: boolean;
};
function appendReleaseHint<T extends McpToolResult>(result: T, email: string | null): T {
  if (result.isError) return result;
  const hint = buildReleaseHintIfDue(email);
  if (!hint) return result;
  const first = result.content?.[0];
  if (first && first.type === "text" && typeof first.text === "string") {
    first.text = first.text + "\n" + hint;
  } else {
    result.content.push({ type: "text", text: hint.trimStart() });
  }
  return result;
}

function mintMcpKey(email: string): { key: string; createdAt: string } {
  // 32 random bytes, base64url (no padding) — roughly 43 chars.
  const raw = crypto.randomBytes(32);
  const key = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  upsertMcpKeyStmt.run(email, key);
  return { key, createdAt: new Date().toISOString() };
}

function lookupMcpKey(plaintext: string): string | null {
  const row = getMcpKeyByKeyStmt.get(plaintext) as
    | { user_email: string; created_at: string; last_used_at: string | null }
    | undefined;
  if (!row) return null;
  // Best-effort touch — failure must never reject the request.
  try { touchMcpKeyStmt.run(plaintext); } catch {}
  return row.user_email;
}

function getMcpKeyInfo(email: string): {
  hasKey: boolean;
  key: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
} {
  const row = getMcpKeyByEmailStmt.get(email) as
    | { key: string; created_at: string; last_used_at: string | null }
    | undefined;
  if (!row) return { hasKey: false, key: null, createdAt: null, lastUsedAt: null };
  return {
    hasKey: true,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function revokeMcpKey(email: string): boolean {
  const info = deleteMcpKeyStmt.run(email);
  return info.changes > 0;
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

/** Append markdown text to a Yjs document.
 *  `fragmentName` defaults to "blocknote" (the first page). Multi-page docs
 *  pass the target page's fragment name. */
function appendTextToDoc(ydoc: Y.Doc, markdownText: string, fragmentName: string = "blocknote"): number {
  const blocks = parseMarkdown(markdownText);
  const fragment = ydoc.getXmlFragment(fragmentName);

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

/** Replace the contents of one page with markdown. */
function replaceDocContent(ydoc: Y.Doc, markdownText: string, fragmentName: string = "blocknote"): number {
  const blocks = parseMarkdown(markdownText);
  const fragment = ydoc.getXmlFragment(fragmentName);

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

/** Update text of a specific block by ID (within one page fragment). */
function updateBlockText(ydoc: Y.Doc, blockId: string, newText: string, newType?: string, newLevel?: number, style?: BlockStyle, fragmentName: string = "blocknote"): boolean {
  const fragment = ydoc.getXmlFragment(fragmentName);
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

/** Delete a block by ID (within one page fragment). */
function deleteBlock(ydoc: Y.Doc, blockId: string, fragmentName: string = "blocknote"): boolean {
  const fragment = ydoc.getXmlFragment(fragmentName);
  const found = findBlockContainer(fragment, blockId);
  if (!found) return false;

  ydoc.transact(() => {
    found.parent.delete(found.index, 1);
  });

  return true;
}

/** Insert a block after a specific block ID (within one page fragment). */
function insertBlockAfter(ydoc: Y.Doc, afterBlockId: string, type: string, text: string, level?: number, style?: BlockStyle, fragmentName: string = "blocknote"): string | null {
  const fragment = ydoc.getXmlFragment(fragmentName);
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

  // Strip trailing empty/whitespace cells from every row before sizing.
  // Without this, callers (notably Claude with a markdown-table mental
  // model) sometimes include phantom empties on the right — e.g. from
  // splitting "| a | b | c |" on "|" and keeping the trailing artifact.
  // Those empties became real-rendered columns, leaving the user with
  // a table that has 2 ghost columns nobody can see content in. After
  // the trim, the widest remaining row dictates the column count.
  const trimmed = rows.map((r) => {
    let end = r.length;
    while (end > 0 && (r[end - 1] === undefined || r[end - 1].trim() === "")) {
      end--;
    }
    return r.slice(0, end);
  });
  const cols = Math.max(0, ...trimmed.map((r) => r.length));
  const normalized = trimmed.map((r) => {
    if (r.length === cols) return r;
    return [...r, ...Array(cols - r.length).fill("")];
  });

  // Match BlockNote's schema-default tableCell shape EXACTLY. Diagnosed
  // 2026-04-27 in DevTools: when we sent only colspan/rowspan as STRINGS
  // ("1"), BlockNote's type-mismatch normalization corrupted our last
  // cell's colspan to NUMBER 0 and recursively padded each row with
  // extra cells (header +1, data +3+). Setting all 6 schema attrs with
  // their canonical types stops the normalization fight.
  // setAttribute on Y.XmlElement preserves value type (number stays
  // number through the Yjs CRDT and arrives as number on the client).
  for (const rowData of normalized) {
    const row = new Y.XmlElement("tableRow");
    for (const cellText of rowData) {
      const cell = new Y.XmlElement("tableCell");
      // Numbers, not strings — that was the trigger.
      cell.setAttribute("colspan", 1 as unknown as string);
      cell.setAttribute("rowspan", 1 as unknown as string);
      cell.setAttribute("textColor", "default");
      cell.setAttribute("backgroundColor", "default");
      cell.setAttribute("textAlignment", "left");
      // colwidth defaults to null in schema; do NOT set — Y.XmlElement
      // can't store null as an attribute, and the schema's default-null
      // is what BlockNote-native cells produce.
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

/** Append a table to the end of one page fragment. */
function appendTable(ydoc: Y.Doc, rows: string[][], fragmentName: string = "blocknote"): string {
  const fragment = ydoc.getXmlFragment(fragmentName);
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

/** Insert a table after a specific block (within one page fragment). */
function insertTableAfter(ydoc: Y.Doc, afterBlockId: string, rows: string[][], fragmentName: string = "blocknote"): string | null {
  const fragment = ydoc.getXmlFragment(fragmentName);
  const found = findBlockContainer(fragment, afterBlockId);
  if (!found) return null;

  const { element: tableBlock, id: newId } = createTableBlock(rows);

  ydoc.transact(() => {
    found.parent.insert(found.index + 1, [tableBlock]);
  });

  return newId;
}

// ─── htmlViz block (Claude-generated interactive visualizations) ─────
//
// Stored as a blockContainer > <htmlViz> element with the raw HTML in the
// `html` attribute (so it travels through y-prosemirror's attribute path
// unchanged). The client component renders it in a sandboxed iframe.
//
// Hard 100 KB size cap enforced at the MCP tool layer — anything larger
// is almost certainly a bundled library that would be faster and safer
// to pre-render or link out to.
const HTML_VIZ_MAX_BYTES = 100_000;

function createHtmlVizBlock(
  html: string,
  createdBy: string,
): { element: Y.XmlElement; id: string } {
  const container = new Y.XmlElement("blockContainer");
  const id = generateBlockId();
  container.setAttribute("id", id);

  const viz = new Y.XmlElement("htmlViz");
  viz.setAttribute("html", html);
  viz.setAttribute("createdAt", new Date().toISOString());
  viz.setAttribute("createdBy", createdBy || "");

  container.insert(0, [viz]);
  return { element: container, id };
}

/** Append an htmlViz block to the end of one page fragment. */
function appendHtmlViz(
  ydoc: Y.Doc,
  html: string,
  createdBy: string,
  fragmentName: string = "blocknote",
): string {
  const fragment = ydoc.getXmlFragment(fragmentName);
  const { element: block, id: blockId } = createHtmlVizBlock(html, createdBy);

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
    blockGroup.insert(blockGroup.length, [block]);
  });

  return blockId;
}

/** Insert an htmlViz block after a specific block (within one page fragment). */
function insertHtmlVizAfter(
  ydoc: Y.Doc,
  afterBlockId: string,
  html: string,
  createdBy: string,
  fragmentName: string = "blocknote",
): string | null {
  const fragment = ydoc.getXmlFragment(fragmentName);
  const found = findBlockContainer(fragment, afterBlockId);
  if (!found) return null;

  const { element: block, id: newId } = createHtmlVizBlock(html, createdBy);

  ydoc.transact(() => {
    found.parent.insert(found.index + 1, [block]);
  });

  return newId;
}

/** Replace the HTML of an existing htmlViz block in place.
 *  Returns false if the block wasn't found or wasn't an htmlViz block. */
function updateHtmlVizContent(
  ydoc: Y.Doc,
  blockId: string,
  html: string,
  fragmentName: string = "blocknote",
): { ok: true } | { ok: false; reason: "not_found" | "wrong_type" } {
  const fragment = ydoc.getXmlFragment(fragmentName);
  const found = findBlockContainer(fragment, blockId);
  if (!found) return { ok: false, reason: "not_found" };

  // Find the existing <htmlViz> child. We only update; we don't convert
  // other block types into htmlViz — if you want that, delete + insert.
  let vizEl: Y.XmlElement | null = null;
  for (let i = 0; i < found.container.length; i++) {
    const child = found.container.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "htmlViz") {
      vizEl = child;
      break;
    }
  }
  if (!vizEl) return { ok: false, reason: "wrong_type" };

  ydoc.transact(() => {
    vizEl!.setAttribute("html", html);
    // Bump the timestamp so the badge reflects the most recent edit.
    vizEl!.setAttribute("createdAt", new Date().toISOString());
  });
  return { ok: true };
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

/**
 * Strict variant of getOrCreateDoc used by MCP tool handlers. Refuses to
 * touch a doc that has no row in `documents` — this closes the anon
 * storage-pollution vector where `getOrCreateDoc` would happily allocate
 * an in-memory Yjs doc for any caller-supplied ID and then persist its
 * content into `yjs_documents`.
 *
 * Returns a mcpError-shaped object on failure so tool handlers can
 * early-return without try/catch gymnastics.
 */
function getDocStrictForMcp(docName: string):
  | { ok: true; entry: DocEntry }
  | { ok: false; error: ReturnType<typeof mcpError> } {
  const row = getDocOwnerStmt.get(docName) as { owner_id: string | null } | undefined;
  if (!row) {
    return {
      ok: false,
      error: mcpError(
        "not_found",
        `Document "${docName}" does not exist. Create it in the web app (postpaper.co) first, then share its URL with the AI.`
      ),
    };
  }
  return { ok: true, entry: getOrCreateDoc(docName) };
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

// ─── Pages (multi-page documents) ─────────────────────────────────────────
//
// A document can hold multiple pages. Data model (mirrored by the web UI in
// components/PageTabs.tsx — keep in sync):
//
//   ydoc.getArray<string>("pageOrder")   — page ids in display order
//   ydoc.getMap<string>("pageTitles")    — id → title
//
// Each page stores its block content in its own XmlFragment keyed by its id
// (ydoc.getXmlFragment(pageId)). The first page keeps the special id
// "blocknote" so single-page (legacy) documents continue to work unchanged —
// their content already lives in that fragment.
//
// For MCP, a page reference accepted from the caller can be:
//   - a page ID (matches exactly)
//   - a page title (case-insensitive exact match; whitespace trimmed)
//   - undefined → default to the first page
// Only one match is returned; ambiguous titles raise a clear error.

const FIRST_PAGE_ID = "blocknote";

function generatePageId(): string {
  // 10 random chars — matches the shape used by the web UI's newPageId().
  return Math.random().toString(36).slice(2, 12);
}

/** Return the current list of pages. For docs that predate multi-page (no
 *  pageOrder yet), reports a single implicit page for the "blocknote"
 *  fragment. No state mutation — safe to call from read paths. */
function listPages(ydoc: Y.Doc): { id: string; title: string }[] {
  const order = ydoc.getArray<string>("pageOrder");
  const titles = ydoc.getMap<string>("pageTitles");
  const ids = order.toArray();
  if (ids.length === 0) {
    // Legacy doc — one implicit page backed by the "blocknote" fragment.
    return [{ id: FIRST_PAGE_ID, title: titles.get(FIRST_PAGE_ID) || "Page 1" }];
  }
  const seen = new Set<string>();
  const out: { id: string; title: string }[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: titles.get(id) || "Untitled" });
  }
  return out;
}

/** Ensure the pageOrder/pageTitles metadata exists. Seeds it with the
 *  conventional first-page entry pointing at the "blocknote" fragment. */
function ensurePagesSeeded(ydoc: Y.Doc): void {
  const order = ydoc.getArray<string>("pageOrder");
  if (order.length > 0) return;
  const titles = ydoc.getMap<string>("pageTitles");
  ydoc.transact(() => {
    order.push([FIRST_PAGE_ID]);
    if (!titles.has(FIRST_PAGE_ID)) {
      titles.set(FIRST_PAGE_ID, "Page 1");
    }
  });
}

/** Create a new page and append it to the order. Returns its id. */
function createPage(ydoc: Y.Doc, title: string): string {
  ensurePagesSeeded(ydoc);
  const order = ydoc.getArray<string>("pageOrder");
  const titles = ydoc.getMap<string>("pageTitles");
  const trimmed = title.trim() || `Page ${order.length + 1}`;
  const id = generatePageId();
  ydoc.transact(() => {
    order.push([id]);
    titles.set(id, trimmed);
  });
  return id;
}

/** Delete a page. Returns a result describing the outcome:
 *  - { ok: true } on success
 *  - { ok: false, reason: "not_found" } if the page doesn't exist
 *  - { ok: false, reason: "last_page" } if trying to delete the only page
 *
 *  The underlying XmlFragment keyed by the page id lingers (Yjs has no
 *  "delete fragment" primitive) — this is the same trade-off the web UI
 *  makes in PageTabs.tsx. Cost is a few bytes per orphan fragment. */
function deletePage(
  ydoc: Y.Doc,
  pageId: string
): { ok: true } | { ok: false; reason: "not_found" | "last_page" } {
  ensurePagesSeeded(ydoc);
  const order = ydoc.getArray<string>("pageOrder");
  const titles = ydoc.getMap<string>("pageTitles");
  const ids = order.toArray();
  const idx = ids.indexOf(pageId);
  if (idx < 0) return { ok: false, reason: "not_found" };
  if (ids.length <= 1) return { ok: false, reason: "last_page" };
  ydoc.transact(() => {
    order.delete(idx, 1);
    titles.delete(pageId);
  });
  return { ok: true };
}

/** Rename a page. Returns false if the page does not exist. */
function renamePage(ydoc: Y.Doc, pageId: string, newTitle: string): boolean {
  const order = ydoc.getArray<string>("pageOrder");
  const titles = ydoc.getMap<string>("pageTitles");
  // Legacy docs: accept the implicit first-page id even if no pageOrder exists yet.
  const ids = order.toArray();
  const exists = ids.includes(pageId) || (ids.length === 0 && pageId === FIRST_PAGE_ID);
  if (!exists) return false;
  const trimmed = newTitle.trim() || "Untitled";
  ydoc.transact(() => {
    // If we're renaming the legacy implicit page, seed pageOrder so the title
    // sticks (otherwise pageTitles is set but no one reads it).
    if (ids.length === 0) ensurePagesSeeded(ydoc);
    titles.set(pageId, trimmed);
  });
  return true;
}

/** Resolve a page reference to a concrete {id, title}. See file-level doc
 *  comment for accepted shapes. Throws on ambiguous title, returns null on
 *  unknown reference. */
function resolvePageRef(
  ydoc: Y.Doc,
  ref: string | undefined | null
): { id: string; title: string } | null {
  const pages = listPages(ydoc);
  if (!ref || !ref.trim()) return pages[0] ?? null;
  const trimmed = ref.trim();
  // Try ID match first (unambiguous).
  const byId = pages.find((p) => p.id === trimmed);
  if (byId) return byId;
  // Fall back to title match (case-insensitive).
  const lc = trimmed.toLowerCase();
  const byTitle = pages.filter((p) => p.title.toLowerCase() === lc);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new Error(
      `Ambiguous page title "${trimmed}" — ${byTitle.length} pages share it. Use the page ID instead.`
    );
  }
  return null;
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

/** Resolve a page ref for an MCP tool. Returns an error result the handler
 *  should return directly, or the concrete page when resolution succeeds. */
function resolvePageForMcp(
  ydoc: Y.Doc,
  ref: string | undefined
): { ok: true; page: { id: string; title: string } } |
   { ok: false; error: ReturnType<typeof mcpError> } {
  try {
    const page = resolvePageRef(ydoc, ref);
    if (!page) {
      const pages = listPages(ydoc);
      const list = pages.map((p) => `"${p.title}" (id: ${p.id})`).join(", ") || "(none)";
      return {
        ok: false,
        error: mcpError(
          "not_found",
          `Page "${ref}" not found. Available pages: ${list}. Call list_pages for the authoritative list, or omit "page" to target the first page.`
        ),
      };
    }
    return { ok: true, page };
  } catch (e) {
    return { ok: false, error: mcpError("invalid_input", e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Build a fresh MCP server instance for one HTTP request. The optional
 * `userEmail` argument is the identity resolved from the `?key=` query
 * param on /mcp. When present, each tool handler authorizes the doc via
 * `authorizeMcpCall` → `getDocAccess`. When null, only share-token URLs
 * (/v/:token) work; /doc/:id calls are rejected with a pointer to the
 * dashboard key-minting flow.
 */
function createMcpServer(userEmail: string | null = null): McpServer {
  const mcp = new McpServer({
    name: "PostPaper",
    version: MCP_SERVER_VERSION,
    instructions: MCP_INSTRUCTIONS,
  });

  // Nudge clients that cache tools/list across chat sessions (notably the
  // Claude.ai connector UI) to re-fetch the list right after they finish the
  // handshake. Without this, newly-deployed tools stay invisible until the
  // user manually disconnects and reconnects the MCP. Clients that already
  // re-fetch on every init ignore this cheaply; clients that respect the
  // notification pick up new tools transparently. Not a panacea — some
  // clients ignore it entirely — but it's a 3-line win where it works.
  mcp.server.oninitialized = () => {
    try {
      mcp.sendToolListChanged();
    } catch {
      // Transport may have closed between init and this callback — ignore.
    }
  };

  // Wrapper around mcp.tool() that splices "what's new + reconnect"
  // hints into the response when the caller's MCP client is behind
  // MCP_SERVER_VERSION. The hint shows once per (user, version) pair —
  // see buildReleaseHintIfDue for details. Wrapping at the registration
  // site means we don't have to touch every tool's return statement.
  type ToolHandler = (args: never) => Promise<McpToolResult> | McpToolResult;
  const registerTool = (
    name: string,
    description: string,
    schema: Parameters<typeof mcp.tool>[2],
    handler: ToolHandler
  ) => {
    mcp.tool(name, description, schema, (async (args: never) => {
      const result = await handler(args);
      return appendReleaseHint(result, userEmail);
    }) as Parameters<typeof mcp.tool>[3]);
  };

  registerTool(
    "read_document",
    "Read one page of a PostPaper document. This is a live, multi-user, block-based editor: each block has a stable ID and is an independent unit of meaning. ALWAYS call this before editing — returns blocks with IDs so you can make surgical edits via update_block / insert_block / delete_block (preferred) instead of rewriting. A document can have multiple pages (Excel-style tabs) — without a page argument you get the first one. Use list_pages to discover other pages; pass their id or title via 'page' to read a specific tab. Core mindset: think in blocks, not pages; one idea per block; headings are navigation, not decoration; preserve collaborators' work — do not touch blocks unrelated to the task.",
    {
      doc_url: z.string().describe("Document URL — either /doc/:id (canonical, editor access) or /v/:token (view-only share link, read-only). You can also pass the bare ID for a /doc/:id URL."),
      page: z.string().optional().describe("Optional page ID or title. Omit to read the first page. Call list_pages to see all pages."),
    },
    async ({ doc_url, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "read");
      if (!authz.ok) return authz.error;
      const { docId, viaShareToken, role } = ctx;
      logEvent("mcp.read_document", docId, { page: page ?? null, via: viaShareToken ? "share" : "doc" });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        const pages = listPages(entry.ydoc);
        const blocks = extractBlocksWithIds(entry.ydoc, targetPage.id);

        const pageSummary = pages.length > 1
          ? `\nPages in this document (${pages.length}): ${pages.map(p => `"${p.title}"`).join(", ")}. Currently reading: "${targetPage.title}".`
          : "";

        // When the caller opened via /v/:token, surface the access mode so Claude
        // knows what write operations will work. Viewer links are read-only on the
        // wire (ws-server drops their sync updates), so writes through MCP would
        // also be blocked below — we tell the model up front to avoid wasted calls.
        const accessNote = viaShareToken
          ? (role === "viewer"
              ? `\n\n[ACCESS: view-only share link] You can read this document but CANNOT edit it. Do not attempt update_block / insert_block / delete_block / edit_document / create_table / create_html_block / update_html_block / create_page / rename_page — they will be rejected. If the user asks for edits, tell them to share the canonical /doc/:id URL (not /v/:token) or to issue an editor share link.`
              : `\n\n[ACCESS: ${role} share link] You opened this document via a share token granting ${role} access.`)
          : "";

        if (blocks.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Page "${targetPage.title}" in document (ID: ${docId}) is empty.${role === "viewer" ? "" : ` Use edit_document with page="${targetPage.title}" to add content.`}${pageSummary}${accessNote}`,
            }],
          };
        }

        const lines = blocks.map(b => {
          const prefix = b.type === "heading" ? "#".repeat(b.level || 1) + " "
            : b.type === "bulletListItem" ? "- "
            : b.type === "numberedListItem" ? "1. "
            : "";
          // Tag interactive blocks explicitly so Claude knows to use
          // update_html_block (not update_block) when iterating on them.
          const typeTag = b.type === "htmlViz" ? " [htmlViz]" : "";
          return `[${b.id}]${typeTag} ${prefix}${b.text}`;
        });

        return {
          content: [{
            type: "text" as const,
            text: `Document "${extractTitle(entry.ydoc)}" (ID: ${docId}) — page "${targetPage.title}" (${blocks.length} blocks):\n\n${lines.join("\n")}${pageSummary}${accessNote}\n\n--- HOW TO EDIT ---\nThink in blocks, not pages within a page. Each line above is one addressable block with a stable ID.\n- Change one block: update_block(block_id, text)\n- Add between blocks: insert_block(after_block_id, text)\n- Remove a block: delete_block(block_id) — works on every block type including tables and interactive blocks\n- Append at the end: edit_document(mode="append")\n- Tables: create_table(rows)\n- Interactive (HTML) blocks: create_html_block(html) for charts/dashboards/visualizations; update_html_block(block_id, html) to iterate on one. Blocks marked [htmlViz] in the listing above CANNOT be edited with update_block — use update_html_block instead.\nAll write tools accept an optional "page" argument — pass the same page id or title you used here to keep edits on this tab. NEVER use edit_document(mode="replace") unless the user explicitly asks to rewrite.\n\nMULTIPLE PAGES: Use pages (tabs) to separate genuinely distinct sections — e.g. "API reference", "Changelog", "Roadmap" — when each would otherwise be a very long document section. Do NOT split a single flowing narrative across pages. Create a new page with create_page, then target it with edit_document(page=...).\n\nPRESERVE COLLABORATORS' WORK: do not touch blocks unrelated to the task, even if you think they could be improved. One logical change per operation.\n\nFORMATTING: most blocks should be paragraphs (no prefix). Use "- " only for 3+ short parallel items; headings only for section titles; bold only on key terms. Inline: **bold**, *italic*, \`code\`, ~~strike~~, __underline__, [text](url).\n\nCOLORS: supported via text_color / background_color on update_block and insert_block. Palette: default, gray, brown, red, orange, yellow, green, blue, purple, pink. Use at most 1–2 accent colors per document, with consistent semantics (red=warning, green=success, blue=info, yellow bg=highlight).`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "edit_document",
    "Append (or replace) markdown content on ONE page of a PostPaper document. Each line becomes one block; prefix sets type — no prefix = paragraph, # = heading, - = bullet, 1. = numbered, - [ ] = task. Inline: **bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url). For targeted edits ALWAYS prefer update_block / insert_block / delete_block — they preserve block IDs and don't disturb other collaborators. mode='replace' is a last resort; never use it unless the user explicitly asks to rewrite the whole page. For tables use create_table. For colors, write content first, then update_block with text_color/background_color. Pass 'page' to target a specific tab — omit to write to the first page. If the content would make the page very long and splits naturally into distinct topics, consider create_page + edit_document to put the new section on its own tab instead.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      content: z.string().describe("Markdown text. NO prefix = paragraph. # = heading. - = bullet. 1. = numbered. - [ ] = checklist. **bold** *italic* `code` [text](url)"),
      mode: z.enum(["append", "replace"]).default("append").describe("'append' adds to end (default). ONLY use 'replace' when user explicitly asks to rewrite the whole page."),
      page: z.string().optional().describe("Optional page ID or title. Omit to write to the first page. Call list_pages to see available pages or create_page to add a new one."),
    },
    async ({ doc_url, content, mode, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.edit_document", docId, { mode, chars: content.length, page: page ?? null });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        let count: number;
        if (mode === "replace") {
          count = replaceDocContent(entry.ydoc, content, targetPage.id);
        } else {
          count = appendTextToDoc(entry.ydoc, content, targetPage.id);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Done! ${mode === "replace" ? "Replaced" : "Appended"} ${count} blocks on page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}\nTip: To add colors, use read_document to get block IDs, then update_block with text_color/background_color.`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "update_block",
    "Edit ONE block by ID — the preferred tool for targeted changes. Preserves the block's identity (other editors' cursors and references stay valid) and leaves unrelated blocks untouched. Use read_document first to get IDs. For multiple changes, call update_block multiple times rather than rewriting via edit_document. Supports inline formatting (**bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url)), text/background color, alignment, type change, and heading level. Multi-page docs: pass the same 'page' argument you used with read_document — block IDs are scoped to one page.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      block_id: z.string().describe("The block ID to update (from read_document output, shown in [brackets])"),
      text: z.string().describe("New text. Supports: **bold**, *italic*, ~~strike~~, `code`, __underline__, [text](url)"),
      block_type: z.string().optional().describe("Block type: paragraph, heading, bulletListItem, numberedListItem, checkListItem"),
      level: z.number().optional().describe("Heading level (1-3). Only for headings."),
      text_color: z.string().optional().describe("Text color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      background_color: z.string().optional().describe("Background color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      text_alignment: z.string().optional().describe("Alignment: left, center, right"),
      page: z.string().optional().describe("Optional page ID or title the block lives on. Omit to target the first page."),
    },
    async ({ doc_url, block_id, text, block_type, level, text_color, background_color, text_alignment, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.update_block", docId, { block_id, page: page ?? null });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;

        // If no type specified, detect current type
        let type = block_type;
        {
          const blocks = extractBlocksWithIds(entry.ydoc, targetPage.id);
          const current = blocks.find(b => b.id === block_id);
          // Refuse to overwrite interactive (htmlViz) blocks with plain text —
          // a blind update_block would destroy the HTML payload. Route the
          // caller to the correct tool. Block_type override is also rejected
          // so a caller can't accidentally convert a viz into a paragraph.
          if (current?.type === "htmlViz") {
            return mcpError(
              "invalid_input",
              `Block "${block_id}" is an interactive (HTML) block. Use update_html_block to change its content, or delete_block + create a replacement. update_block only works on text blocks (paragraph, heading, bulletListItem, numberedListItem, checkListItem, quote).`,
            );
          }
          if (!type) {
            type = current?.type || "paragraph";
            if (!level && current?.level) level = current.level;
          }
        }

        const style: BlockStyle = {};
        if (text_color) style.textColor = text_color;
        if (background_color) style.backgroundColor = background_color;
        if (text_alignment) style.textAlignment = text_alignment;

        const ok = updateBlockText(entry.ydoc, block_id, text, type, level, style, targetPage.id);
        if (!ok) {
          return mcpError("not_found", `Block "${block_id}" not found on page "${targetPage.title}". Use read_document (with the same page) to get current block IDs.`);
        }
        return {
          content: [{ type: "text" as const, text: `Updated block ${block_id} on page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}` }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "delete_block",
    "Delete ONE block by ID. Only delete blocks that are clearly part of the requested change — other humans and agents may be editing in parallel, so do not delete blocks you did not author unless the user explicitly asks. Use read_document first to get IDs. Multi-page docs: pass the same 'page' argument you used with read_document.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      block_id: z.string().describe("The block ID to delete"),
      page: z.string().optional().describe("Optional page ID or title the block lives on. Omit to target the first page."),
    },
    async ({ doc_url, block_id, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.delete_block", docId, { block_id, page: page ?? null });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        const ok = deleteBlock(entry.ydoc, block_id, targetPage.id);
        if (!ok) {
          return mcpError("not_found", `Block "${block_id}" not found on page "${targetPage.title}".`);
        }
        return {
          content: [{ type: "text" as const, text: `Deleted block ${block_id} from page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}` }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "insert_block",
    "Insert ONE new block immediately after a given block ID. Prefer this over edit_document when adding content between existing blocks; use edit_document(mode='append') only to append at the end. One idea per block — the first line should carry the gist so scanners get the point. Supports inline formatting (**bold**, *italic*, `code`, ~~strike~~, __underline__, [text](url)), text/background color, alignment, type, and heading level. Multi-page docs: pass the same 'page' argument you used with read_document — block IDs are page-scoped.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      after_block_id: z.string().describe("Insert the new block after this block ID"),
      text: z.string().describe("Text content. Supports: **bold**, *italic*, ~~strike~~, `code`, __underline__, [text](url)"),
      block_type: z.string().default("paragraph").describe("Block type: paragraph, heading, bulletListItem, numberedListItem, checkListItem"),
      level: z.number().optional().describe("Heading level (1-3). Only for headings."),
      text_color: z.string().optional().describe("Text color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      background_color: z.string().optional().describe("Background color: default, gray, brown, red, orange, yellow, green, blue, purple, pink"),
      page: z.string().optional().describe("Optional page ID or title. Omit to target the first page."),
    },
    async ({ doc_url, after_block_id, text, block_type, level, text_color, background_color, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.insert_block", docId, { after_block_id, block_type, page: page ?? null });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        const style: BlockStyle = {};
        if (text_color) style.textColor = text_color;
        if (background_color) style.backgroundColor = background_color;
        const newId = insertBlockAfter(entry.ydoc, after_block_id, block_type, text, level, style, targetPage.id);
        if (!newId) {
          return mcpError("not_found", `Block "${after_block_id}" not found on page "${targetPage.title}". Use read_document (with the same page) to get current block IDs.`);
        }
        return {
          content: [{ type: "text" as const, text: `Inserted new block ${newId} after ${after_block_id} on page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}` }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "create_table",
    "Insert a table. Use for genuinely tabular or comparative data (schedules, comparisons, specs, pricing). Do NOT use when a short list would suffice — tables are visually heavy. Provide rows as a 2D array; first row is the header. Each row should have ONLY the cells you want rendered — no trailing empty strings, no padding for visual alignment (the server trims trailing empties anyway, but cleaner input is easier to debug). Cells support inline formatting (**bold**, *italic*, [text](url), etc.). Pass after_block_id to place precisely; omit to append at the end. Multi-page docs: pass the same 'page' argument you used with read_document. KNOWN ISSUE: when the user has the document open in another browser tab while you call create_table, BlockNote's prosemirror-tables normalization can asymmetrically pad rows with ghost empty columns (header gets one, data rows get more). Workaround: if you observe ghost columns after creation (read_document shows row cell counts that don't match what you sent), tell the user to close all other tabs of the doc, then retry. For mass-inserting many tables in a long document, suggest closing tabs first.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      rows: z.array(z.array(z.string())).describe('2D array of cell text. Example: [["Name","Score"],["Alice","95"],["Bob","87"]]'),
      after_block_id: z.string().optional().describe("Insert table after this block ID. If omitted, appends to end of the page."),
      page: z.string().optional().describe("Optional page ID or title. Omit to target the first page."),
    },
    async ({ doc_url, rows, after_block_id, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.create_table", docId, { rows: rows?.length ?? 0, cols: rows?.[0]?.length ?? 0, page: page ?? null });
      try {
        if (!rows || rows.length === 0) {
          return mcpError("invalid_input", "rows must have at least one row.");
        }
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        let tableId: string | null;
        if (after_block_id) {
          tableId = insertTableAfter(entry.ydoc, after_block_id, rows, targetPage.id);
          if (!tableId) {
            return mcpError("not_found", `Block "${after_block_id}" not found on page "${targetPage.title}". Use read_document (with the same page) to get current block IDs.`);
          }
        } else {
          tableId = appendTable(entry.ydoc, rows, targetPage.id);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Created table (${rows.length} rows × ${rows[0].length} cols) with ID ${tableId} on page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "create_html_block",
    `Insert an "interactive block" — a self-contained HTML fragment rendered in a sandboxed iframe. Use this for data visualizations the user would otherwise have to describe in words: charts, dashboards, workout diagrams, timelines, comparison widgets, SVG/Canvas illustrations with hover interactions, small calculators.

Guidelines:
- Return a complete HTML fragment (no <html>/<body> wrapper — the server wraps it). Inline <style> and <script> are allowed.
- The iframe has NO network access and NO access to the parent page (sandbox="allow-scripts" without allow-same-origin). All data, CSS, and libraries must be inlined. Do not link external scripts or stylesheets — they will fail silently.
- Prefer pure SVG, Canvas, or vanilla JS. Large libraries blow the 100 KB size cap.
- Keep total HTML under 100 KB. The tool rejects anything larger.
- Do not include untrusted or user-supplied HTML — the block runs in the reader's browser.
- For plain tabular data use create_table. For textual content use edit_document / insert_block. This tool is for visuals only.

Pass after_block_id to place the block precisely; omit to append at the end. Multi-page docs: pass the same 'page' argument you used with read_document.`,
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      html: z.string().describe("Complete HTML fragment (no html/body wrapper). Inline <style> and <script> allowed. No network requests, no external resources."),
      after_block_id: z.string().optional().describe("Insert the block after this block ID. If omitted, appends to end of the page."),
      page: z.string().optional().describe("Optional page ID or title. Omit to target the first page."),
    },
    async ({ doc_url, html, after_block_id, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      const bytes = Buffer.byteLength(html ?? "", "utf8");
      logEvent("mcp.create_html_block", docId, { bytes, page: page ?? null });
      try {
        if (!html || !html.trim()) {
          return mcpError("invalid_input", "html must be a non-empty HTML fragment.");
        }
        if (bytes > HTML_VIZ_MAX_BYTES) {
          return mcpError(
            "invalid_input",
            `html is ${bytes.toLocaleString()} bytes; limit is ${HTML_VIZ_MAX_BYTES.toLocaleString()}. Simplify the visualization (fewer data points, smaller inline libraries) or split into multiple blocks.`,
          );
        }
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        let blockId: string | null;
        if (after_block_id) {
          blockId = insertHtmlVizAfter(entry.ydoc, after_block_id, html, userEmail, targetPage.id);
          if (!blockId) {
            return mcpError("not_found", `Block "${after_block_id}" not found on page "${targetPage.title}". Use read_document (with the same page) to get current block IDs.`);
          }
        } else {
          blockId = appendHtmlViz(entry.ydoc, html, userEmail, targetPage.id);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Created interactive block (${bytes.toLocaleString()} bytes) with ID ${blockId} on page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "update_html_block",
    "Replace the HTML content of an existing interactive block (created by create_html_block), preserving its block ID. Use this to iterate on a visualization — fixing a bug, adjusting styling, adding data points — without disturbing the surrounding document. Only accepts blocks that are already interactive blocks; to convert another block type, delete_block + create_html_block instead. Same 100 KB limit and sandbox rules as create_html_block.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      block_id: z.string().describe("The interactive block's ID (from read_document output)."),
      html: z.string().describe("New complete HTML fragment (no html/body wrapper). Same rules as create_html_block."),
      page: z.string().optional().describe("Optional page ID or title the block lives on. Omit to target the first page."),
    },
    async ({ doc_url, block_id, html, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      const bytes = Buffer.byteLength(html ?? "", "utf8");
      logEvent("mcp.update_html_block", docId, { block_id, bytes, page: page ?? null });
      try {
        if (!html || !html.trim()) {
          return mcpError("invalid_input", "html must be a non-empty HTML fragment.");
        }
        if (bytes > HTML_VIZ_MAX_BYTES) {
          return mcpError(
            "invalid_input",
            `html is ${bytes.toLocaleString()} bytes; limit is ${HTML_VIZ_MAX_BYTES.toLocaleString()}. Simplify the visualization or split it.`,
          );
        }
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        const res = updateHtmlVizContent(entry.ydoc, block_id, html, targetPage.id);
        if (!res.ok) {
          if (res.reason === "not_found") {
            return mcpError("not_found", `Block "${block_id}" not found on page "${targetPage.title}". Use read_document to get current IDs.`);
          }
          return mcpError(
            "invalid_input",
            `Block "${block_id}" is not an interactive block. Use update_block for text blocks, or delete_block + create_html_block to replace it.`,
          );
        }
        return {
          content: [{
            type: "text" as const,
            text: `Updated interactive block ${block_id} (${bytes.toLocaleString()} bytes) on page "${targetPage.title}". View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  // ─── Page-management tools ──────────────────────────────────────────

  registerTool(
    "list_pages",
    "List all pages (tabs) in a PostPaper document with their IDs and titles. Use this to discover the structure of a multi-page document before reading or editing. The first page in the list is the default target when you omit 'page' on other tools. A single-page document returns exactly one entry.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
    },
    async ({ doc_url }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "read");
      if (!authz.ok) return authz.error;
      const { docId, viaShareToken, role } = ctx;
      logEvent("mcp.list_pages", docId, { via: viaShareToken ? "share" : "doc" });
      void role; // listing is always allowed; read_document surfaces the access note
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const pages = listPages(entry.ydoc);
        const lines = pages.map((p, i) => `${i + 1}. "${p.title}" — id: ${p.id}${i === 0 ? " (default)" : ""}`);
        return {
          content: [{
            type: "text" as const,
            text: `Document (ID: ${docId}) has ${pages.length} page${pages.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n\nTo read a specific page: read_document(page="<id or title>"). To add a new page: create_page(title="..."). Omit the 'page' argument on any tool to target the first page.`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "create_page",
    "Create a new page (tab) in a PostPaper document and return its ID. CALL THIS DIRECTLY when the user asks for a new page/tab/section — do not ask for confirmation, just do it and report the result. You may also use it autonomously when organizing content: if the user asks for a large deliverable that naturally splits into distinct topics (e.g. separating 'API reference' from 'Changelog' from 'Roadmap'), create the tabs first, then populate them. Avoid creating pages for continuations of a single narrative, for every small section, or just because a page is getting long — those belong in headings on the current page. The title becomes the tab label (short noun phrase, ≤40 chars works best). After creation, pass the returned page id or the title to edit_document to populate it.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      title: z.string().describe("Tab label. Short noun phrase works best (e.g. 'API reference', 'Changelog', 'Roadmap')."),
    },
    async ({ doc_url, title }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.create_page", docId, { title });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const trimmed = title.trim();
        if (!trimmed) return mcpError("invalid_input", "title cannot be empty.");
        const pageId = createPage(entry.ydoc, trimmed);
        return {
          content: [{
            type: "text" as const,
            text: `Created page "${trimmed}" (id: ${pageId}). To populate it, call edit_document(page="${pageId}", content="...") or use the title: edit_document(page="${trimmed}", ...). View: ${VERCEL_URL}/doc/${docId}#${pageId}`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "rename_page",
    "Rename a page (tab) in a PostPaper document. CALL THIS DIRECTLY when the user asks to rename a tab — do not ask for confirmation, just do it. Accepts either the page's current ID or its exact current title. Don't rename pages unrelated to the task as a side effect (e.g. don't 'clean up' titles the user didn't ask about).",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      page: z.string().describe("The page ID or current title to rename."),
      new_title: z.string().describe("The new tab label. Short noun phrase; must be non-empty."),
    },
    async ({ doc_url, page, new_title }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.rename_page", docId, { page });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const trimmed = new_title.trim();
        if (!trimmed) return mcpError("invalid_input", "new_title cannot be empty.");
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        const ok = renamePage(entry.ydoc, targetPage.id, trimmed);
        if (!ok) return mcpError("not_found", `Page "${page}" not found.`);
        return {
          content: [{
            type: "text" as const,
            text: `Renamed page "${targetPage.title}" to "${trimmed}" (id: ${targetPage.id}). View: ${VERCEL_URL}/doc/${docId}${targetPage.id === FIRST_PAGE_ID ? "" : `#${targetPage.id}`}`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "delete_page",
    "Delete a page (tab) and all its blocks. CALL THIS DIRECTLY when the user asks to delete/remove a tab — do not ask for confirmation, just do it. Accepts the page ID or exact current title. Rules: (1) a document must keep at least one page — attempting to delete the only page returns an error; (2) don't delete pages the user did NOT ask about, even if they look empty or orphaned — other collaborators may be using them. Deletion cannot be undone through MCP; if the user asks to 'clear' or 'empty' a page rather than remove the tab, prefer edit_document(mode=\"replace\", content=\"\") instead.",
    {
      doc_url: z.string().describe("Document URL (/doc/:id for editor access, /v/:token for view-only) or the bare document ID."),
      page: z.string().describe("The page ID or current title to delete."),
    },
    async ({ doc_url, page }) => {
      let ctx: DocUrlContext;
      try { ctx = resolveDocUrl(doc_url); } catch (e) { return mcpErrorFromException(e); }
      const authz = authorizeMcpCall(ctx, userEmail, "write");
      if (!authz.ok) return authz.error;
      const { docId } = ctx;
      logEvent("mcp.delete_page", docId, { page });
      try {
        const got = getDocStrictForMcp(docId);
        if (!got.ok) return got.error;
        const entry = got.entry;
        const resolved = resolvePageForMcp(entry.ydoc, page);
        if (!resolved.ok) return resolved.error;
        const { page: targetPage } = resolved;
        const result = deletePage(entry.ydoc, targetPage.id);
        if (!result.ok && result.reason === "last_page") {
          return mcpError(
            "invalid_input",
            `Cannot delete "${targetPage.title}" — a document must have at least one page. If the user wants the tab gone entirely, first create another page to hold the content, then retry the delete.`
          );
        }
        if (!result.ok) {
          return mcpError("not_found", `Page "${page}" not found.`);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Deleted page "${targetPage.title}" (id: ${targetPage.id}). View: ${VERCEL_URL}/doc/${docId}`,
          }],
        };
      } catch (e) {
        return mcpErrorFromException(e);
      }
    }
  );

  registerTool(
    "list_my_documents",
    "Lists every PostPaper document the caller has access to — ones they own AND ones shared with them as editor or commenter. Returns title, doc URL, role, owner email, and last-edited timestamp, sorted most-recent-first. Use this when the user asks: 'what docs do I have', 'what can I edit in PostPaper', 'find my doc about X', 'what's been shared with me', or wants a doc URL to paste into another conversation. NOTE: requires an authenticated MCP key — anonymous /v/:token sessions cannot list (no identity to resolve). Don't confuse with list_pages, which returns tabs WITHIN a single document.",
    {},
    async () => {
      if (!userEmail) {
        return mcpError(
          "invalid_input",
          "Listing your documents requires an authenticated MCP key. Mint one in the dashboard at https://postpaper.co/dashboard and add `?key=YOUR_KEY` to the MCP server URL. Anonymous viewer share-token sessions don't have an identity to resolve."
        );
      }
      logEvent("mcp.list_my_documents", null, { email: maskEmail(userEmail) });
      try {
        const rows = db
          .prepare(
            `SELECT d.id, d.title, d.owner_id, d.updated_at,
                    CASE WHEN d.owner_id = ? THEN 'owner' ELSE c.role END AS role
               FROM documents d
               LEFT JOIN document_collaborators c
                      ON c.doc_id = d.id AND c.user_email = ?
              WHERE d.owner_id = ? OR c.user_email = ?
              ORDER BY d.updated_at DESC`
          )
          .all(userEmail, userEmail, userEmail, userEmail) as Array<{
            id: string;
            title: string | null;
            owner_id: string | null;
            updated_at: string;
            role: string;
          }>;

        if (rows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "You don't have access to any PostPaper documents yet. Create one at https://postpaper.co/dashboard or ask a collaborator for an invite link.",
            }],
          };
        }

        // Cap at 100 to keep the context small. With more, surface a hint
        // so the LLM doesn't claim authoritative completeness.
        const HARD_CAP = 100;
        const shown = rows.slice(0, HARD_CAP);
        const overflow = rows.length - shown.length;

        const lines: string[] = [];
        lines.push(`Your PostPaper documents (${rows.length} total${overflow > 0 ? `, showing ${HARD_CAP}` : ""}):`);
        lines.push("");
        for (const r of shown) {
          const url = `${VERCEL_URL}/doc/${r.id}`;
          const title = r.title && r.title.trim() ? r.title : "Untitled";
          const ownerLabel = r.role === "owner" ? "you" : (r.owner_id || "unknown");
          lines.push(
            `- [${r.role.toUpperCase()}] ${title}\n` +
            `  ${url}\n` +
            `  owner: ${ownerLabel} · last edited: ${r.updated_at}`
          );
        }
        if (overflow > 0) {
          lines.push("");
          lines.push(`...and ${overflow} more not shown. Ask the user to refine by name/owner if they need a specific older doc.`);
        }

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
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

## URL formats — /doc/:id vs /v/:token
Document URLs come in two shapes:
- **/doc/:id** — canonical URL. Full editor access. Example: https://postpaper.co/doc/abc123.
- **/v/:token** — read-only share link. You can read the document but all
  write tools (update_block, insert_block, delete_block, edit_document,
  create_table, create_html_block, update_html_block, create_page, rename_page)
  will reject your call with a clear error. If the user pastes a /v/ URL and
  asks for edits, tell them it is view-only and ask for the canonical /doc/:id URL.

Never silently "interpret" a /v/:token path segment as a document ID — pass
the whole URL to the tool and let it resolve. If the share token is unknown,
the tool returns a not_found error; do not then fabricate a new document.

## Pages (Excel-style tabs) — when to split, when not to
A document can have multiple pages, shown as tabs at the top. Each page is its
own independent block stream — block IDs are scoped to one page. The first
page is the default target; every tool that takes 'page' accepts the tab ID
or its title.

Use pages to separate **genuinely distinct topics** that each deserve their
own scroll:
- Reference material vs. narrative (e.g. "Guide" + "API reference")
- Time-separated artifacts (e.g. "2026 plans" + "2025 retro" + "Changelog")
- Parallel deliverables sharing one project (e.g. "PRD" + "Launch plan" + "Metrics")

Do **not** create a new page for:
- A continuation of the same narrative — keep it on the current page with headings.
- Every H2 section of the current page — that's what headings are for.
- A short aside that is only meaningful in context of what came before it.
- Just because the current page is long. Length alone is not a reason to split.

Rule of thumb: if someone printing the document would expect a page break there
with the new section starting fresh and standalone, it's a new page. If they'd
expect the content to flow on, keep it on the same page.

When the user asks you to add, rename, or delete a tab, **just do it** via
the tool and report the result — do not ask for confirmation and do not tell
the user "you can do this by right-clicking." You have direct MCP access to:
- list_pages  — enumerate tabs
- create_page — add a tab (may be called autonomously when organizing new content)
- rename_page — relabel a tab
- delete_page — remove a tab (a document must keep at least one)
All read/write content tools accept an optional 'page' argument — pass the tab
id or title to target it.

# CAPABILITIES

## Block types — edit_document uses one line per block; the prefix sets the type
- (no prefix)   → paragraph (default; most content is paragraphs)
- # / ## / ###  → H1 / H2 / H3
- -             → bullet list item
- 1.            → numbered list item
- - [ ] / - [x] → unchecked / checked task
For tables use the create_table tool (2D array; first row is the header).
For interactive visualizations (charts, dashboards, workout diagrams, SVG
illustrations with hover state, small calculators) use create_html_block.
See the "Interactive blocks" section below for the full lifecycle.

## Interactive (HTML) blocks — live visualizations you generate
A PostPaper document can host sandboxed HTML fragments you author in response
to user asks like "draw me a chart of X", "visualize this workout", or "make
a dashboard of these numbers". Use them when words or a table wouldn't do the
data justice — charts, workout-power diagrams, timelines, interactive SVG
widgets, small calculators.

### Lifecycle
- **Create** — create_html_block(html, [after_block_id], [page]). Omit
  after_block_id to append. The tool returns the new block ID.
- **See** — read_document lists interactive blocks with a "[htmlViz]" tag
  after the ID, plus a size hint like "[Interactive block, 12,480 bytes HTML]".
  The raw HTML is NOT returned (it would flood the context); if you need to
  iterate, keep a copy of what you generated, or regenerate from scratch.
- **Edit** — update_html_block(block_id, html) replaces the HTML in place,
  preserving the block ID and position. update_block will REJECT htmlViz
  blocks — do not try to "fix typos" with it; regenerate the whole fragment
  via update_html_block instead.
- **Delete** — delete_block(block_id). The block ID is the same one shown
  in read_document output. No dedicated "delete_html_block" exists; the
  normal delete tool works on every block type.
- **Move** — delete_block + create_html_block with after_block_id. There
  is no in-place move operation.

### HTML rules (the sandbox is strict)
- The HTML runs in an iframe with sandbox="allow-scripts" and NO
  allow-same-origin. It cannot reach the network, parent page, cookies,
  or localStorage. Any <script src="…"> or <link href="…"> to an external
  URL will fail silently.
- Inline <style> and <script> are allowed and encouraged.
- Don't load external libraries (no CDN Chart.js, D3, React). Use vanilla
  JS + SVG or Canvas. Data must be baked into the fragment.
- Fragment only — no <html>/<body> wrapper (the server adds it with CSP).
- 100 KB hard size cap. If your generation is over, simplify: fewer data
  points, no embedded images (use SVG shapes instead), no whole libraries.
- Keep it semantically self-describing (<title>, ARIA labels) because
  exports and non-interactive readers see only "[Interactive block]".

### When NOT to use create_html_block
- Plain tabular data → create_table.
- Textual content, lists, code → edit_document / insert_block.
- Static images users upload → (not yet supported; tell the user).
- Anything that'd duplicate content already in surrounding blocks.

One interactive block per distinct visualization. Don't create a block to
"demo" something trivial a paragraph could say.

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
1. If you don't know the document's pages yet (e.g. user gave you a fresh URL
   and you plan edits larger than a single block), call list_pages first.
2. read_document — see current content and block IDs. Pass 'page' if the
   target isn't the first tab.
3. Pick the smallest set of operations that achieves the goal. If the new
   content is a genuinely separate topic that would bloat the current page,
   consider create_page before writing. Otherwise stay on the current page.
4. Prefer update_block / insert_block / delete_block for targeted edits. Pass
   the same 'page' argument you read from.
5. Use edit_document(mode="append") to add new content at the end of a page.
6. edit_document(mode="replace") is a last resort — only when explicitly asked to rewrite.
7. Use create_table for genuinely tabular data (not as a replacement for lists).
8. Use create_html_block for data visualizations that a paragraph or table
   would underserve (charts, diagrams, hover-tooltip widgets). Follow the
   sandbox rules in the "Interactive blocks" section — no network, no
   external libraries, 100 KB cap. Iterate via update_html_block.

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

/** Context resolved from an MCP `doc_url` argument — either a canonical
 *  /doc/:id URL (full editor access) or a /v/:token view-only link.
 *
 *  Role mirrors the share_tokens.role column for /v/ URLs; /doc/ URLs are
 *  treated as "editor" here because MCP itself is an authorized channel —
 *  finer-grained guards live at the feature level, not the URL parser. */
type DocUrlContext = { docId: string; role: ShareRole; viaShareToken: boolean };

function resolveDocUrl(docUrl: string): DocUrlContext {
  // /e/:token — editor invite link for humans. It's Google-SSO-gated
  // (clicking redeems the token and adds the signed-in user to the ACL),
  // so it's never valid as an MCP doc_url. Fail fast with a clear pointer
  // to the two URLs that do work, instead of letting the bare-id fallback
  // below try to interpret the token as a document ID.
  if (/\/e\/[^/?#]+/.test(docUrl)) {
    throw new Error(
      "That looks like an editor invite link (/e/:token). These are for humans — opening one signs you in with Google and grants edit access. They are not accepted as MCP doc_url values. " +
      "Ask the document owner for the canonical /doc/:id URL (paired with an MCP API key for write access), or a /v/:token view-only share link for read access."
    );
  }

  // /v/:token — look up the share token to get the real doc id + role.
  // Accept bare token as /v/... with no scheme, full URL, query/hash tails.
  const viewerMatch = docUrl.match(/\/v\/([^/?#]+)/);
  if (viewerMatch) {
    const token = viewerMatch[1];
    if (!token) {
      throw new Error("Invalid view-only URL: missing token.");
    }
    const row = getShareTokenStmt.get(token) as
      | { token: string; doc_id: string; role: string; created_at: string }
      | undefined;
    if (!row) {
      throw new Error(
        `View-only link not found (token "${token}"). The link may have been revoked, or you pasted a stale URL. Ask the owner for a fresh link, or use the canonical /doc/:id URL.`
      );
    }
    if (!isValidShareRole(row.role)) {
      throw new Error(`Corrupt share token: unknown role "${row.role}".`);
    }
    assertValidDocId(row.doc_id);
    return { docId: row.doc_id, role: row.role, viaShareToken: true };
  }

  // /doc/:id — canonical editor URL.
  const docMatch = docUrl.match(/\/doc\/([^/?#]+)/);
  const id = docMatch ? docMatch[1] : docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
  assertValidDocId(id);
  return { docId: id, role: "editor", viaShareToken: false };
}

// Legacy helper kept for code paths that don't need the role (e.g. read-only
// extraction). Delegates to resolveDocUrl and discards the role.
function extractDocIdFromUrl(docUrl: string): string {
  return resolveDocUrl(docUrl).docId;
}

/** MCP error for a write attempt via a view-only share link. */
function mcpViewerWriteError() {
  return mcpError(
    "invalid_input",
    "This is a view-only share link (/v/:token) — editing is not allowed. Ask the document owner for an editor link (/doc/:id), or request a commenter/editor share link when those become available."
  );
}

/** Authorize a caller's access to a doc inside an MCP tool handler.
 *
 * Rules, in order:
 *   1. Share-token URL (/v/:token) — the token's role is the authority; no
 *      user identity needed. Writes still require editor role.
 *   2. Canonical URL (/doc/:id) with MCP API key (userEmail set) — look up
 *      the live ACL. Must have at least `need` level to proceed.
 *   3. Canonical URL without API key — reject, tell the user to mint one.
 *
 * Returns `{ ok: true }` on success or an mcpError to early-return.
 */
function authorizeMcpCall(
  ctx: DocUrlContext,
  userEmail: string | null,
  need: "read" | "write"
):
  | { ok: true }
  | { ok: false; error: ReturnType<typeof mcpError> } {
  if (ctx.viaShareToken) {
    // /v/:token path — already role-gated by the token's stored role.
    if (need === "write" && ctx.role !== "editor" && ctx.role !== "commenter") {
      return { ok: false, error: mcpViewerWriteError() };
    }
    return { ok: true };
  }

  // Canonical /doc/:id — requires an authenticated user identity.
  if (!userEmail) {
    return {
      ok: false,
      error: mcpError(
        "invalid_input",
        "This MCP endpoint requires an API key to read or edit documents by /doc/:id URL. " +
        "Generate one at https://postpaper.co/dashboard and append ?key=YOUR_KEY to the MCP server URL. " +
        "Alternatively, paste a /v/:token share link to read/comment without a key."
      ),
    };
  }

  const access = getDocAccess(ctx.docId, userEmail);
  if (!access) {
    return {
      ok: false,
      error: mcpError(
        "not_found",
        `No access to document "${ctx.docId}" for this API key. Ask the owner to invite you via an editor/commenter link, or check that you're using the key tied to the right account.`
      ),
    };
  }
  if (need === "write" && access !== "owner" && access !== "editor") {
    return {
      ok: false,
      error: mcpError(
        "invalid_input",
        `Your role on this document is "${access}" — you can read/comment but cannot edit. Ask the owner for editor access.`
      ),
    };
  }
  return { ok: true };
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

  // GET /api/me/docs — list "my" documents resolved from an MCP API key.
  //
  // Header: x-api-key: <plaintext-mcp-key>. Used by the legacy stdio MCP
  // (mcp-server/) to give Claude Code (CLI) access to list_my_documents
  // without having to set up Next.js cookies. The HTTP MCP at /mcp does
  // its own auth via ?key= and goes straight through createMcpServer.
  if (req.method === "GET" && pathname === "/api/me/docs") {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey !== "string" || !apiKey) {
      sendJson(res, 401, { error: "x-api-key header required" });
      return;
    }
    const email = lookupMcpKey(apiKey);
    if (!email) {
      sendJson(res, 401, { error: "invalid or revoked MCP key" });
      return;
    }
    const rows = db
      .prepare(
        `SELECT d.id, d.title, d.owner_id, d.created_at, d.updated_at,
                CASE WHEN d.owner_id = ? THEN 'owner' ELSE c.role END AS role
           FROM documents d
           LEFT JOIN document_collaborators c
                  ON c.doc_id = d.id AND c.user_email = ?
          WHERE d.owner_id = ? OR c.user_email = ?
          ORDER BY d.updated_at DESC`
      )
      .all(email, email, email, email);
    sendJson(res, 200, { documents: rows });
    return;
  }

  // GET /api/docs?email=xxx — list every document the email has access to.
  //
  // Returns both owned documents AND ones the user was invited into via
  // document_collaborators. Each row carries a `role` field: 'owner',
  // 'editor', or 'commenter'. Sorted by updated_at DESC across both
  // sources so the most-recently-touched doc surfaces first regardless
  // of relationship.
  //
  // Backwards compat: ?ownerId=xxx is still accepted as an alias for
  // ?email=xxx but does NOT change semantics — it still returns the
  // collaborator union. Old callers wanting strictly owner-only docs
  // can filter on `role === 'owner'` client-side. Cleaner than adding
  // a flag.
  if (req.method === "GET" && pathname === "/api/docs") {
    const email = url.searchParams.get("email") || url.searchParams.get("ownerId");
    if (!email) {
      sendJson(res, 400, { error: "Missing email (or ownerId) query parameter" });
      return;
    }

    const rows = db
      .prepare(
        `SELECT d.id, d.title, d.owner_id, d.created_at, d.updated_at,
                CASE WHEN d.owner_id = ? THEN 'owner' ELSE c.role END AS role
           FROM documents d
           LEFT JOIN document_collaborators c
                  ON c.doc_id = d.id AND c.user_email = ?
          WHERE d.owner_id = ? OR c.user_email = ?
          ORDER BY d.updated_at DESC`
      )
      .all(email, email, email, email);

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
      if (!ownerId) {
        sendJson(res, 400, { error: "ownerId required" });
        return;
      }
      // Editor / commenter invite tokens grant *write* access to the doc —
      // minting them is therefore an owner-only operation. Viewer tokens
      // stay mintable by any signed-in user: /v/:token is read-only and
      // owner-knowledge of the docId is not a secret we rely on.
      if ((role === "editor" || role === "commenter") && ownerRow.owner_id !== ownerId) {
        sendJson(res, 403, { error: "Only the owner can mint editor or commenter invite tokens" });
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

  // ─── Collaborators (access model B: owner + invited) ─────────────────
  //
  // These endpoints back the Next.js invite-redemption flow and the future
  // "manage access" UI. All three require `ownerId` in the body/query and
  // are *not* public — the Next.js layer supplies a real authenticated
  // email from NextAuth before calling us. Defense in depth: we still
  // owner-check server-side even when the caller claims to have done so.

  // GET /api/docs/:id/access?email=... — resolve (doc, email) -> role
  // Returns { access: "owner" | "editor" | "commenter" | null, docId }.
  // Used by Next.js SSR to decide whether to render /doc/:id or 403.
  // Intentionally does NOT require ownerId — any authenticated caller can
  // check their own access. The `email` param is the identity being
  // checked, Next.js derives it from the session before calling.
  const accessMatch = pathname.match(/^\/api\/docs\/([^/]+)\/access$/);
  if (req.method === "GET" && accessMatch) {
    const docId = accessMatch[1];
    if (!isValidDocId(docId)) {
      sendJson(res, 400, { error: "invalid doc id" });
      return;
    }
    const email = url.searchParams.get("email");
    const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
    if (!ownerRow) {
      sendJson(res, 404, { error: "doc not found" });
      return;
    }
    const access = getDocAccess(docId, email);
    sendJson(res, 200, {
      docId,
      access,
      ownerId: ownerRow.owner_id,
    });
    return;
  }

  // POST /api/docs/:id/collaborators — add a user to the doc's ACL.
  // Body: { email, role, viaToken? }.
  //
  // Two authorized paths:
  //   (a) ownerId matches the doc's owner → admin add (owner invites by email).
  //   (b) viaToken present + matches an editor/commenter share_token for this
  //       doc → self-redemption (user clicked an invite link). In this case
  //       the body's `email` is the invitee's own email; no ownerId required.
  const collabMatch = pathname.match(/^\/api\/docs\/([^/]+)\/collaborators$/);
  if (req.method === "POST" && collabMatch) {
    const docId = collabMatch[1];
    if (!isValidDocId(docId)) {
      sendJson(res, 400, { error: "invalid doc id" });
      return;
    }
    try {
      const body = await parseBody(req);
      const email = (body.email as string) || "";
      const requestedRole = body.role as string;
      const viaToken = (body.viaToken as string) || null;
      const ownerId = (body.ownerId as string) || null;

      if (!email || !email.includes("@")) {
        sendJson(res, 400, { error: "email required" });
        return;
      }
      if (requestedRole !== "editor" && requestedRole !== "commenter") {
        sendJson(res, 400, { error: "role must be editor or commenter" });
        return;
      }
      const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
      if (!ownerRow) {
        sendJson(res, 404, { error: "doc not found" });
        return;
      }

      let authorized = false;
      let tokenToStore: string | null = null;

      if (ownerId && ownerRow.owner_id === ownerId) {
        authorized = true;
        tokenToStore = viaToken;
      } else if (viaToken) {
        const tokenRow = getShareTokenStmt.get(viaToken) as
          | { token: string; doc_id: string; role: string }
          | undefined;
        if (
          tokenRow &&
          tokenRow.doc_id === docId &&
          (tokenRow.role === "editor" || tokenRow.role === "commenter") &&
          tokenRow.role === requestedRole
        ) {
          authorized = true;
          tokenToStore = viaToken;
        }
      }

      if (!authorized) {
        sendJson(res, 403, { error: "must be owner or present a valid invite token" });
        return;
      }

      addCollaborator(docId, email, requestedRole, tokenToStore);
      logEvent("collaborator.add", docId, { email: maskEmail(email), role: requestedRole, via: tokenToStore ? "token" : "owner" });
      sendJson(res, 201, { docId, email, role: requestedRole });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // GET /api/docs/:id/collaborators?ownerId=... — list (owner-only).
  if (req.method === "GET" && collabMatch) {
    const docId = collabMatch[1];
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
    const rows = listCollaboratorsStmt.all(docId);
    sendJson(res, 200, { collaborators: rows });
    return;
  }

  // DELETE /api/docs/:id/collaborators/:email — remove (owner-only).
  const collabDeleteMatch = pathname.match(/^\/api\/docs\/([^/]+)\/collaborators\/([^/]+)$/);
  if (req.method === "DELETE" && collabDeleteMatch) {
    const docId = collabDeleteMatch[1];
    const email = decodeURIComponent(collabDeleteMatch[2]);
    if (!isValidDocId(docId)) {
      sendJson(res, 400, { error: "invalid doc id" });
      return;
    }
    try {
      const body = (await parseBody(req).catch(() => ({}))) as Record<string, unknown>;
      const ownerId = (body.ownerId as string) || url.searchParams.get("ownerId") || null;
      const ownerRow = getDocOwnerStmt.get(docId) as { owner_id: string | null } | undefined;
      if (!ownerRow) {
        sendJson(res, 404, { error: "doc not found" });
        return;
      }
      if (!ownerRow.owner_id || ownerRow.owner_id !== ownerId) {
        sendJson(res, 403, { error: "not the owner" });
        return;
      }
      const info = removeCollaboratorStmt.run(docId, email);
      logEvent("collaborator.remove", docId, { email: maskEmail(email) });
      sendJson(res, 200, { removed: info.changes > 0 });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // ─── Per-user MCP API keys ───────────────────────────────────────────
  //
  // The Next.js layer authenticates the user via NextAuth and forwards
  // the verified email. Because "mint a key for any email" would be a
  // trivial account-takeover vector, these endpoints require
  // INTERNAL_SECRET in addition to trusting the email — the secret is
  // shared only between Next.js and ws-server. Request from outside is
  // rejected even if the attacker guesses the right email.
  //
  // Response on mint returns the plaintext key once; afterwards only
  // the metadata (createdAt, lastUsedAt) is readable. Revoke is
  // idempotent.
  if (pathname === "/api/me/mcp-key") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    }

    // POST — mint (rotates if one already exists).
    // Body: { email }. Returns: { key, createdAt }.
    if (req.method === "POST") {
      try {
        const body = await parseBody(req);
        const email = (body.email as string) || "";
        if (!email) {
          sendJson(res, 400, { error: "email required" });
          return;
        }
        const { key, createdAt } = mintMcpKey(email);
        logEvent("mcp_key.mint", null, { email: maskEmail(email) });
        sendJson(res, 201, { key, createdAt });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    // GET ?email=... — info (no plaintext).
    // Returns: { hasKey, createdAt, lastUsedAt }.
    if (req.method === "GET") {
      const email = url.searchParams.get("email") || "";
      if (!email) {
        sendJson(res, 400, { error: "email required" });
        return;
      }
      sendJson(res, 200, getMcpKeyInfo(email));
      return;
    }

    // DELETE — revoke. Body or query: { email }.
    if (req.method === "DELETE") {
      try {
        const body = (await parseBody(req).catch(() => ({}))) as Record<string, unknown>;
        const email = (body.email as string) || url.searchParams.get("email") || "";
        if (!email) {
          sendJson(res, 400, { error: "email required" });
          return;
        }
        const revoked = revokeMcpKey(email);
        if (revoked) logEvent("mcp_key.revoke", null, { email: maskEmail(email) });
        sendJson(res, 200, { revoked });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
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

  // GET /api/admin/disk-usage — what's eating /app/data.
  //
  // Reports every file in DATA_DIR with its size, plus a `total`. The
  // Railway "Volume Is Full" alert fired with the main DB at only
  // 1.66 GB out of a 5 GB volume — suggesting WAL files and backup
  // copies were the actual bulk. Need this view to confirm before
  // deciding what to reclaim.
  if (req.method === "GET" && pathname === "/api/admin/disk-usage") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, { error: "INTERNAL_SECRET is not configured" });
      return;
    }

    try {
      const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
      const files: Array<{ name: string; size: number; isDir: boolean }> = [];
      let total = 0;
      for (const entry of entries) {
        const full = path.join(DATA_DIR, entry.name);
        try {
          const stat = fs.statSync(full);
          files.push({ name: entry.name, size: stat.size, isDir: entry.isDirectory() });
          total += stat.size;
        } catch {
          // skip unreadable
        }
      }
      files.sort((a, b) => b.size - a.size);
      sendJson(res, 200, { dataDir: DATA_DIR, total, files });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // POST /api/admin/wal-checkpoint — truncate the WAL file.
  //
  // SQLite's WAL mode keeps committed transactions in a sidecar file
  // until a checkpoint folds them back into the main DB. Under sustained
  // write load the WAL can grow much bigger than the DB itself; a
  // TRUNCATE checkpoint folds everything in AND shrinks the WAL file
  // back to zero bytes. Cheap and safe — does not touch user data.
  if (req.method === "POST" && pathname === "/api/admin/wal-checkpoint") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, { error: "INTERNAL_SECRET is not configured" });
      return;
    }

    try {
      const sizeBeforeWal = (() => {
        try { return fs.statSync(DB_PATH + "-wal").size; } catch { return 0; }
      })();
      const result = db.pragma("wal_checkpoint(TRUNCATE)");
      const sizeAfterWal = (() => {
        try { return fs.statSync(DB_PATH + "-wal").size; } catch { return 0; }
      })();
      sendJson(res, 200, {
        result,
        walSizeBefore: sizeBeforeWal,
        walSizeAfter: sizeAfterWal,
        walBytesFreed: sizeBeforeWal - sizeAfterWal,
      });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // POST /api/admin/cleanup-orphan-anons — delete every owner_id-NULL row.
  //
  // After the auth gate on POST /api/v1/docs (2026-04-26) no new anon
  // documents can be created. Every owner_id-NULL row in `documents` is
  // therefore either pre-migration legacy or accumulated spam — both
  // unreachable through the UI (/doc/:id requires sign-in, ACL has no
  // owner). Safe to nuke wholesale.
  //
  // This is broader than cleanup-spam (which only matched title='spam-N').
  // Body: { dryRun?: boolean }.
  if (req.method === "POST" && pathname === "/api/admin/cleanup-orphan-anons") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, { error: "INTERNAL_SECRET is not configured" });
      return;
    }

    try {
      const body = await parseBody(req).catch(() => ({}));
      const dryRun = (body as { dryRun?: boolean }).dryRun === true;

      const where = `owner_id IS NULL`;

      const matched = (
        db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${where}`).get() as { n: number }
      ).n;

      const sample = db
        .prepare(
          `SELECT id, title, created_at FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT 15`
        )
        .all();

      const sizeBefore = (() => {
        try { return fs.statSync(DB_PATH).size; } catch { return 0; }
      })();

      if (dryRun) {
        sendJson(res, 200, { dryRun: true, matched, sample, sizeBefore });
        return;
      }

      const matchedIds = (
        db.prepare(`SELECT id FROM documents WHERE ${where}`).all() as Array<{ id: string }>
      ).map((r) => r.id);

      const deleted = db.transaction(() => {
        const a = db.prepare(`DELETE FROM documents WHERE ${where}`).run();
        let b = 0, c = 0, d = 0, e = 0;
        const BATCH = 500;
        for (let i = 0; i < matchedIds.length; i += BATCH) {
          const slice = matchedIds.slice(i, i + BATCH);
          const placeholders = slice.map(() => "?").join(",");
          b += db
            .prepare(`DELETE FROM yjs_documents WHERE doc_id IN (${placeholders})`)
            .run(...slice).changes;
          c += db
            .prepare(`DELETE FROM events WHERE doc_id IN (${placeholders})`)
            .run(...slice).changes;
          d += db
            .prepare(`DELETE FROM share_tokens WHERE doc_id IN (${placeholders})`)
            .run(...slice).changes;
          e += db
            .prepare(`DELETE FROM document_collaborators WHERE doc_id IN (${placeholders})`)
            .run(...slice).changes;
        }
        return {
          documents: a.changes,
          yjs_documents: b,
          events: c,
          share_tokens: d,
          document_collaborators: e,
        };
      })();

      const t0 = Date.now();
      db.exec("VACUUM");
      const vacuumMs = Date.now() - t0;
      db.pragma("wal_checkpoint(TRUNCATE)");

      const sizeAfter = (() => {
        try { return fs.statSync(DB_PATH).size; } catch { return 0; }
      })();

      sendJson(res, 200, {
        dryRun: false,
        matched,
        deleted,
        sizeBefore,
        sizeAfter,
        bytesFreed: sizeBefore - sizeAfter,
        vacuumMs,
      });
    } catch (e) {
      console.error("[cleanup-orphan-anons] failed", e);
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // POST /api/admin/cleanup-spam — delete the bulk anon spam rows.
  //
  // Distinct from cleanup-pentest: pentest matches by id-prefix, but the
  // 2026-04-22/2026-04-26 spam attacks used real nanoid ids — the only
  // marker is `title='spam-N'` + `owner_id IS NULL`. We refuse to touch
  // any row with a non-null owner so a single misclick can't hit a real
  // user's doc.
  //
  // Body: { dryRun?: boolean }. Same shape as cleanup-pentest.
  if (req.method === "POST" && pathname === "/api/admin/cleanup-spam") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, { error: "INTERNAL_SECRET is not configured" });
      return;
    }

    try {
      const body = await parseBody(req).catch(() => ({}));
      const dryRun = (body as { dryRun?: boolean }).dryRun === true;

      // Hard guard: anonymous rows ONLY. Title pattern is loose enough to
      // cover any future "spam-NNNN" variant but tight enough not to catch
      // real titles that happen to start with the word "spam" — those would
      // need a typed user behind them, which the owner_id NULL check rules
      // out.
      const where = `owner_id IS NULL AND title LIKE 'spam-%'`;

      const matched = (
        db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${where}`).get() as { n: number }
      ).n;

      const sample = db
        .prepare(
          `SELECT id, title, created_at FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT 10`
        )
        .all();

      const sizeBefore = (() => {
        try { return fs.statSync(DB_PATH).size; } catch { return 0; }
      })();

      if (dryRun) {
        sendJson(res, 200, { dryRun: true, matched, sample, sizeBefore });
        return;
      }

      // Cascade-delete from all tables that reference doc_id, scoped to
      // ids we actually matched (so the doc_id LIKE/IN doesn't widen).
      const matchedIds = db
        .prepare(`SELECT id FROM documents WHERE ${where}`)
        .all() as Array<{ id: string }>;
      const ids = matchedIds.map((r) => r.id);

      const deleted = db.transaction(() => {
        const a = db.prepare(`DELETE FROM documents WHERE ${where}`).run();
        let b = 0, c = 0, d = 0, e = 0;
        if (ids.length > 0) {
          // SQLite limits parameter count (~999 by default), so batch.
          const BATCH = 500;
          for (let i = 0; i < ids.length; i += BATCH) {
            const slice = ids.slice(i, i + BATCH);
            const placeholders = slice.map(() => "?").join(",");
            b += db
              .prepare(`DELETE FROM yjs_documents WHERE doc_id IN (${placeholders})`)
              .run(...slice).changes;
            c += db
              .prepare(`DELETE FROM events WHERE doc_id IN (${placeholders})`)
              .run(...slice).changes;
            d += db
              .prepare(`DELETE FROM share_tokens WHERE doc_id IN (${placeholders})`)
              .run(...slice).changes;
            e += db
              .prepare(`DELETE FROM document_collaborators WHERE doc_id IN (${placeholders})`)
              .run(...slice).changes;
          }
        }
        return {
          documents: a.changes,
          yjs_documents: b,
          events: c,
          share_tokens: d,
          document_collaborators: e,
        };
      })();

      // VACUUM to release pages back to filesystem; followed by a WAL
      // truncate because VACUUM rewrites the whole DB through WAL.
      const t0 = Date.now();
      db.exec("VACUUM");
      const vacuumMs = Date.now() - t0;
      db.pragma("wal_checkpoint(TRUNCATE)");

      const sizeAfter = (() => {
        try { return fs.statSync(DB_PATH).size; } catch { return 0; }
      })();

      sendJson(res, 200, {
        dryRun: false,
        matched,
        deleted,
        sizeBefore,
        sizeAfter,
        bytesFreed: sizeBefore - sizeAfter,
        vacuumMs,
      });
    } catch (e) {
      console.error("[cleanup-spam] failed", e);
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // GET /api/admin/docs-summary — diagnostic counts of `documents`.
  //
  // Used to investigate id-prefix patterns of bulk anonymous inserts
  // (the pentest spikes on 22.04 and 26.04). Returns:
  //   - total docs
  //   - count grouped by owner_id (null vs known) and by created date
  //   - a small sample of ids per bucket so we can see naming conventions
  // Read-only, no side effects.
  if (req.method === "GET" && pathname === "/api/admin/docs-summary") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, { error: "INTERNAL_SECRET is not configured" });
      return;
    }

    try {
      const total = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;

      const byOwner = db
        .prepare(
          `SELECT
             CASE WHEN owner_id IS NULL THEN '(null)' ELSE 'known' END AS bucket,
             COUNT(*) AS n
           FROM documents
           GROUP BY bucket`
        )
        .all() as Array<{ bucket: string; n: number }>;

      const byDate = db
        .prepare(
          `SELECT DATE(created_at) AS day, COUNT(*) AS n
           FROM documents
           GROUP BY day
           ORDER BY day DESC
           LIMIT 10`
        )
        .all() as Array<{ day: string; n: number }>;

      // Sample 30 random ids from anonymous docs created in last 2 days
      const recentAnonSample = db
        .prepare(
          `SELECT id, title, created_at FROM documents
           WHERE owner_id IS NULL
             AND created_at >= datetime('now', '-2 days')
           ORDER BY RANDOM()
           LIMIT 30`
        )
        .all() as Array<{ id: string; title: string; created_at: string }>;

      // Frequency of id length to spot patterns (10-char nanoid vs longer)
      const idLengthHistogram = db
        .prepare(
          `SELECT LENGTH(id) AS len, COUNT(*) AS n
           FROM documents
           GROUP BY len
           ORDER BY n DESC
           LIMIT 10`
        )
        .all() as Array<{ len: number; n: number }>;

      sendJson(res, 200, { total, byOwner, byDate, recentAnonSample, idLengthHistogram });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // POST /api/admin/delete-backup — remove one of the SQLite backup
  // files in DATA_DIR. Body: { name: "collab-docs-backup-prev.db" }.
  // Only accepts file names matching ^collab-docs-backup(-prev)?\.db$
  // so a misuse can't blow away the live DB.
  if (req.method === "POST" && pathname === "/api/admin/delete-backup") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, { error: "INTERNAL_SECRET is not configured" });
      return;
    }

    try {
      const body = await parseBody(req);
      const name = (body as { name?: string }).name || "";
      // Accepts the backup DB itself plus its WAL/SHM sidecars. Live DB
      // names ('collab-docs.db', 'collab-docs.db-wal', 'collab-docs.db-shm')
      // do NOT match — the regex requires the '-backup' segment.
      if (!/^collab-docs-backup(-prev)?\.db(-wal|-shm)?$/.test(name)) {
        sendJson(res, 400, {
          error:
            "name must be a backup DB or its sidecar — " +
            "matches /^collab-docs-backup(-prev)?\\.db(-wal|-shm)?$/",
        });
        return;
      }
      const full = path.join(DATA_DIR, name);
      let sizeBefore = 0;
      try { sizeBefore = fs.statSync(full).size; } catch { /* not present */ }
      try {
        fs.unlinkSync(full);
        sendJson(res, 200, { deleted: name, freedBytes: sizeBefore });
      } catch (e) {
        sendJson(res, 404, { error: `cannot delete ${name}: ${String(e)}` });
      }
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // POST /api/admin/cleanup-pentest — emergency disk reclaim.
  //
  // Added 2026-04-25 after the Railway SQLite volume hit 100% and every
  // INSERT into `documents` started failing with "database or disk is
  // full". Hobby tier has no shell, so we expose the cleanup-pentest
  // logic over HTTP, gated by the same INTERNAL_SECRET other admin
  // endpoints use.
  //
  // Body: { dryRun?: boolean }. Default is dryRun=false.
  // Returns: { matched, deleted, sizeBefore, sizeAfter } in bytes.
  //
  // Matches doc ids by prefix only (Pentest%, zzz-deploy-probe-%, zzz-%,
  // diag-probe-%) — real user docs are 10-char nanoids without these
  // prefixes, so there is no risk of catching real content.
  if (req.method === "POST" && pathname === "/api/admin/cleanup-pentest") {
    const expected = process.env.INTERNAL_SECRET;
    if (expected) {
      const got = req.headers["x-internal-secret"];
      if (got !== expected) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    } else {
      sendJson(res, 503, {
        error: "INTERNAL_SECRET is not configured on this server",
      });
      return;
    }

    try {
      const body = await parseBody(req).catch(() => ({}));
      const dryRun = (body as { dryRun?: boolean }).dryRun === true;

      const PATTERNS = [
        "Pentest%",
        "PentestDoc%",
        "PentestReadOnly%",
        "zzz-deploy-probe-%",
        "zzz-%",
        "diag-%", // diag-probe-, diag-final-, anything else I left behind
      ];
      const whereId = PATTERNS.map(() => "id LIKE ?").join(" OR ");
      const whereDocId = PATTERNS.map(() => "doc_id LIKE ?").join(" OR ");

      const matched = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${whereId}`)
          .get(...PATTERNS) as { n: number }
      ).n;
      const matchedYjs = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM yjs_documents WHERE ${whereDocId}`)
          .get(...PATTERNS) as { n: number }
      ).n;
      const matchedEvents = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${whereDocId}`)
          .get(...PATTERNS) as { n: number }
      ).n;

      const sizeBefore = (() => {
        try { return fs.statSync(DB_PATH).size; } catch { return 0; }
      })();

      if (dryRun) {
        sendJson(res, 200, {
          dryRun: true,
          matched,
          matchedYjs,
          matchedEvents,
          sizeBefore,
        });
        return;
      }

      const deleted = db.transaction(() => {
        const a = db.prepare(`DELETE FROM documents WHERE ${whereId}`).run(...PATTERNS);
        const b = db.prepare(`DELETE FROM yjs_documents WHERE ${whereDocId}`).run(...PATTERNS);
        const c = db.prepare(`DELETE FROM events WHERE ${whereDocId}`).run(...PATTERNS);
        const d = db.prepare(`DELETE FROM share_tokens WHERE ${whereDocId}`).run(...PATTERNS);
        const e = db
          .prepare(`DELETE FROM document_collaborators WHERE ${whereDocId}`)
          .run(...PATTERNS);
        return {
          documents: a.changes,
          yjs_documents: b.changes,
          events: c.changes,
          share_tokens: d.changes,
          document_collaborators: e.changes,
        };
      })();

      // VACUUM is the only way to release freed pages to the filesystem.
      // It briefly takes a write lock — fine here, we already have one.
      const t0 = Date.now();
      db.exec("VACUUM");
      const vacuumMs = Date.now() - t0;

      const sizeAfter = (() => {
        try { return fs.statSync(DB_PATH).size; } catch { return 0; }
      })();

      sendJson(res, 200, {
        dryRun: false,
        matched,
        deleted,
        sizeBefore,
        sizeAfter,
        bytesFreed: sizeBefore - sizeAfter,
        vacuumMs,
      });
    } catch (e) {
      console.error("[cleanup-pentest] failed", e);
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
        // Resolve caller identity from ?key=… if present. Missing/invalid
        // keys don't hard-fail the request here — they just leave
        // `userEmail = null`, which the per-tool authz layer will translate
        // into a friendly "mint a key" error when the caller tries to touch
        // a /doc/:id URL. Share-token URLs (/v/:token) work without a key.
        const keyParam = url.searchParams.get("key");
        const userEmail = keyParam ? lookupMcpKey(keyParam) : null;
        const mcpServer = createMcpServer(userEmail);
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

  // ─── Auth gating for the WS handshake ─────────────────────────────────
  //
  // A connecting client must present one of two credentials:
  //
  //   (a) ?token=<share-token>   — the /v/:token viewer flow, or any other
  //       anonymous link-based access. The token is resolved in the DB and
  //       its role pins the connection (viewer/commenter/editor).
  //
  //   (b) ?session=<session-jwt> — issued by the Next.js layer after it
  //       verified the caller's NextAuth session and doc-level access
  //       (owner or collaborator). We re-verify the HMAC, confirm the JWT
  //       is scoped to this doc and not expired, and pin the role.
  //
  // No credential => reject. This closes the "any browser with the URL can
  // edit" hole that /v/:token exposed: previously a viewer could copy the
  // editor URL and open it to escalate.
  let role: ShareRole = "viewer";
  let sessionSubject: string | null = null;
  try {
    const qs = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const shareToken = params.get("token");
    const sessionTok = params.get("session");

    if (shareToken) {
      const row = getShareTokenStmt.get(shareToken) as
        | { token: string; doc_id: string; role: string; created_at: string }
        | undefined;
      if (!row || row.doc_id !== docName || !isValidShareRole(row.role)) {
        console.warn(`[ws] rejected: bad share token for doc=${docName}`);
        ws.close(1008, "Invalid share token");
        return;
      }
      role = row.role;
    } else if (sessionTok) {
      const verified = verifySessionToken(sessionTok, WS_SESSION_SECRET);
      if (!verified.ok) {
        console.warn(`[ws] rejected: session token ${verified.reason} for doc=${docName}`);
        ws.close(1008, `Invalid session (${verified.reason})`);
        return;
      }
      if (verified.claims.doc !== docName) {
        console.warn(`[ws] rejected: session doc mismatch got=${verified.claims.doc} want=${docName}`);
        ws.close(1008, "Session scoped to a different document");
        return;
      }
      // Bridge tokens come with sub=__bridge__; treat them as internal
      // editor principals. For human users we still need membership to be
      // valid at connect time — we check, but only as a sanity gate, since
      // the Next.js layer was the authority that minted this token.
      if (verified.claims.sub === BRIDGE_SUBJECT) {
        role = "editor";
      } else {
        const access = getDocAccess(docName, verified.claims.sub);
        if (!access) {
          console.warn(`[ws] rejected: no live access for ${maskEmail(verified.claims.sub)} on doc=${docName}`);
          ws.close(1008, "Access revoked");
          return;
        }
        // Owner behaves as editor on the wire — there's no "owner-only"
        // permission on individual Yjs messages, only the UI surfaces it.
        role = access === "owner" ? "editor" : (access as ShareRole);
      }
      sessionSubject = verified.claims.sub;
    } else {
      console.warn(`[ws] rejected: no credentials for doc=${docName}`);
      ws.close(1008, "Authentication required");
      return;
    }
  } catch (e) {
    console.error("[ws] auth failed:", e);
    ws.close(1011, "Internal error");
    return;
  }
  // Stash on the ws so message/broadcast handlers can consult it.
  (ws as unknown as { role: ShareRole; subject: string | null }).role = role;
  (ws as unknown as { role: ShareRole; subject: string | null }).subject = sessionSubject;

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
//
// Hobby-tier tradeoffs (revised 2026-04-25 after the volume hit 100%):
//
//   1. ONE backup file, no rotation. Two slots (`backup` + `backup-prev`)
//      ate ~half of a 5 GB volume when the DB grew to 1.6 GB — and the
//      old rotation copied only `.db`, leaving the `-wal` sidecar
//      orphaned and either bloating without bound or making the "prev"
//      backup inconsistent on restore. Real disaster recovery here is
//      git (code) + Yjs state (per-doc CRDT) + Railway snapshots, not
//      a second copy on the same volume.
//
//   2. 6 h interval, not 1 h. Doc churn is low, hourly was overkill —
//      every cycle rewrote 1.6 GB even when only a handful of blocks
//      changed. The SQLite online backup API doesn't do incremental
//      copies on this codepath.
//
//   3. Free-space guard. Skip the backup entirely if free space on
//      DATA_DIR is less than 1.5x the live DB size. Better to miss a
//      backup window than to wedge writes on a full volume.
//
//   4. Clean WAL/SHM of the destination before AND after backup.
//      `db.backup()` opens the dest in WAL mode by default, leaving an
//      orphan `-wal` that can grow on subsequent runs. We force the
//      backup file to journal_mode=DELETE post-copy and unlink any
//      stale sidecars that snuck in.
const BACKUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 h
const BACKUP_FILENAME = "collab-docs-backup.db";
const BACKUP_FREE_SPACE_MULTIPLIER = 1.5;

function getFreeBytes(dir: string): number {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unknown — proceed
  }
}

function unlinkIfExists(p: string): number {
  try {
    const size = fs.statSync(p).size;
    fs.unlinkSync(p);
    return size;
  } catch {
    return 0;
  }
}

async function backupDatabase() {
  try {
    persistAllDocs();

    const backupPath = path.join(DATA_DIR, BACKUP_FILENAME);

    let dbSize = 0;
    try { dbSize = fs.statSync(DB_PATH).size; } catch { /* unreadable */ }

    const free = getFreeBytes(DATA_DIR);
    const required = Math.ceil(dbSize * BACKUP_FREE_SPACE_MULTIPLIER);
    if (free < required) {
      console.warn(
        `[backup] skipped: free=${(free / 1e9).toFixed(2)}GB < ` +
        `required=${(required / 1e9).toFixed(2)}GB ` +
        `(dbSize=${(dbSize / 1e9).toFixed(2)}GB × ${BACKUP_FREE_SPACE_MULTIPLIER})`
      );
      return;
    }

    // Wipe stale dest + sidecars from a previous run before copying in.
    unlinkIfExists(backupPath + "-wal");
    unlinkIfExists(backupPath + "-shm");

    await db.backup(backupPath);

    // Force the dest into rollback-journal mode so a -wal can't grow
    // alongside it during the next interval. This is the bit the old
    // implementation missed — that's where the 1.65 GB orphan WAL came
    // from. Open in a fresh handle, set the pragma, close cleanly.
    try {
      const Database = (await import("better-sqlite3")).default;
      const tmp = new Database(backupPath);
      tmp.pragma("journal_mode = DELETE");
      tmp.close();
    } catch (e) {
      console.warn(`[backup] could not normalize journal_mode on backup file: ${e}`);
    }

    // Belt and suspenders: scrub any -wal/-shm that materialized during
    // the backup window.
    unlinkIfExists(backupPath + "-wal");
    unlinkIfExists(backupPath + "-shm");

    const backupSize = (() => {
      try { return fs.statSync(backupPath).size; } catch { return 0; }
    })();
    console.log(
      `[backup] ${(backupSize / 1e9).toFixed(2)}GB written to ${backupPath} ` +
      `at ${new Date().toISOString()}`
    );
  } catch (e) {
    console.error("[backup] failed:", e);
  }
}

// Run backup every 6 h.
setInterval(() => { void backupDatabase(); }, BACKUP_INTERVAL);
// First backup 5 minutes after startup.
setTimeout(() => { void backupDatabase(); }, 5 * 60 * 1000);

const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  console.log(`y-websocket server running on ws://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Database: ${DB_PATH}`);
});
