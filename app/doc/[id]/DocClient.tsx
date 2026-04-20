"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import NamePrompt from "@/components/NamePrompt";
import Toolbar from "@/components/Toolbar";
import DocPreview from "@/components/DocPreview";
import OutlinePanel from "@/components/OutlinePanel";

const Editor = dynamic(() => import("@/components/Editor"), { ssr: false });

const COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#FFA07A",
  "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
];

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
}

interface DocClientProps {
  id: string;
  initialBlocks: Block[];
}

export default function DocClient({ id, initialBlocks }: DocClientProps) {
  const [user, setUser] = useState<{ name: string; color: string; image?: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [sessionUser, setSessionUser] = useState<{ name: string; email: string; image?: string } | null>(null);
  const [synced, setSynced] = useState(false);
  const [editor, setEditor] = useState<unknown>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const importHtmlRef = useRef<((html: string) => void) | null>(null);

  const handleSynced = useCallback(() => {
    setSynced(true);
  }, []);

  const handleImportHtml = useCallback((html: string) => {
    importHtmlRef.current?.(html);
  }, []);

  const handleRegisterEditor = useCallback((e: unknown) => {
    setEditor(e);
  }, []);

  const handleScrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollEl(node);
  }, []);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data?.user?.name) {
          const color = localStorage.getItem("collab-docs-color") || randomColor();
          localStorage.setItem("collab-docs-color", color);
          setSessionUser(data.user);
          setUser({ name: data.user.name, color, image: data.user.image });
          setChecked(true);
        } else {
          const name = localStorage.getItem("collab-docs-name");
          const color = localStorage.getItem("collab-docs-color");
          if (name && color) {
            setUser({ name, color });
          }
          setChecked(true);
        }
      })
      .catch(() => {
        const name = localStorage.getItem("collab-docs-name");
        const color = localStorage.getItem("collab-docs-color");
        if (name && color) {
          setUser({ name, color });
        }
        setChecked(true);
      });
  }, []);

  if (!checked) return null;

  if (!user) {
    return (
      <NamePrompt
        onSubmit={(name, color) => setUser({ name, color })}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <Toolbar docId={id} sessionUser={sessionUser} onImportHtml={handleImportHtml} />
      <div className="flex-1 flex overflow-hidden">
        <OutlinePanel
          editor={(synced ? editor : null) as never}
          scrollContainer={scrollEl}
        />
      <div ref={handleScrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto py-8">
          {/* Show server-rendered preview while Yjs is connecting */}
          {!synced && initialBlocks.length > 0 && (
            <div className="pointer-events-none select-none px-4 md:px-[54px]">
              {initialBlocks.map((block) => {
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
                        <span>•</span><span>{block.text}</span>
                      </div>
                    );
                  case "numberedListItem":
                    return (
                      <div key={block.id} className="flex gap-2 leading-relaxed">
                        <span>1.</span><span>{block.text}</span>
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
          )}
          {!synced && initialBlocks.length === 0 && (
            <DocPreview docId={id} visible={true} />
          )}
          {/* Editor — hidden until synced */}
          <div style={{ opacity: synced ? 1 : 0, position: synced ? "static" : "absolute", left: synced ? "auto" : "-9999px" }}>
            <Editor
              docId={id}
              userName={user.name}
              userColor={user.color}
              onSynced={handleSynced}
              registerImportHtml={(fn) => { importHtmlRef.current = fn; }}
              registerEditor={handleRegisterEditor}
            />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
