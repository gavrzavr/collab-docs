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
