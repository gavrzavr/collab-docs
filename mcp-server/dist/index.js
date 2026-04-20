#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const API_BASE_URL = process.env.API_BASE_URL || "https://postpaper.co";
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
    version: "0.2.0",
});
server.tool("read_document", "Read the full content of a collaborative document. Accepts a URL like https://postpaper.co/doc/ABC123 or just the document ID.", {
    doc_url: zod_1.z.string().describe("The document URL or ID"),
}, async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const url = `${API_BASE_URL}/api/v1/docs/${docId}/text`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.text();
            return {
                content: [{ type: "text", text: `Error reading document: ${err}` }],
                isError: true,
            };
        }
        const data = await res.json();
        const content = data.content || "(empty document)";
        return {
            content: [
                {
                    type: "text",
                    text: `Document ID: ${docId}\nURL: ${API_BASE_URL}/doc/${docId}\n\n---\n${content}\n---\n\nTo edit this document, use the edit_document tool with the same URL.`,
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Network error: ${err}` }],
            isError: true,
        };
    }
});
server.tool("edit_document", "Write text into a collaborative document. Supports markdown: # headings, - bullets, 1. numbered lists, **bold**, *italic*. The text is APPENDED to the end of the document by default. Use mode 'replace' to replace the entire document content.", {
    doc_url: zod_1.z.string().describe("The document URL or ID"),
    content: zod_1.z.string().describe("Markdown text to write. Use \\n for newlines, # for headings, - for bullets."),
    mode: zod_1.z
        .enum(["append", "replace"])
        .default("append")
        .describe("'append' adds to the end (default), 'replace' replaces the entire document"),
}, async ({ doc_url, content, mode }) => {
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
                        type: "text",
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
                    type: "text",
                    text: `Successfully ${mode === "replace" ? "replaced" : "appended"} content (${blocksInfo}). View at: ${API_BASE_URL}/doc/${docId}`,
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Network error: ${err}` }],
            isError: true,
        };
    }
});
server.tool("list_blocks", "List all blocks in the document with their IDs (useful before editing)", {
    doc_url: zod_1.z.string().describe("The document URL or ID"),
}, async ({ doc_url }) => {
    const docId = extractDocId(doc_url);
    const url = `${API_BASE_URL}/api/v1/docs/${docId}/text`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.text();
            return {
                content: [{ type: "text", text: `Error: ${err}` }],
                isError: true,
            };
        }
        const data = await res.json();
        return {
            content: [
                {
                    type: "text",
                    text: `Document content:\n\n${data.content || "(empty)"}\n\nBlock count: ${data.blockCount || "unknown"}`,
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Network error: ${err}` }],
            isError: true,
        };
    }
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("CollabDocs MCP server running on stdio");
}
main().catch(console.error);
