import { withYDoc, readBlocks, applyOperations } from "@/lib/yjs-api-bridge";

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
 * GET /api/v1/docs/{docId}/append?text=...
 *
 * Append text to a document via a simple GET request.
 * This exists so that AI agents (like ChatGPT) that can only "browse" URLs
 * can still edit documents — they just open this URL.
 *
 * The `text` query parameter contains the markdown to append.
 * URL-encoded, so spaces = %20 or +, newlines = %0A, # = %23, etc.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const url = new URL(request.url);
  const text = url.searchParams.get("text");

  if (!text) {
    return new Response(
      "Missing ?text= parameter.\n\nUsage: GET /api/v1/docs/{docId}/append?text=Hello%20world\n\nUse %0A for newlines, %23 for #.",
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const newBlocks = parseMarkdownLines(text);

  try {
    const result = await withYDoc(docId, (ydoc, fragment) => {
      const existing = readBlocks(fragment);
      const lastId = existing.length > 0 ? existing[existing.length - 1].id : null;

      const ops = [];
      for (let i = newBlocks.length - 1; i >= 0; i--) {
        ops.push({
          type: "insert" as const,
          afterBlockId: lastId,
          block: newBlocks[i],
        });
      }

      return applyOperations(ydoc, fragment, ops);
    });

    // Return a human/AI-readable confirmation page
    const confirmationText = [
      `SUCCESS: Appended ${newBlocks.length} block(s) to document ${docId}.`,
      ``,
      `Text added:`,
      `---`,
      text,
      `---`,
      ``,
      `To read the full document: GET /api/v1/docs/${docId}/text`,
      `To append more text: GET /api/v1/docs/${docId}/append?text=YOUR_TEXT`,
      `To replace all content: GET /api/v1/docs/${docId}/replace?text=YOUR_TEXT`,
      result.errors.length > 0 ? `\nWarnings: ${result.errors.join(", ")}` : "",
    ].join("\n");

    return new Response(confirmationText, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Error appending to document: ${e}`, { status: 500 });
  }
}
