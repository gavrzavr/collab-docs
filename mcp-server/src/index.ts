#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";

async function apiCall(path: string, options?: RequestInit) {
  const url = `${API_BASE_URL}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  return res;
}

function extractDocId(docUrl: string): string {
  // Accept full URL like http://host/doc/abc123 or just the ID
  const match = docUrl.match(/\/doc\/([^/?#]+)/);
  if (match) return match[1];
  // If it looks like a plain ID, use it directly
  return docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
}

const server = new McpServer({
  name: "collab-docs",
  version: "0.1.0",
});

server.tool(
  "read_document",
  "Read the full content of a collaborative document",
  {
    doc_url: z.string().describe("The document URL or ID"),
  },
  async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const res = await apiCall(`/docs/${docId}`);

    if (!res.ok) {
      const err = await res.json();
      return {
        content: [{ type: "text" as const, text: `Error: ${err.error || res.statusText}` }],
        isError: true,
      };
    }

    const doc = await res.json();
    let text = `# ${doc.title}\n\n`;
    for (const block of doc.content) {
      const prefix = getBlockPrefix(block.type, block.props);
      text += `[${block.id}] ${prefix}${block.text}\n`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

server.tool(
  "edit_document",
  "Edit a collaborative document — insert, update, or delete text blocks",
  {
    doc_url: z.string().describe("The document URL or ID"),
    operations: z.array(
      z.object({
        type: z.enum(["insert", "update", "delete"]),
        after_block: z
          .string()
          .optional()
          .describe("Block ID to insert after, or omit for beginning"),
        block_id: z.string().optional().describe("ID of block to modify (for update/delete)"),
        block_type: z
          .string()
          .optional()
          .describe(
            "Block type for insert: paragraph, heading, bulletListItem, numberedListItem"
          ),
        text: z.string().optional().describe("Text content (for insert/update)"),
      })
    ),
  },
  async ({ doc_url, operations }) => {
    const docId = extractDocId(doc_url);

    const apiOps = operations.map((op) => {
      if (op.type === "insert") {
        return {
          type: "insert" as const,
          afterBlockId: op.after_block || null,
          block: {
            type: op.block_type || "paragraph",
            text: op.text || "",
          },
        };
      } else if (op.type === "update") {
        return {
          type: "update" as const,
          blockId: op.block_id,
          text: op.text || "",
        };
      } else {
        return {
          type: "delete" as const,
          blockId: op.block_id,
        };
      }
    });

    const res = await apiCall(`/docs/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ author: "Claude", operations: apiOps }),
    });

    const result = await res.json();

    if (!res.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${result.error || JSON.stringify(result.errors)}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully applied ${result.appliedOperations} operation(s).`,
        },
      ],
    };
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
    const res = await apiCall(`/docs/${docId}`);

    if (!res.ok) {
      const err = await res.json();
      return {
        content: [{ type: "text" as const, text: `Error: ${err.error || res.statusText}` }],
        isError: true,
      };
    }

    const doc = await res.json();
    const lines = doc.content.map(
      (block: { id: string; type: string; text: string }) =>
        `${block.id} | ${block.type} | ${block.text.substring(0, 100)}`
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Blocks in document "${doc.title}":\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

function getBlockPrefix(type: string, props?: Record<string, unknown>): string {
  switch (type) {
    case "heading": {
      const level = (props?.level as number) || 1;
      return "#".repeat(level) + " ";
    }
    case "bulletListItem":
      return "- ";
    case "numberedListItem":
      return "1. ";
    default:
      return "";
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CollabDocs MCP server running on stdio");
}

main().catch(console.error);
