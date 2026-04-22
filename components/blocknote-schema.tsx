"use client";

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";

import { HtmlVizBlock } from "./blocks/HtmlVizBlock";

// Custom block: `htmlViz` — a sandboxed-iframe container for Claude-generated
// visualizations (charts, dashboards, workout diagrams, ...).
//
// The actual HTML lives in the `html` prop as a string. The prop is large
// (up to ~100 KB, matching the server cap), but BlockNote happily stores it
// in Yjs attributes. We keep `createdAt` / `createdBy` for the badge.
//
// `content: "none"` — this block has no inline text content. Claude edits
// it by calling `update_html_block` on the server side.
const htmlVizBlock = createReactBlockSpec(
  {
    type: "htmlViz",
    propSchema: {
      html: { default: "" as string },
      createdAt: { default: "" as string },
      createdBy: { default: "" as string },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const html = String(block.props.html ?? "");
      const createdAt = String(block.props.createdAt ?? "");
      const createdBy = String(block.props.createdBy ?? "");
      return (
        <HtmlVizBlock
          html={html}
          createdAt={createdAt || undefined}
          createdBy={createdBy || undefined}
        />
      );
    },
    // External export (copy/paste HTML) — render a placeholder so we don't
    // accidentally leak the raw iframe HTML into a pasted document.
    toExternalHTML: () => (
      <p>
        <em>[Interactive block]</em>
      </p>
    ),
  },
);

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    htmlViz: htmlVizBlock(),
  },
});

export type EditorSchema = typeof editorSchema;
