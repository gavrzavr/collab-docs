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

    // Return both JSON and plain text — JSON for ChatGPT Actions, plain text in a field
    const plainText = lines.join("\n");
    return Response.json({
      content: plainText,
      blockCount: blocks.length,
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
/** Extract text from request body — supports plain text, JSON {"content":"..."}, or JSON {"text":"..."} */
async function extractText(request: Request): Promise<{ text: string; debug: string }> {
  const raw = await request.text();
  // Try to parse as JSON (ChatGPT sends JSON with content or text field)
  try {
    const json = JSON.parse(raw);
    if (typeof json === "string") return { text: json, debug: `json-string, raw=${raw.substring(0, 200)}` };
    if (json.content) return { text: json.content, debug: `json.content, raw=${raw.substring(0, 200)}` };
    if (json.text) return { text: json.text, debug: `json.text, raw=${raw.substring(0, 200)}` };
    if (json.body) return { text: json.body, debug: `json.body, raw=${raw.substring(0, 200)}` };
    if (json.markdown) return { text: json.markdown, debug: `json.markdown, raw=${raw.substring(0, 200)}` };
    // Unknown JSON structure — return stringified
    return { text: JSON.stringify(json), debug: `json-unknown, keys=${Object.keys(json).join(",")}, raw=${raw.substring(0, 200)}` };
  } catch {
    // Not JSON — treat as plain text
  }
  return { text: raw, debug: `plain-text, raw=${raw.substring(0, 200)}` };
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const { text, debug } = await extractText(request);
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
      debug,
      extractedText: text.substring(0, 200),
      blocks: newBlocks.map(b => ({ type: b.type, text: b.text.substring(0, 50) })),
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
  const { text, debug } = await extractText(request);
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
      debug,
      extractedText: text.substring(0, 200),
      blocks: newBlocks.map(b => ({ type: b.type, text: b.text.substring(0, 50) })),
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (e) {
    return new Response(`Error appending to document: ${e}`, { status: 500 });
  }
}
