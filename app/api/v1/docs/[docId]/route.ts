import { withYDoc, readBlocks, applyOperations, type Operation } from "@/lib/yjs-api-bridge";
import { authorizeDocAccess } from "@/lib/doc-auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  const authz = await authorizeDocAccess(request, docId, "read");
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  try {
    const content = await withYDoc(docId, (_ydoc, fragment) => {
      return readBlocks(fragment);
    });

    return Response.json({
      id: docId,
      title: "Untitled",
      content,
    });
  } catch (e) {
    return Response.json(
      { error: "Failed to read document", details: String(e) },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  const authz = await authorizeDocAccess(request, docId, "write");
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  let body: { author?: string; operations: Operation[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.operations || !Array.isArray(body.operations)) {
    return Response.json({ error: "Missing operations array" }, { status: 400 });
  }

  try {
    const result = await withYDoc(docId, (ydoc, fragment) => {
      return applyOperations(ydoc, fragment, body.operations);
    });

    if (result.errors.length > 0) {
      return Response.json(
        {
          success: false,
          appliedOperations: result.applied,
          errors: result.errors,
        },
        { status: 400 }
      );
    }

    return Response.json({
      success: true,
      appliedOperations: result.applied,
    });
  } catch (e) {
    return Response.json(
      { error: "Failed to apply operations", details: String(e) },
      { status: 500 }
    );
  }
}
