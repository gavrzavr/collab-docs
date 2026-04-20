import { auth } from "@/auth";
import {
  createShareToken,
  listShareTokens,
  type ShareRole,
} from "@/lib/ws-api";

export const dynamic = "force-dynamic";

const VALID_ROLES: readonly ShareRole[] = ["viewer", "commenter", "editor"] as const;
function isValidRole(x: unknown): x is ShareRole {
  return typeof x === "string" && (VALID_ROLES as readonly string[]).includes(x);
}

/**
 * POST /api/v1/docs/:docId/share-tokens
 * Body: { role: "viewer" | "commenter" | "editor" }
 *
 * Idempotent: the ws-server returns the existing token for (docId, role)
 * if one already exists.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  const session = await auth();
  const ownerId = session?.user?.email;
  if (!ownerId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { role?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidRole(body.role)) {
    return Response.json(
      { error: "role must be one of viewer|commenter|editor" },
      { status: 400 }
    );
  }

  try {
    const token = await createShareToken(docId, body.role, ownerId);
    return Response.json(token, { status: 201 });
  } catch (e) {
    const msg = String(e);
    // ws-server returns 403 for owner mismatch, 404 for missing doc;
    // surface those cleanly.
    if (msg.includes(" 403")) {
      return Response.json({ error: "Not the owner" }, { status: 403 });
    }
    if (msg.includes(" 404")) {
      return Response.json({ error: "Doc not found" }, { status: 404 });
    }
    return Response.json({ error: "Failed", details: msg }, { status: 500 });
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const session = await auth();
  const ownerId = session?.user?.email;
  if (!ownerId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const data = await listShareTokens(docId, ownerId);
    return Response.json(data);
  } catch (e) {
    return Response.json(
      { error: "Failed", details: String(e) },
      { status: 500 }
    );
  }
}
