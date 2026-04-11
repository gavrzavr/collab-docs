"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { useEffect, useRef, useState } from "react";

interface EditorProps {
  docId: string;
  userName: string;
  userColor: string;
}

export default function Editor({ docId, userName, userColor }: EditorProps) {
  const [ready, setReady] = useState(false);
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const fragmentRef = useRef<Y.XmlFragment | null>(null);

  if (!ydocRef.current) {
    ydocRef.current = new Y.Doc();
    fragmentRef.current = ydocRef.current.getXmlFragment("blocknote");
  }

  useEffect(() => {
    const ydoc = ydocRef.current!;
    const wsUrl = `ws://${window.location.hostname}:1234`;
    const provider = new WebsocketProvider(wsUrl, docId, ydoc);
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", {
      name: userName,
      color: userColor,
    });

    setReady(true);

    return () => {
      provider.destroy();
      providerRef.current = null;
    };
  }, [docId, userName, userColor]);

  const editor = useCreateBlockNote(
    {
      collaboration: providerRef.current
        ? {
            provider: providerRef.current,
            fragment: fragmentRef.current!,
            user: {
              name: userName,
              color: userColor,
            },
          }
        : undefined,
    },
    [ready]
  );

  if (!ready || !providerRef.current) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading editor...
      </div>
    );
  }

  return <BlockNoteView editor={editor} theme="light" />;
}
