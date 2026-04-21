import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { resolveShareToken, redeemInviteToken } from "@/lib/ws-api";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "PostPaper — document invitation",
    robots: { index: false, follow: false },
  };
}

/**
 * Invite landing. Flow:
 *   1. Resolve the share token → get {docId, role, ownerId}. 404 if unknown.
 *   2. Only editor/commenter tokens are redeemable here; viewer tokens
 *      should use /v/:token (no identity needed).
 *   3. Require sign-in — we need an email to bind to the ACL row.
 *   4. Write the collaborator row, then redirect to /doc/:id where the
 *      normal SSR gate now sees them as a member.
 *
 * Idempotent: re-clicking the link after already joining just redirects to
 * the doc. An owner clicking their own invite link is redirected to the doc
 * without adding themselves to their own collaborator table.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const resolved = await resolveShareToken(token).catch(() => null);
  if (!resolved) notFound();

  if (resolved.role !== "editor" && resolved.role !== "commenter") {
    // A viewer token should take the /v/:token path — it doesn't require
    // sign-in. Redirect so the user doesn't get stuck in a login loop.
    redirect(`/v/${token}`);
  }

  const session = await auth();
  const email = session?.user?.email;

  if (!email) {
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(`/e/${token}`)}`);
  }

  // Owner clicking their own invite link — skip the ACL write, just send
  // them to the doc. Prevents the owner showing up in their own
  // collaborators list and confusing the UI.
  if (resolved.ownerId && resolved.ownerId === email) {
    redirect(`/doc/${resolved.docId}`);
  }

  try {
    await redeemInviteToken(resolved.docId, email, resolved.role, token);
  } catch (err) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-3">Couldn&apos;t accept invitation</h1>
          <p className="text-gray-600 mb-4">
            Something went wrong while adding you to this document.
          </p>
          <p className="text-gray-400 text-sm font-mono break-all mb-6">
            {String(err)}
          </p>
          <a
            href="/dashboard"
            className="inline-block px-4 py-2 bg-black text-white rounded hover:bg-gray-800"
          >
            Back to your documents
          </a>
        </div>
      </div>
    );
  }

  redirect(`/doc/${resolved.docId}`);
}
