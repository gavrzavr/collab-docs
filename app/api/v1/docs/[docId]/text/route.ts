import { readDocContent, appendDocContent, replaceDocContent } from "@/lib/ws-api";
import { authorizeDocAccess } from "@/lib/doc-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/docs/{docId}/text
 * Read document content — proxied to WS server
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const authz = await authorizeDocAccess(request, docId, "read");
  if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });
  try {
    const result = await readDocContent(docId);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

/** Extract text from request body — supports plain text, JSON {"content":"..."}, etc */
async function extractText(request: Request): Promise<string> {
  const raw = await request.text();
  try {
    const json = JSON.parse(raw);
    if (typeof json === "string") return json;
    if (json.content) return json.content;
    if (json.text) return json.text;
    if (json.body) return json.body;
    if (json.markdown) return json.markdown;
    return JSON.stringify(json);
  } catch {
    // Not JSON — treat as plain text
  }
  return raw;
}

/**
 * POST /api/v1/docs/{docId}/text
 * Append text — proxied to WS server
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const authz = await authorizeDocAccess(request, docId, "write");
  if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });
  const text = await extractText(request);

  if (!text.trim()) {
    return Response.json({ error: "Empty content" }, { status: 400 });
  }

  try {
    const result = await appendDocContent(docId, text);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * PUT /api/v1/docs/{docId}/text
 * Replace document — proxied to WS server
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const authz = await authorizeDocAccess(request, docId, "write");
  if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });
  const text = await extractText(request);

  if (!text.trim()) {
    return Response.json({ error: "Empty content" }, { status: 400 });
  }

  try {
    const result = await replaceDocContent(docId, text);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
