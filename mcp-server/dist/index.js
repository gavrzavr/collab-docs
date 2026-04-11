#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
async function apiCall(path, options) {
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
function extractDocId(docUrl) {
    // Accept full URL like http://host/doc/abc123 or just the ID
    const match = docUrl.match(/\/doc\/([^/?#]+)/);
    if (match)
        return match[1];
    // If it looks like a plain ID, use it directly
    return docUrl.replace(/^\/+/, "").replace(/\/+$/, "");
}
const server = new mcp_js_1.McpServer({
    name: "collab-docs",
    version: "0.1.0",
});
server.tool("read_document", "Read the full content of a collaborative document", {
    doc_url: zod_1.z.string().describe("The document URL or ID"),
}, async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const res = await apiCall(`/docs/${docId}`);
    if (!res.ok) {
        const err = await res.json();
        return {
            content: [{ type: "text", text: `Error: ${err.error || res.statusText}` }],
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
        content: [{ type: "text", text }],
    };
});
server.tool("edit_document", "Edit a collaborative document — insert, update, or delete text blocks", {
    doc_url: zod_1.z.string().describe("The document URL or ID"),
    operations: zod_1.z.array(zod_1.z.object({
        type: zod_1.z.enum(["insert", "update", "delete"]),
        after_block: zod_1.z
            .string()
            .optional()
            .describe("Block ID to insert after, or omit for beginning"),
        block_id: zod_1.z.string().optional().describe("ID of block to modify (for update/delete)"),
        block_type: zod_1.z
            .string()
            .optional()
            .describe("Block type for insert: paragraph, heading, bulletListItem, numberedListItem"),
        text: zod_1.z.string().optional().describe("Text content (for insert/update)"),
    })),
}, async ({ doc_url, operations }) => {
    const docId = extractDocId(doc_url);
    const apiOps = operations.map((op) => {
        if (op.type === "insert") {
            return {
                type: "insert",
                afterBlockId: op.after_block || null,
                block: {
                    type: op.block_type || "paragraph",
                    text: op.text || "",
                },
            };
        }
        else if (op.type === "update") {
            return {
                type: "update",
                blockId: op.block_id,
                text: op.text || "",
            };
        }
        else {
            return {
                type: "delete",
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
                    type: "text",
                    text: `Error: ${result.error || JSON.stringify(result.errors)}`,
                },
            ],
            isError: true,
        };
    }
    return {
        content: [
            {
                type: "text",
                text: `Successfully applied ${result.appliedOperations} operation(s).`,
            },
        ],
    };
});
server.tool("list_blocks", "List all blocks in the document with their IDs (useful before editing)", {
    doc_url: zod_1.z.string().describe("The document URL or ID"),
}, async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const res = await apiCall(`/docs/${docId}`);
    if (!res.ok) {
        const err = await res.json();
        return {
            content: [{ type: "text", text: `Error: ${err.error || res.statusText}` }],
            isError: true,
        };
    }
    const doc = await res.json();
    const lines = doc.content.map((block) => `${block.id} | ${block.type} | ${block.text.substring(0, 100)}`);
    return {
        content: [
            {
                type: "text",
                text: `Blocks in document "${doc.title}":\n\n${lines.join("\n")}`,
            },
        ],
    };
});
function getBlockPrefix(type, props) {
    switch (type) {
        case "heading": {
            const level = props?.level || 1;
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
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("CollabDocs MCP server running on stdio");
}
main().catch(console.error);
