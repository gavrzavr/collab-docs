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
        <h1>CollabDocs — Collaborative Document</h1>
        <p>This is a CollabDocs document. CollabDocs is a collaborative document editor where humans and AI agents can work together in real-time.</p>

        <section id="document-content">
          <h2>Document content:</h2>
          <pre>{documentText || "(empty document)"}</pre>
        </section>

        <section id="how-to-edit">
          <h2>How AI can edit this document</h2>

          <h3>For ChatGPT users:</h3>
          <p>ChatGPT cannot edit CollabDocs documents from a regular chat. To enable editing, use the official CollabDocs GPT:</p>
          <p><strong>Step 1:</strong> Open this link: https://chatgpt.com/g/g-69db9af365688191b83f0ede5bb1691c-collabdocs</p>
          <p><strong>Step 2:</strong> In the CollabDocs GPT chat, send the link to your document, for example: "Прочитай документ {baseUrl}/doc/{id} и добавь пару предложений"</p>
          <p><strong>Step 3:</strong> The GPT will read the document and edit it directly. Changes appear instantly in the browser.</p>
          <p>That is it — no API keys, no setup. Just open the CollabDocs GPT and paste your document link.</p>

          <h3>For Claude users:</h3>
          <p>The best way to use CollabDocs with Claude is via the Remote MCP Server. This gives Claude full read/write access to all CollabDocs documents.</p>
          <p><strong>Quick setup (one time, takes 30 seconds):</strong></p>
          <p>1. Open Claude Settings → MCP Servers (or Claude Code settings)</p>
          <p>2. Add a new Remote MCP server with URL: https://collab-docs-production.up.railway.app/mcp</p>
          <p>3. Done! Now just paste any CollabDocs link in chat and Claude will read and edit it.</p>
          <p><strong>After setup, just tell Claude:</strong></p>
          <p>"Read document {baseUrl}/doc/{id}" — Claude reads it via MCP</p>
          <p>"Write a summary into {baseUrl}/doc/{id}" — Claude edits it in real-time</p>
          <p>Changes appear instantly in the browser for all connected users.</p>
          <p><strong>Alternative (no setup):</strong> Claude can also use the REST API directly:</p>
          <p>Read: GET {baseUrl}/api/v1/docs/{id}/text</p>
          <p>Append: POST {baseUrl}/api/v1/docs/{id}/text with JSON body {`{"content": "text"}`}</p>
          <p>Replace: PUT {baseUrl}/api/v1/docs/{id}/text with JSON body {`{"content": "text"}`}</p>

          <h3>For any other AI agent:</h3>
          <p>API endpoints (no authentication required):</p>
          <p>Read document: GET {baseUrl}/api/v1/docs/{id}/text — returns JSON with "content" field containing markdown text.</p>
          <p>Append text: POST {baseUrl}/api/v1/docs/{id}/text — send JSON body: {`{"content": "your markdown text"}`}. Use \\n for newlines, # for headings, - for bullets.</p>
          <p>Replace all: PUT {baseUrl}/api/v1/docs/{id}/text — same format as POST, replaces entire document.</p>
          <p>Example curl command: curl -X POST {baseUrl}/api/v1/docs/{id}/text -H "Content-Type: application/json" -d '{`{"content": "# Heading\\nParagraph text\\n- Bullet"}`}'</p>
        </section>
      </article>
    </>
  );
}
