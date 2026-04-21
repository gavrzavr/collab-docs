import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { withYDoc, readBlocks } from "@/lib/yjs-api-bridge";
import { resolveShareToken } from "@/lib/ws-api";
import DocClient from "@/app/doc/[id]/DocClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "PostPaper — shared document",
    robots: { index: false, follow: false },
  };
}

interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
}

export default async function ViewerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const resolved = await resolveShareToken(token).catch(() => null);
  if (!resolved) {
    notFound();
  }

  // If the signed-in user owns this doc, redirect them to the full
  // editor route. Permissions should follow identity, not URL — an
  // owner shouldn't be locked out of their own doc just because they
  // clicked the view-link they sent to someone else.
  const session = await auth();
  const email = session?.user?.email;
  if (email && resolved.ownerId && email === resolved.ownerId) {
    redirect(`/doc/${resolved.docId}`);
  }

  // Fetch initial content for the server-rendered preview.
  let initialBlocks: Block[] = [];
  try {
    initialBlocks = await withYDoc(resolved.docId, (_ydoc, fragment) => {
      return readBlocks(fragment);
    });
  } catch {
    // non-fatal — client will still mount and Yjs will sync
  }

  return (
    <DocClient
      id={resolved.docId}
      initialBlocks={initialBlocks}
      shareToken={token}
      role={resolved.role}
    />
  );
}
