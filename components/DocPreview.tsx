"use client";

import { useEffect, useState } from "react";

interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
}

interface DocPreviewProps {
  docId: string;
  visible: boolean;
}

export default function DocPreview({ docId, visible }: DocPreviewProps) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);

  useEffect(() => {
    fetch(`/api/v1/docs/${docId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.content) setBlocks(data.content);
      })
      .catch(() => {});
  }, [docId]);

  if (!visible) return null;
  if (!blocks) return null;
  if (blocks.length === 0) return null;

  return (
    <div className="pointer-events-none select-none" style={{ paddingLeft: 54 }}>
      {blocks.map((block) => {
        switch (block.type) {
          case "heading": {
            const level = (block.props?.level as number) || 1;
            const sizes: Record<number, string> = {
              1: "text-3xl font-bold",
              2: "text-2xl font-bold",
              3: "text-xl font-bold",
            };
            return (
              <div key={block.id} className={`${sizes[level] || sizes[1]} mb-1 leading-relaxed`}>
                {block.text}
              </div>
            );
          }
          case "bulletListItem":
            return (
              <div key={block.id} className="flex gap-2 leading-relaxed">
                <span>•</span>
                <span>{block.text}</span>
              </div>
            );
          case "numberedListItem":
            return (
              <div key={block.id} className="flex gap-2 leading-relaxed">
                <span>1.</span>
                <span>{block.text}</span>
              </div>
            );
          default:
            return (
              <p key={block.id} className="leading-relaxed min-h-[1.5em]">
                {block.text || "\u00A0"}
              </p>
            );
        }
      })}
    </div>
  );
}
