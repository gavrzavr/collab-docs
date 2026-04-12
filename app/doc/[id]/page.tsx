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
    </div>
  );
}
