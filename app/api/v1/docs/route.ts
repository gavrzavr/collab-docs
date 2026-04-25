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

  // Register document metadata on WS server.
  //
  // We MUST NOT swallow this error. The `documents` row carries
  // `owner_id` — without it, /doc/:id has no record of who created the
  // doc and the SSR access check shows "No access to this document".
  // The client gets redirected into a phantom doc with no way back.
  //
  // If ws-server is briefly unreachable (Railway redeploy, network
  // flake), we'd rather return 502 and let the user retry than ship a
  // broken redirect.
  try {
    await createDocumentMeta(id, title, ownerId);
  } catch (err) {
    console.error("[POST /api/v1/docs] createDocumentMeta failed:", err);
    return Response.json(
      {
        error:
          "Failed to register the new document with the sync server. " +
          "This is usually transient — please try again in a moment.",
      },
      { status: 502 }
    );
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
