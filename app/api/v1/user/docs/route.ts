import { auth } from "@/auth";
import { listUserDocuments } from "@/lib/ws-api";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();

  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await listUserDocuments(session.user.email);
    return Response.json(data);
  } catch (e) {
    return Response.json(
      { error: "Failed to fetch documents", details: String(e) },
      { status: 500 }
    );
  }
}
