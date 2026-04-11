import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const id = nanoid(10);
  let title = "Untitled";

  try {
    const body = await request.json();
    if (body.title) title = body.title;
  } catch {
    // No body or invalid JSON — that's fine
  }

  return Response.json(
    {
      id,
      title,
      url: `/doc/${id}`,
      createdAt: new Date().toISOString(),
    },
    { status: 201 }
  );
}
