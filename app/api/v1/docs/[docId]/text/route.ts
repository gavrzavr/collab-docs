import { withYDoc, readBlocks, applyOperations } from "@/lib/yjs-api-bridge";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/docs/{docId}/text
 * Returns the document content as plain markdown text.
 * Simple and universal — any AI can read this.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  try {
    const blocks = await withYDoc(docId, (_ydoc, fragment) => {
      return readBlocks(fragment);
    });

    const lines: string[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          const level = (block.props?.level as number) || 1;
          lines.push("#".repeat(level) + " " + block.text);
          break;
        }
        case "bulletListItem":
          lines.push("- " + block.text);
          break;
        case "numberedListItem":
          lines.push("1. " + block.text);
          break;
        default:
          lines.push(block.text);
      }
    }

    return new Response(lines.join("\n"), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Error reading document: ${e}`, { status: 500 });
  }
}

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
 * PUT /api/v1/docs/{docId}/text
 * Replace the entire document with plain text/markdown.
 * Lines starting with # → headings, - → bullets, 1. → numbered lists.
 * Everything else → paragraphs.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const text = await request.text();
  const newBlocks = parseMarkdownLines(text);

  try {
    const result = await withYDoc(docId, (ydoc, fragment) => {
      // Read existing blocks
      const existing = readBlocks(fragment);

      // Build operations: delete all existing, then insert new in reverse at position 0
      const ops = [];

      // Delete all existing blocks (in reverse order to keep indices stable)
      for (let i = existing.length - 1; i >= 0; i--) {
        ops.push({ type: "delete" as const, blockId: existing[i].id });
      }

      // Insert new blocks in reverse order at position 0 (beginning)
      // so they end up in correct order
      for (let i = newBlocks.length - 1; i >= 0; i--) {
        ops.push({
          type: "insert" as const,
          afterBlockId: null,
          block: newBlocks[i],
        });
      }

      return applyOperations(ydoc, fragment, ops);
    });

    return Response.json({
      success: true,
      blocksWritten: newBlocks.length,
      applied: result.applied,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (e) {
    return new Response(`Error writing document: ${e}`, { status: 500 });
  }
}

/**
 * POST /api/v1/docs/{docId}/text
 * Append text to the end of the document (don't delete existing content).
 * Same markdown parsing as PUT.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const text = await request.text();
  const newBlocks = parseMarkdownLines(text);

  try {
    const result = await withYDoc(docId, (ydoc, fragment) => {
      // Read existing to find last block ID
      const existing = readBlocks(fragment);
      const lastId = existing.length > 0 ? existing[existing.length - 1].id : null;

      // Insert all new blocks after the last one
      // But since we can only insert after a known ID, and new blocks don't have IDs yet,
      // we insert them in reverse at position "after last"
      // Actually — insert first block after lastId, rest after null (beginning) won't work
      // Better: insert all in forward order, each after the previous "last"
      // Since we don't know generated IDs, insert all after lastId — they'll all go to same position
      // The simplest: insert in reverse after lastId
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

    return Response.json({
      success: true,
      blocksAppended: newBlocks.length,
      applied: result.applied,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (e) {
    return new Response(`Error appending to document: ${e}`, { status: 500 });
  }
}
