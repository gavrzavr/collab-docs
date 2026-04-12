import { withYDoc } from "@/lib/yjs-api-bridge";
import * as Y from "yjs";

export const dynamic = "force-dynamic";

function dumpXml(element: Y.XmlElement | Y.XmlText | Y.XmlFragment, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (element instanceof Y.XmlText) {
    const json = element.toJSON();
    return `${pad}[TEXT: "${json}"]\n`;
  }

  if (element instanceof Y.XmlFragment) {
    let result = `${pad}[Fragment] (${element.length} children)\n`;
    for (let i = 0; i < element.length; i++) {
      const child = element.get(i);
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        result += dumpXml(child, indent + 1);
      }
    }
    return result;
  }

  const attrs = element.getAttributes();
  const attrStr = Object.keys(attrs).length > 0
    ? " " + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")
    : "";

  let result = `${pad}<${element.nodeName}${attrStr}> (${element.length} children)\n`;
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      result += dumpXml(child, indent + 1);
    }
  }
  return result;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ docId: string }> }
) {
  const { docId } = await params;

  try {
    const dump = await withYDoc(docId, (_ydoc, fragment) => {
      return dumpXml(fragment);
    });

    return new Response(dump, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Error: ${e}`, { status: 500 });
  }
}
