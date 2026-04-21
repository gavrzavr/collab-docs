import { withYDoc, readBlocks, applyOperations } from "@/lib/yjs-api-bridge";
import { authorizeDocAccess } from "@/lib/doc-auth";

export const dynamic = "force-dynamic";

function parseMarkdownLines(text: string): Array<{ type: string; text: string }> {
  const lines = text.split("\n");
  const blocks: Array<{ type: string; text: string }> = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2] });
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      blocks.push({ type: "bulletListItem", text: trimmed.slice(2) });
    } else if (/^\d+\.\s/.test(trimmed)) {
      blocks.push({ type: "numberedListItem", text: trimmed.replace(/^\d+\.\s/, "") });
    } else {
      blocks.push({ type: "paragraph", text: trimmed });
    }
  }

  return blocks;
}

/**
 * GET /api/v1/docs/{docId}/replace?text=...
 *
 * Replace entire document content via a simple GET request.
 * Designed for AI agents that can only browse URLs (like ChatGPT).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const authz = await authorizeDocAccess(request, docId, "write");
  if (!authz.ok) {
    return new Response(authz.error, {
      status: authz.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const url = new URL(request.url);
  const text = url.searchParams.get("text");

  if (!text) {
    return new Response(
      "Missing ?text= parameter.\n\nUsage: GET /api/v1/docs/{docId}/replace?text=New%20content\n\nUse %0A for newlines, %23 for #.",
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const newBlocks = parseMarkdownLines(text);

  try {
    const result = await withYDoc(docId, (ydoc, fragment) => {
      const existing = readBlocks(fragment);

      const ops = [];

      // Delete all existing blocks
      for (let i = existing.length - 1; i >= 0; i--) {
        ops.push({ type: "delete" as const, blockId: existing[i].id });
      }

      // Insert new blocks
      for (let i = newBlocks.length - 1; i >= 0; i--) {
        ops.push({
          type: "insert" as const,
          afterBlockId: null,
          block: newBlocks[i],
        });
      }

      return applyOperations(ydoc, fragment, ops);
    });

    const confirmationText = [
      `SUCCESS: Replaced document ${docId} with ${newBlocks.length} block(s).`,
      ``,
      `New content:`,
      `---`,
      text,
      `---`,
      ``,
      `To read the document: GET /api/v1/docs/${docId}/text`,
      `To append more text: GET /api/v1/docs/${docId}/append?text=YOUR_TEXT`,
      result.errors.length > 0 ? `\nWarnings: ${result.errors.join(", ")}` : "",
    ].join("\n");

    return new Response(confirmationText, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Error replacing document: ${e}`, { status: 500 });
  }
}
