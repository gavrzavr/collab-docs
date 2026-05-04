import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const WS_API_URL =
  process.env.WS_API_URL ||
  process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") ||
  "http://localhost:1234";

/**
 * POST /api/v1/docs/:id/rename — change a document's title.
 *
 * Body: { title: string }. The actual write is to the FIRST H1 inside
 * the document (extractTitle's source of truth). Live editors see the
 * change via Yjs sync; the dashboard's documents.title column updates
 * after the post-write persistNow() flush.
 *
 * Owner OR editor — collaborators with edit permission can rename a
 * shared doc since the title is just a heading they could edit anyway
 * by typing into the H1.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const internalSecret = process.env.INTERNAL_SECRET;
  if (!internalSecret) {
    return Response.json({ error: "Server is not configured to forward to ws-server" }, { status: 500 });
  }

  let body: { title?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const title = (body.title || "").trim();
  if (!title) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }
  if (title.length > 200) {
    return Response.json({ error: "title too long (max 200 chars)" }, { status: 400 });
  }

  try {
    const wsRes = await fetch(`${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/rename`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ email, title }),
    });
    const data = await wsRes.json().catch(() => ({}));
    if (!wsRes.ok) {
      return Response.json(data, { status: wsRes.status });
    }
    return Response.json(data);
  } catch (e) {
    return Response.json(
      { error: "Failed to rename", details: String(e) },
      { status: 502 }
    );
  }
}
