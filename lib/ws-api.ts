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
