import { nanoid } from "nanoid";
import { createDocument } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  const id = nanoid(10);
  const doc = createDocument(id);
  return Response.json(
    {
      id: doc.id,
      url: `/doc/${doc.id}`,
      createdAt: doc.createdAt,
    },
    { status: 201 }
  );
}
