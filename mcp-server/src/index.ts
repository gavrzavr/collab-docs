#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE_URL = process.env.API_BASE_URL || "https://postpaper.co";

function extractDocId(docUrl: string): string {
  // Accept full URL like http://host/doc/abc123 or just the ID
  const match = docUrl.match(/\/doc\/([^/?#]+)/);
  if (match) return match[1];
  // If it looks like a plain ID, use it directly
  return docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
}

const server = new McpServer({
  name: "collab-docs",
  version: "0.2.0",
});

server.tool(
  "read_document",
  "Read the full content of a collaborative document. Accepts a URL like https://postpaper.co/doc/ABC123 or just the document ID.",
  {
    doc_url: z.string().describe("The document URL or ID"),
  },
  async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const url = `${API_BASE_URL}/api/v1/docs/${docId}/text`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.text();
        return {
          content: [{ type: "text" as const, text: `Error reading document: ${err}` }],
          isError: true,
        };
      }

      const data = await res.json();
      const content = data.content || "(empty document)";

      return {
        content: [
          {
            type: "text" as const,
            text: `Document ID: ${docId}\nURL: ${API_BASE_URL}/doc/${docId}\n\n---\n${content}\n---\n\nTo edit this document, use the edit_document tool with the same URL.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Network error: ${err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "edit_document",
  "Write text into a collaborative document. Supports markdown: # headings, - bullets, 1. numbered lists, **bold**, *italic*. The text is APPENDED to the end of the document by default. Use mode 'replace' to replace the entire document content.",
  {
    doc_url: z.string().describe("The document URL or ID"),
    content: z.string().describe("Markdown text to write. Use \\n for newlines, # for headings, - for bullets."),
    mode: z
      .enum(["append", "replace"])
      .default("append")
      .describe("'append' adds to the end (default), 'replace' replaces the entire document"),
  },
  async ({ doc_url, content, mode }) => {
    const docId = extractDocId(doc_url);
    const method = mode === "replace" ? "PUT" : "POST";
    const url = `${API_BASE_URL}/api/v1/docs/${docId}/text`;

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      const data = await res.json();

      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error editing document: ${data.error || JSON.stringify(data)}`,
            },
          ],
          isError: true,
        };
      }

      const blocksInfo = data.blocksAdded
        ? `${data.blocksAdded} blocks added`
        : data.blocksWritten
        ? `${data.blocksWritten} blocks written`
        : "done";

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully ${mode === "replace" ? "replaced" : "appended"} content (${blocksInfo}). View at: ${API_BASE_URL}/doc/${docId}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Network error: ${err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_blocks",
  "List all blocks in the document with their IDs (useful before editing)",
  {
    doc_url: z.string().describe("The document URL or ID"),
  },
  async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const url = `${API_BASE_URL}/api/v1/docs/${docId}/text`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.text();
        return {
          content: [{ type: "text" as const, text: `Error: ${err}` }],
          isError: true,
        };
      }

      const data = await res.json();
      return {
        content: [
          {
            type: "text" as const,
            text: `Document content:\n\n${data.content || "(empty)"}\n\nBlock count: ${data.blockCount || "unknown"}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Network error: ${err}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PostPaper MCP server running on stdio");
}

main().catch(console.error);
