#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE_URL = process.env.API_BASE_URL || "https://postpaper.co";
// ws-server hosts the MCP-key-authenticated endpoints. Defaults to the
// public Railway deploy; override with WS_BASE_URL for local dev.
const WS_BASE_URL = process.env.WS_BASE_URL || "https://ws.postpaper.co";
// Personal MCP API key, minted in the dashboard. Required only by tools
// that need to know who the caller is (currently: list_my_documents).
const MCP_API_KEY = process.env.MCP_API_KEY || "";

function extractDocId(docUrl: string): string {
  // Accept full URL like http://host/doc/abc123 or just the ID
  const match = docUrl.match(/\/doc\/([^/?#]+)/);
  if (match) return match[1];
  // If it looks like a plain ID, use it directly
  return docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
}

const server = new McpServer({
  name: "collab-docs",
  version: "0.3.0",
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

server.tool(
  "list_my_documents",
  "Lists every PostPaper document the caller has access to — ones they own AND ones shared with them as editor or commenter. Returns title, doc URL, role, owner email, and last-edited timestamp, sorted most-recent-first. Use this when the user asks: 'what docs do I have', 'what can I edit in PostPaper', 'find my doc about X', 'what's been shared with me', or wants a doc URL to paste into another conversation. Requires MCP_API_KEY in the env (mint one at https://postpaper.co/dashboard). Don't confuse with list_pages, which returns tabs WITHIN a single document.",
  {},
  async () => {
    if (!MCP_API_KEY) {
      return {
        content: [{
          type: "text" as const,
          text: "list_my_documents requires MCP_API_KEY in the environment. Mint a key at https://postpaper.co/dashboard, then add it to your MCP server config (e.g. `\"env\": { \"MCP_API_KEY\": \"...\" }` in claude_desktop_config.json).",
        }],
        isError: true,
      };
    }
    try {
      const res = await fetch(`${WS_BASE_URL}/api/me/docs`, {
        headers: { "x-api-key": MCP_API_KEY },
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${res.status} ${res.statusText}${err ? ` — ${err.slice(0, 200)}` : ""}`,
          }],
          isError: true,
        };
      }
      const data = (await res.json()) as {
        documents: Array<{
          id: string;
          title: string | null;
          owner_id: string | null;
          updated_at: string;
          role: "owner" | "editor" | "commenter";
        }>;
      };
      const rows = data.documents || [];
      if (rows.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "You don't have access to any PostPaper documents yet. Create one at https://postpaper.co/dashboard or ask a collaborator for an invite link.",
          }],
        };
      }
      const HARD_CAP = 100;
      const shown = rows.slice(0, HARD_CAP);
      const overflow = rows.length - shown.length;
      const lines: string[] = [];
      lines.push(`Your PostPaper documents (${rows.length} total${overflow > 0 ? `, showing ${HARD_CAP}` : ""}):`);
      lines.push("");
      for (const r of shown) {
        const url = `${API_BASE_URL}/doc/${r.id}`;
        const title = r.title && r.title.trim() ? r.title : "Untitled";
        const ownerLabel = r.role === "owner" ? "you" : (r.owner_id || "unknown");
        lines.push(
          `- [${r.role.toUpperCase()}] ${title}\n` +
          `  ${url}\n` +
          `  owner: ${ownerLabel} · last edited: ${r.updated_at}`
        );
      }
      if (overflow > 0) {
        lines.push("");
        lines.push(`...and ${overflow} more not shown.`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
