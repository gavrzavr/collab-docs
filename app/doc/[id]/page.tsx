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
          <h3>How to read and edit this document (no auth required):</h3>

          <h4>EASY WAY — just open these URLs (works with any AI that can browse):</h4>

          <p>1. Read this document:</p>
          <code>{baseUrl}/api/v1/docs/{id}/text</code>

          <p>2. Append text to end of document — open this URL (replace YOUR_TEXT):</p>
          <code>{baseUrl}/api/v1/docs/{id}/append?text=YOUR_TEXT_HERE</code>
          <p>Use %0A for newlines, %23 for #. Example:</p>
          <code>{baseUrl}/api/v1/docs/{id}/append?text=Hello%20from%20AI%0AThis%20is%20a%20new%20paragraph</code>

          <p>3. Replace entire document — open this URL:</p>
          <code>{baseUrl}/api/v1/docs/{id}/replace?text=YOUR_NEW_CONTENT</code>
          <p>Example with heading and bullets:</p>
          <code>{baseUrl}/api/v1/docs/{id}/replace?text=%23%20My%20Title%0A-%20First%20item%0A-%20Second%20item</code>

          <h4>ADVANCED WAY — POST/PUT requests (for agents with HTTP capabilities):</h4>

          <p>Append (POST body = plain text/markdown):</p>
          <code>POST {baseUrl}/api/v1/docs/{id}/text</code>

          <p>Replace all (PUT body = plain text/markdown):</p>
          <code>PUT {baseUrl}/api/v1/docs/{id}/text</code>

          <p>Markdown format: # = heading, - = bullet, 1. = numbered list, plain text = paragraph.</p>
        </section>
      </article>
    </>
  );
}
