import { nanoid } from "nanoid";
import { auth } from "@/auth";
import { createDocumentMeta } from "@/lib/ws-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Require an authenticated session.
  //
  // Anonymous creation used to be allowed (a guest doc with owner_id=NULL).
  // After the owner+invited migration (§14 in the project doc) those guest
  // docs became unreachable — /doc/:id requires sign-in, ACL has no owner,
  // every visitor lands on "No access". So the endpoint did nothing useful
  // for real users while letting any unauthenticated client batch-create
  // thousands of empty rows. Two attacks happened so far (1545 spam docs
  // on 2026-04-22 and 8184 on 2026-04-26 in 4 minutes — that's ~30 ins/sec
  // with title="spam-N"). Closing the door is the right move.
  const session = await auth().catch(() => null);
  if (!session?.user?.email) {
    return Response.json(
      { error: "Sign in to create a document." },
      { status: 401 }
    );
  }
  const ownerId = session.user.email;

  const id = nanoid(10);
  let title = "Untitled";

  try {
    const body = await request.json();
    if (body.title) title = body.title;
  } catch {
    // No body or invalid JSON — that's fine
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
