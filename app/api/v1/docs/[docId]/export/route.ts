import { type NextRequest } from "next/server";
import { withYDoc, readBlocks } from "@/lib/yjs-api-bridge";
import { blocksToMarkdown } from "@/lib/export-markdown";
import { blocksToDocx } from "@/lib/export-docx";
import { authorizeDocAccess } from "@/lib/doc-auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;
  const authz = await authorizeDocAccess(request, docId, "read");
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }
  const format = request.nextUrl.searchParams.get("format") || "md";

  try {
    const blocks = await withYDoc(docId, (_ydoc, fragment) => {
      return readBlocks(fragment);
    });

    if (format === "docx") {
      const buffer = await blocksToDocx(blocks);
      return new Response(buffer as unknown as BodyInit, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="document.docx"`,
        },
      });
    }

    // Default: markdown
    const md = blocksToMarkdown(blocks);
    return new Response(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="document.md"`,
      },
    });
  } catch (e) {
    return Response.json(
      { error: "Failed to export document", details: String(e) },
      { status: 500 }
    );
  }
}
