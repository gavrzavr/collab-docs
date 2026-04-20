import { notFound } from "next/navigation";
import type { Metadata } from "next";
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
