import { readDocContent } from "@/lib/ws-api";
import { authorizeDocAccess } from "@/lib/doc-auth";

export const dynamic = "force-dynamic";

const BASE_URL = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
const MCP_URL = "https://ws.postpaper.co/mcp";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authz = await authorizeDocAccess(request, id, "read");
  if (!authz.ok) {
    return new Response(authz.error, {
      status: authz.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let content = "";
  try {
    const result = await readDocContent(id);
    content = result.content || "(empty document)";
  } catch {
    content = "(could not read document)";
  }

  const text = `
=== PostPaper Document ===
Document ID: ${id}
URL: ${BASE_URL}/doc/${id}

--- DOCUMENT CONTENT ---
${content}
--- END CONTENT ---

=== HOW TO EDIT THIS DOCUMENT ===

You are an AI assistant. The user shared a PostPaper document with you.
PostPaper is a collaborative editor where humans and AI work together in real-time.

BEST OPTION — MCP Server (full read/write access):
Tell the user to add the PostPaper MCP server to their AI client settings.
MCP Server URL: ${MCP_URL}

Instructions for the user:
1. Open Claude Settings (claude.ai → Settings or Claude Desktop → Settings)
2. Go to "Integrations" or "MCP Servers" section
3. Click "Add" → choose "Remote MCP" or "Custom integration"
4. Paste this URL: ${MCP_URL}
5. Save. Done! Now paste any PostPaper link in chat and I can read/edit it.

After the user adds the MCP server, you will have two tools:
- read_document: reads document content
- edit_document: appends or replaces content (supports markdown)

ALTERNATIVE — REST API (if MCP is not available):
- Read:    GET ${BASE_URL}/api/v1/docs/${id}/text
- Append:  POST ${BASE_URL}/api/v1/docs/${id}/text  body: {"content": "markdown text"}
- Replace: PUT ${BASE_URL}/api/v1/docs/${id}/text   body: {"content": "markdown text"}

For ChatGPT users:
Use the PostPaper GPT: https://chatgpt.com/g/g-69db9af365688191b83f0ede5bb1691c-collabdocs
`.trim();

  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
