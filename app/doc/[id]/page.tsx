"use client";

import { use, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import NamePrompt from "@/components/NamePrompt";
import Toolbar from "@/components/Toolbar";

const Editor = dynamic(() => import("@/components/Editor"), { ssr: false });

export default function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [user, setUser] = useState<{ name: string; color: string } | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const name = localStorage.getItem("collab-docs-name");
    const color = localStorage.getItem("collab-docs-color");
    if (name && color) {
      setUser({ name, color });
    }
    setChecked(true);
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
      <Toolbar docId={id} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto py-8">
          <Editor docId={id} userName={user.name} userColor={user.color} />
        </div>
      </div>
    </div>
  );
}
