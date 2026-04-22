import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Packer,
  AlignmentType,
} from "docx";

interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
  children?: Block[];
}

function blockToParagraph(block: Block): Paragraph {
  switch (block.type) {
    case "heading": {
      const level = (block.props?.level as number) || 1;
      const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
      };
      return new Paragraph({
        heading: headingMap[level] || HeadingLevel.HEADING_1,
        children: [new TextRun(block.text)],
      });
    }
    case "bulletListItem":
      return new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun(block.text)],
      });
    case "numberedListItem":
      return new Paragraph({
        numbering: { reference: "default-numbering", level: 0 },
        children: [new TextRun(block.text)],
      });
    case "htmlViz":
      // Live JS visualizations can't round-trip to .docx. Emit a
      // placeholder (italic, grey-tinted by the reader) so the exported
      // file still makes sense offline.
      return new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: "[Interactive block — view in PostPaper]", italics: true })],
      });
    case "paragraph":
    default:
      return new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun(block.text)],
      });
  }
}

function flattenBlocks(blocks: Block[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const block of blocks) {
    paragraphs.push(blockToParagraph(block));
    if (block.children) {
      paragraphs.push(...flattenBlocks(block.children));
    }
  }
  return paragraphs;
}

export async function blocksToDocx(blocks: Block[]): Promise<Uint8Array> {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: "decimal" as const,
              text: "%1.",
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: flattenBlocks(blocks),
      },
    ],
  });

  return new Uint8Array(await Packer.toBuffer(doc));
}
