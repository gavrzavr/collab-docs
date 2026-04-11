interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
  children?: Block[];
}

export function blocksToMarkdown(blocks: Block[], indent = ""): string {
  const lines: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const level = (block.props?.level as number) || 1;
        const prefix = "#".repeat(level);
        lines.push(`${indent}${prefix} ${block.text}`);
        break;
      }
      case "bulletListItem":
        lines.push(`${indent}- ${block.text}`);
        break;
      case "numberedListItem":
        lines.push(`${indent}1. ${block.text}`);
        break;
      case "paragraph":
      default:
        lines.push(`${indent}${block.text}`);
        break;
    }

    if (block.children && block.children.length > 0) {
      lines.push(blocksToMarkdown(block.children, indent + "  "));
    }
  }

  return lines.join("\n\n");
}
