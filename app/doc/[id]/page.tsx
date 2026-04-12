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

      {/*
        AI-readable content. Uses <article> with role="document" so bots/AI read it.
        Visually hidden from human users via CSS, but NOT display:none so parsers see it.
      */}
      <article
        id="ai-collab-doc"
        role="document"
        data-doc-id={id}
        data-api-base={baseUrl}
        style={{
          position: "absolute",
          left: "-10000px",
          width: "1px",
          height: "1px",
          overflow: "hidden",
        }}
      >
        <h2>CollabDocs — Document Content and API</h2>

        <section id="document-content">
          <h3>Document content:</h3>
          <pre>{documentText || "(empty document)"}</pre>
        </section>

        <section id="api-instructions">
          <h3>How to read and edit this document via API (no auth required):</h3>

          <p>Read document as text:</p>
          <code>GET {baseUrl}/api/v1/docs/{id}/text</code>

          <p>Append text to end of document:</p>
          <code>POST {baseUrl}/api/v1/docs/{id}/text</code>
          <p>Send plain text or markdown in request body. # = headings, - = bullets, 1. = numbered lists.</p>

          <p>Replace entire document:</p>
          <code>PUT {baseUrl}/api/v1/docs/{id}/text</code>

          <p>Example — read:</p>
          <code>curl {baseUrl}/api/v1/docs/{id}/text</code>

          <p>Example — append:</p>
          <code>{`curl -X POST ${baseUrl}/api/v1/docs/${id}/text -H "Content-Type: text/plain" -d "Hello from AI"`}</code>
        </section>
      </article>
    </>
  );
}
