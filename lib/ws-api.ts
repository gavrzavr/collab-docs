/** Helper to call the WS server's HTTP API for document metadata */

const WS_API_URL = process.env.WS_API_URL || process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") || "http://localhost:1234";

export async function createDocumentMeta(id: string, title: string, ownerId: string | null) {
  const res = await fetch(`${WS_API_URL}/api/docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title, ownerId }),
  });
  return res.json();
}

export async function listUserDocuments(ownerId: string): Promise<{
  documents: Array<{
    id: string;
    title: string;
    owner_id: string;
    created_at: string;
    updated_at: string;
  }>;
}> {
  const res = await fetch(`${WS_API_URL}/api/docs?ownerId=${encodeURIComponent(ownerId)}`);
  return res.json();
}

/** Read document content as markdown text via WS server */
export async function readDocContent(docId: string): Promise<{ content: string }> {
  const res = await fetch(`${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/content`);
  return res.json();
}

/** Append text to document via WS server */
export async function appendDocContent(docId: string, content: string): Promise<{ success: boolean; blocksAdded: number }> {
  const res = await fetch(`${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

/** Replace entire document content via WS server */
export async function replaceDocContent(docId: string, content: string): Promise<{ success: boolean; blocksWritten: number }> {
  const res = await fetch(`${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

// ─── Admin analytics ────────────────────────────────────────────────
//
// Shape mirrors `AdminStats` in server/ws-server.ts. We duplicate the
// type definition here (rather than importing across the process
// boundary) so the Next.js build doesn't pull ws-server sources.

export interface AdminStats {
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
  daily: Array<{
    date: string;
    newDocs: number;
    activeDocs: number;
    newUsers: number;
    activeUsers: number;
    aiCalls: number;
  }>;
  toolBreakdown: Array<{ kind: string; count: number }>;
  topDocs: Array<{
    doc_id: string;
    owner_id: string | null;
    title: string | null;
    ai_calls: number;
    last_edited: string | null;
  }>;
  cohorts: {
    weeks: string[];
    rows: Array<{ cohort: string; size: number; retained: number[] }>;
  };
  activationFunnel: {
    usersSignedUp: number;
    usersWithEdits: number;
    usersWithAi: number;
  };
}

// ─── Share tokens ────────────────────────────────────────────────────
//
// Tokens are short URL-safe strings that grant a specific role on a doc
// without requiring the recipient to have an account. The ws-server owns
// the table; these helpers are just a thin HTTP wrapper for the Next.js
// layer.

export type ShareRole = "viewer" | "commenter" | "editor";

export interface ShareToken {
  token: string;
  role: ShareRole;
  created_at: string;
}

/** Mint (or fetch existing — idempotent per (docId, role)) a share token. */
export async function createShareToken(
  docId: string,
  role: ShareRole,
  ownerId: string
): Promise<{ token: string; role: ShareRole; created_at: string }> {
  const res = await fetch(`${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/share-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, ownerId }),
  });
  if (!res.ok) {
    throw new Error(`createShareToken failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function listShareTokens(
  docId: string,
  ownerId: string
): Promise<{ tokens: ShareToken[] }> {
  const res = await fetch(
    `${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/share-tokens?ownerId=${encodeURIComponent(ownerId)}`
  );
  if (!res.ok) {
    throw new Error(`listShareTokens failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Public resolve — used by /v/[token] to discover the doc id. */
export async function resolveShareToken(
  token: string
): Promise<{ docId: string; role: ShareRole; ownerId: string | null } | null> {
  const res = await fetch(`${WS_API_URL}/api/share-tokens/${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`resolveShareToken failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ─── Collaborator ACL (owner + invited model) ───────────────────────

export type DocAccess = "owner" | "editor" | "commenter";

/** Resolve (docId, email) -> role. null means no access. */
export async function getDocAccess(
  docId: string,
  email: string
): Promise<{ docId: string; access: DocAccess | null; ownerId: string | null } | null> {
  const res = await fetch(
    `${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/access?email=${encodeURIComponent(email)}`,
    { cache: "no-store" }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDocAccess failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Redeem an invite token: add `email` to the doc's ACL with the token's role. */
export async function redeemInviteToken(
  docId: string,
  email: string,
  role: "editor" | "commenter",
  viaToken: string
): Promise<{ docId: string; email: string; role: string }> {
  const res = await fetch(
    `${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/collaborators`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role, viaToken }),
    }
  );
  if (!res.ok) throw new Error(`redeemInviteToken failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Owner-only: list collaborators for a doc. */
export async function listCollaborators(
  docId: string,
  ownerId: string
): Promise<{ collaborators: Array<{ user_email: string; role: string; granted_at: string }> }> {
  const res = await fetch(
    `${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/collaborators?ownerId=${encodeURIComponent(ownerId)}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`listCollaborators failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Owner-only: remove a collaborator. */
export async function removeCollaborator(
  docId: string,
  email: string,
  ownerId: string
): Promise<void> {
  const res = await fetch(
    `${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/collaborators/${encodeURIComponent(email)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId }),
    }
  );
  if (!res.ok) throw new Error(`removeCollaborator failed: ${res.status} ${await res.text()}`);
}

export async function revokeShareToken(token: string, ownerId: string): Promise<void> {
  const res = await fetch(`${WS_API_URL}/api/share-tokens/${encodeURIComponent(token)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerId }),
  });
  if (!res.ok) {
    throw new Error(`revokeShareToken failed: ${res.status} ${await res.text()}`);
  }
}

// ─── MCP API keys ────────────────────────────────────────────────────
//
// Per-user bearer credential for the PostPaper MCP server. The Next.js
// layer authenticates the user via NextAuth and forwards the verified
// email; ws-server additionally requires INTERNAL_SECRET because
// minting a key for anyone else's email would be a straight-up
// account-takeover vector.

export interface McpKeyInfo {
  hasKey: boolean;
  /** Plaintext key if one exists. Shown on the dashboard so the user can
   *  re-copy it into additional MCP clients — this is our product call
   *  over GitHub-PAT-style "show once". */
  key: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

function mcpKeyHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.INTERNAL_SECRET) {
    h["x-internal-secret"] = process.env.INTERNAL_SECRET;
  }
  return h;
}

/** Mint (or rotate) an MCP API key for `email`. Returns the plaintext
 *  key once — it's unrecoverable afterwards. */
export async function mintMcpKey(
  email: string
): Promise<{ key: string; createdAt: string }> {
  const res = await fetch(`${WS_API_URL}/api/me/mcp-key`, {
    method: "POST",
    headers: mcpKeyHeaders(),
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`mintMcpKey failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Look up whether `email` currently has a key (no plaintext). */
export async function getMcpKeyInfo(email: string): Promise<McpKeyInfo> {
  const res = await fetch(
    `${WS_API_URL}/api/me/mcp-key?email=${encodeURIComponent(email)}`,
    { method: "GET", headers: mcpKeyHeaders(), cache: "no-store" }
  );
  if (!res.ok) throw new Error(`getMcpKeyInfo failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Revoke `email`'s key. Idempotent — returns { revoked: false } when
 *  there was no key to begin with. */
export async function revokeMcpKey(email: string): Promise<{ revoked: boolean }> {
  const res = await fetch(`${WS_API_URL}/api/me/mcp-key`, {
    method: "DELETE",
    headers: mcpKeyHeaders(),
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`revokeMcpKey failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function fetchAdminStats(days: number = 30): Promise<AdminStats> {
  const res = await fetch(`${WS_API_URL}/api/stats?days=${days}`, {
    // Never cache stats — always want a fresh number.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Stats fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
