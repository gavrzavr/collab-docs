import { nanoid } from "nanoid";
import { auth } from "@/auth";
import { createDocumentMeta } from "@/lib/ws-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const id = nanoid(10);
  let title = "Untitled";

  try {
    const body = await request.json();
    if (body.title) title = body.title;
  } catch {
    // No body or invalid JSON — that's fine
  }

  // If user is authenticated, set owner
  let ownerId: string | null = null;
  try {
    const session = await auth();
    if (session?.user?.email) {
      ownerId = session.user.email;
    }
  } catch {
    // Not authenticated — that's fine, guest doc
  }

  // Register document metadata on WS server
  try {
    await createDocumentMeta(id, title, ownerId);
  } catch {
    // WS server might be unreachable, doc still works via Yjs
  }

  return Response.json(
    {
      id,
      title,
      url: `/doc/${id}`,
      createdAt: new Date().toISOString(),
    },
    { status: 201 }
  );
}
