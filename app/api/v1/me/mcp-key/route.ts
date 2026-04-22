import { auth } from "@/auth";
import { getMcpKeyInfo, mintMcpKey, revokeMcpKey } from "@/lib/ws-api";

// Per-user MCP API key endpoints. We never accept an email from the
// client — we always use the authenticated session email. This is the
// authorization boundary: if you're signed in as alice, you can only
// touch alice's key.

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const info = await getMcpKeyInfo(email);
    return Response.json(info);
  } catch (e) {
    return Response.json(
      { error: "Failed to load MCP key info", details: String(e) },
      { status: 500 }
    );
  }
}

export async function POST() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await mintMcpKey(email);
    return Response.json(result, { status: 201 });
  } catch (e) {
    return Response.json(
      { error: "Failed to mint MCP key", details: String(e) },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await revokeMcpKey(email);
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: "Failed to revoke MCP key", details: String(e) },
      { status: 500 }
    );
  }
}
