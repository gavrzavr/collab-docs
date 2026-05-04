import { withYDoc, readBlocks, applyOperations, type Operation } from "@/lib/yjs-api-bridge";
import { authorizeDocAccess } from "@/lib/doc-auth";
import { auth } from "@/auth";
import { del } from "@vercel/blob";

export const dynamic = "force-dynamic";

const WS_API_URL =
  process.env.WS_API_URL ||
  process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") ||
  "http://localhost:1234";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  const authz = await authorizeDocAccess(request, docId, "read");
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  try {
    const content = await withYDoc(docId, (_ydoc, fragment) => {
      return readBlocks(fragment);
    });

    return Response.json({
      id: docId,
      title: "Untitled",
      content,
    });
  } catch (e) {
    return Response.json(
      { error: "Failed to read document", details: String(e) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/docs/:id — owner-only document delete with cascade.
 *
 * Auth via NextAuth session, then proxies to ws-server with the
 * x-internal-secret header. ws-server independently re-checks
 * ownership against documents.owner_id (defense-in-depth) before
 * cascading deletes across documents/yjs_documents/events/share_tokens/
 * document_collaborators and evicting the in-memory entry.
 */
export async function DELETE(
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
  try {
    const wsRes = await fetch(`${WS_API_URL}/api/docs/${encodeURIComponent(docId)}/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ email }),
    });
    const data = (await wsRes.json().catch(() => ({}))) as {
      orphanedUploadUrls?: string[];
      [k: string]: unknown;
    };
    if (!wsRes.ok) {
      return Response.json(data, { status: wsRes.status });
    }

    // Best-effort blob cleanup. Failure here doesn't fail the delete —
    // the SQLite row is already gone, and the orphan-GC cron will
    // catch any stragglers after the 7-day grace window.
    if (data.orphanedUploadUrls && data.orphanedUploadUrls.length > 0) {
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (blobToken) {
        try {
          await del(data.orphanedUploadUrls, { token: blobToken });
        } catch (err) {
          console.error("[DELETE doc] blob cleanup failed:", err);
        }
      }
    }

    return Response.json(data);
  } catch (e) {
    return Response.json(
      { error: "Failed to delete", details: String(e) },
      { status: 502 }
    );
  }
}

/**
 * POST /api/v1/docs/:id/rename — only the doc's first H1 is rewritten,
 * which is the source of truth for `documents.title` (extractTitle).
 * Owner or editor only.
 */
// Note: rename is at /api/v1/docs/:id/rename — see neighbouring file.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  const authz = await authorizeDocAccess(request, docId, "write");
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  let body: { author?: string; operations: Operation[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.operations || !Array.isArray(body.operations)) {
    return Response.json({ error: "Missing operations array" }, { status: 400 });
  }

  try {
    const result = await withYDoc(docId, (ydoc, fragment) => {
      return applyOperations(ydoc, fragment, body.operations);
    });

    if (result.errors.length > 0) {
      return Response.json(
        {
          success: false,
          appliedOperations: result.applied,
          errors: result.errors,
        },
        { status: 400 }
      );
    }

    return Response.json({
      success: true,
      appliedOperations: result.applied,
    });
  } catch (e) {
    return Response.json(
      { error: "Failed to apply operations", details: String(e) },
      { status: 500 }
    );
  }
}
