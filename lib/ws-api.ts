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
