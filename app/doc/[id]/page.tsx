"use client";

import { use, useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import NamePrompt from "@/components/NamePrompt";
import Toolbar from "@/components/Toolbar";
import DocPreview from "@/components/DocPreview";

const Editor = dynamic(() => import("@/components/Editor"), { ssr: false });

const COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#FFA07A",
  "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
];

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export default function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [user, setUser] = useState<{ name: string; color: string; image?: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [sessionUser, setSessionUser] = useState<{ name: string; email: string; image?: string } | null>(null);
  const [synced, setSynced] = useState(false);

  const handleSynced = useCallback(() => {
    setSynced(true);
  }, []);

  useEffect(() => {
    // Check if user has an auth session
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

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="flex flex-col h-screen">
      <Toolbar docId={id} sessionUser={sessionUser} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto py-8">
          {/* Show read-only preview while Yjs is connecting */}
          <DocPreview docId={id} visible={!synced} />
          {/* Editor loads on top — hidden until synced, then takes over */}
          <div style={{ opacity: synced ? 1 : 0, position: synced ? "static" : "absolute", left: synced ? "auto" : "-9999px" }}>
            <Editor docId={id} userName={user.name} userColor={user.color} onSynced={handleSynced} />
          </div>
        </div>
      </div>

      {/* AI-readable instructions — hidden from humans, visible to AI agents reading the page */}
      <div id="ai-instructions" style={{ display: "none" }} aria-hidden="true" data-ai-instructions="true">
        <h2>AI Agent Instructions for CollabDocs</h2>
        <p>This is a collaborative document. You can read and edit it using simple HTTP requests. No authentication required.</p>

        <h3>Read this document</h3>
        <pre>GET {baseUrl}/api/v1/docs/{id}/text</pre>
        <p>Returns the full document as plain text (markdown-formatted).</p>

        <h3>Replace the entire document</h3>
        <pre>PUT {baseUrl}/api/v1/docs/{id}/text</pre>
        <p>Send plain text or markdown in the request body. Lines starting with # become headings, - become bullet lists, 1. become numbered lists.</p>

        <h3>Append text to the document</h3>
        <pre>POST {baseUrl}/api/v1/docs/{id}/text</pre>
        <p>Same format as PUT, but adds to the end instead of replacing.</p>

        <h3>Example</h3>
        <pre>{`curl ${baseUrl}/api/v1/docs/${id}/text`}</pre>
        <pre>{`curl -X POST ${baseUrl}/api/v1/docs/${id}/text -d '# New heading
This is a new paragraph
- Bullet point 1
- Bullet point 2'`}</pre>
      </div>
    </div>
  );
}
