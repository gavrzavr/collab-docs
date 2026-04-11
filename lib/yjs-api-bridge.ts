import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const WS_URL = process.env.WS_URL || "ws://localhost:1234";

interface BlockData {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
  children?: BlockData[];
}

function waitForSync(provider: WebsocketProvider): Promise<void> {
  return new Promise((resolve, reject) => {
    if (provider.synced) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket sync timeout"));
    }, 5000);
    provider.once("sync", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function withYDoc<T>(
  docId: string,
  fn: (ydoc: Y.Doc, fragment: Y.XmlFragment) => T
): Promise<T> {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, docId, ydoc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  try {
    await waitForSync(provider);
    const fragment = ydoc.getXmlFragment("blocknote");
    const result = fn(ydoc, fragment);
    // Give a small delay for the update to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));
    return result;
  } finally {
    provider.destroy();
    ydoc.destroy();
  }
}

function extractTextContent(element: Y.XmlElement | Y.XmlText): string {
  let text = "";
  if (element instanceof Y.XmlText) {
    return element.toJSON();
  }
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      text += child.toJSON();
    } else if (child instanceof Y.XmlElement) {
      text += extractTextContent(child);
    }
  }
  return text;
}

function extractInlineContent(element: Y.XmlElement): Y.XmlElement | null {
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "inline-content") {
      return child;
    }
  }
  return null;
}

export function readBlocks(fragment: Y.XmlFragment): BlockData[] {
  const blocks: BlockData[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
      for (let j = 0; j < child.length; j++) {
        const blockContainer = child.get(j);
        if (blockContainer instanceof Y.XmlElement && blockContainer.nodeName === "blockContainer") {
          const block = parseBlockContainer(blockContainer);
          if (block) blocks.push(block);
        }
      }
    }
  }

  return blocks;
}

function parseBlockContainer(container: Y.XmlElement): BlockData | null {
  const id = container.getAttribute("id") || "";
  let type = "paragraph";
  let props: Record<string, unknown> = {};
  let text = "";
  const children: BlockData[] = [];

  for (let i = 0; i < container.length; i++) {
    const child = container.get(i);
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === "blockGroup") {
        // Nested blocks
        for (let j = 0; j < child.length; j++) {
          const nestedContainer = child.get(j);
          if (nestedContainer instanceof Y.XmlElement && nestedContainer.nodeName === "blockContainer") {
            const nestedBlock = parseBlockContainer(nestedContainer);
            if (nestedBlock) children.push(nestedBlock);
          }
        }
      } else {
        // This is the block content element
        type = child.nodeName;
        const attrs = child.getAttributes();
        const defaultProps = ["backgroundColor", "textColor", "textAlignment"];
        const filteredAttrs = Object.fromEntries(
          Object.entries(attrs).filter(
            ([k, v]) => !(defaultProps.includes(k) && v === "default")
          )
        );
        if (Object.keys(filteredAttrs).length > 0) {
          props = filteredAttrs;
        }
        const inlineContent = extractInlineContent(child);
        if (inlineContent) {
          text = extractTextContent(inlineContent);
        } else {
          text = extractTextContent(child);
        }
      }
    }
  }

  const block: BlockData = { id, type, text };
  if (Object.keys(props).length > 0) block.props = props;
  if (children.length > 0) block.children = children;
  return block;
}

function findBlockContainerById(
  fragment: Y.XmlFragment | Y.XmlElement,
  blockId: string
): Y.XmlElement | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) {
        return child;
      }
      const found = findBlockContainerById(child, blockId);
      if (found) return found;
    }
  }
  return null;
}

function findParentAndIndex(
  fragment: Y.XmlFragment | Y.XmlElement,
  blockId: string
): { parent: Y.XmlElement; index: number } | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === "blockGroup") {
        for (let j = 0; j < child.length; j++) {
          const bc = child.get(j);
          if (bc instanceof Y.XmlElement && bc.nodeName === "blockContainer" && bc.getAttribute("id") === blockId) {
            return { parent: child, index: j };
          }
        }
      }
      const found = findParentAndIndex(child, blockId);
      if (found) return found;
    }
  }
  return null;
}

function getOrCreateBlockGroup(fragment: Y.XmlFragment): Y.XmlElement {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "blockGroup") {
      return child;
    }
  }
  const bg = new Y.XmlElement("blockGroup");
  fragment.insert(0, [bg]);
  return bg;
}

function createBlockContainer(
  id: string,
  type: string,
  text: string
): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);

  const blockEl = new Y.XmlElement(type);
  blockEl.setAttribute("backgroundColor", "default");
  blockEl.setAttribute("textColor", "default");
  blockEl.setAttribute("textAlignment", "left");
  const textNode = new Y.XmlText(text);
  blockEl.insert(0, [textNode]);
  container.insert(0, [blockEl]);

  return container;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + "-" + Date.now().toString(36);
}

export interface Operation {
  type: "insert" | "update" | "delete";
  afterBlockId?: string | null;
  blockId?: string;
  block?: {
    type: string;
    text: string;
  };
  text?: string;
}

export function applyOperations(
  ydoc: Y.Doc,
  fragment: Y.XmlFragment,
  operations: Operation[]
): { applied: number; errors: Array<{ op: number; error: string }> } {
  let applied = 0;
  const errors: Array<{ op: number; error: string }> = [];

  ydoc.transact(() => {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        switch (op.type) {
          case "insert": {
            if (!op.block) {
              errors.push({ op: i, error: "Missing block data for insert" });
              continue;
            }
            const newId = generateId();
            const container = createBlockContainer(
              newId,
              op.block.type || "paragraph",
              op.block.text || ""
            );

            if (op.afterBlockId) {
              const loc = findParentAndIndex(fragment, op.afterBlockId);
              if (!loc) {
                errors.push({ op: i, error: `Block ${op.afterBlockId} not found` });
                continue;
              }
              loc.parent.insert(loc.index + 1, [container]);
            } else {
              const bg = getOrCreateBlockGroup(fragment);
              bg.insert(0, [container]);
            }
            applied++;
            break;
          }
          case "update": {
            if (!op.blockId) {
              errors.push({ op: i, error: "Missing blockId for update" });
              continue;
            }
            const bc = findBlockContainerById(fragment, op.blockId);
            if (!bc) {
              errors.push({ op: i, error: `Block ${op.blockId} not found` });
              continue;
            }
            // Find the block element and replace its text content
            for (let c = 0; c < bc.length; c++) {
              const blockEl = bc.get(c);
              if (blockEl instanceof Y.XmlElement && blockEl.nodeName !== "blockGroup") {
                // Clear all children and insert new text
                while (blockEl.length > 0) blockEl.delete(0);
                blockEl.insert(0, [new Y.XmlText(op.text || "")]);
                break;
              }
            }
            applied++;
            break;
          }
          case "delete": {
            if (!op.blockId) {
              errors.push({ op: i, error: "Missing blockId for delete" });
              continue;
            }
            const loc = findParentAndIndex(fragment, op.blockId);
            if (!loc) {
              errors.push({ op: i, error: `Block ${op.blockId} not found` });
              continue;
            }
            loc.parent.delete(loc.index);
            applied++;
            break;
          }
        }
      } catch (e) {
        errors.push({ op: i, error: String(e) });
      }
    }
  });

  return { applied, errors };
}
