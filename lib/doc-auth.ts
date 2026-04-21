import { auth } from "@/auth";
import { getDocAccess, resolveShareToken, type ShareRole, type DocAccess } from "@/lib/ws-api";

export type AccessKind = "read" | "comment" | "write";

export interface AuthorizedDocAccess {
  kind: "session" | "share-token";
  /** Canonical access string describing the caller's power on this doc. */
  access: DocAccess | ShareRole;
}

/**
 * Resolve whether the caller may perform `need` on `docId`.
 *
 * Accepted auth paths:
 *   1. NextAuth session → membership lookup (owner/editor/commenter).
 *   2. `?token=` query param → share-token lookup (viewer/commenter/editor).
 *
 * A call that doesn't match either returns `null`. Callers should turn that
 * into the appropriate HTTP status (401 if no session at all, 403 if signed
 * in but not a member).
 */
export async function authorizeDocAccess(
  request: Request,
  docId: string,
  need: AccessKind
): Promise<
  | { ok: true; value: AuthorizedDocAccess }
  | { ok: false; status: 401 | 403 | 404; error: string }
> {
  // Path 1 — share-token via ?token=. Cheap, stateless, works for external
  // tools and for the ChatGPT / browser-URL AI flow.
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("token");
  if (shareToken) {
    const resolved = await resolveShareToken(shareToken).catch(() => null);
    if (!resolved) return { ok: false, status: 404, error: "Invalid share token" };
    if (resolved.docId !== docId) {
      return { ok: false, status: 403, error: "Share token is for a different document" };
    }
    if (!canDo(resolved.role, need)) {
      return { ok: false, status: 403, error: `Share token role (${resolved.role}) cannot ${need}` };
    }
    return { ok: true, value: { kind: "share-token", access: resolved.role } };
  }

  // Path 2 — signed-in session. Require membership.
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { ok: false, status: 401, error: "Not authenticated" };

  const resolved = await getDocAccess(docId, email).catch(() => null);
  if (!resolved || !resolved.access) {
    return { ok: false, status: 403, error: "Not a collaborator on this document" };
  }
  if (!canDo(resolved.access, need)) {
    return { ok: false, status: 403, error: `Role (${resolved.access}) cannot ${need}` };
  }
  return { ok: true, value: { kind: "session", access: resolved.access } };
}

function canDo(role: DocAccess | ShareRole, need: AccessKind): boolean {
  const canWrite = role === "owner" || role === "editor";
  const canComment = canWrite || role === "commenter";
  const canRead = canComment || role === "viewer";
  switch (need) {
    case "read": return canRead;
    case "comment": return canComment;
    case "write": return canWrite;
  }
}
