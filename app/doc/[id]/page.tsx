import { withYDoc, readBlocks } from "@/lib/yjs-api-bridge";
import DocClient from "./DocClient";

const BASE_URL = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
}

function blocksToText(blocks: Block[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "heading": {
        const level = (block.props?.level as number) || 1;
        return "#".repeat(level) + " " + block.text;
      }
      case "bulletListItem":
        return "- " + block.text;
      case "numberedListItem":
        return "1. " + block.text;
      default:
        return block.text;
    }
  }).join("\n");
}

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Fetch document content server-side for AI agents
  let documentText = "";
  let blocks: Block[] = [];
  try {
    blocks = await withYDoc(id, (_ydoc, fragment) => {
      return readBlocks(fragment);
    });
    documentText = blocksToText(blocks);
  } catch {
    // Document might not exist yet — that's fine
  }

  const baseUrl = BASE_URL;

  return (
    <>
      {/* Interactive editor (client component) */}
      <DocClient id={id} initialBlocks={blocks} />

      {/* Server-rendered content for AI agents — visible in initial HTML */}
      <div id="ai-collab-doc" style={{ display: "none" }} data-doc-id={id} data-api-base={baseUrl}>
        <h2>CollabDocs — AI Agent Instructions</h2>
        <p>This is a real-time collaborative document. You can read and edit it using simple HTTP requests. No authentication required.</p>

        <h3>Current document content:</h3>
        <pre id="doc-content">{documentText || "(empty document)"}</pre>

        <h3>API Endpoints:</h3>

        <h4>Read document (plain text)</h4>
        <pre>GET {baseUrl}/api/v1/docs/{id}/text</pre>

        <h4>Append text to document</h4>
        <pre>POST {baseUrl}/api/v1/docs/{id}/text</pre>
        <p>Body: plain text or markdown. Lines starting with # = headings, - = bullet lists, 1. = numbered lists.</p>

        <h4>Replace entire document</h4>
        <pre>PUT {baseUrl}/api/v1/docs/{id}/text</pre>
        <p>Same format as POST, but replaces all content.</p>

        <h4>Example:</h4>
        <pre>{`curl ${baseUrl}/api/v1/docs/${id}/text`}</pre>
        <pre>{`curl -X POST ${baseUrl}/api/v1/docs/${id}/text \\
  -H "Content-Type: text/plain" \\
  -d '# My heading
Some paragraph text
- Bullet point'`}</pre>
      </div>
    </>
  );
}
