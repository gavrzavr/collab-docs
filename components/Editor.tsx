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
  onSynced?: () => void;
  registerImportHtml?: (fn: (html: string) => void) => void;
}

export default function Editor({ docId, userName, userColor, onSynced, registerImportHtml }: EditorProps) {
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
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `ws://${window.location.hostname}:1234`;
    const provider = new WebsocketProvider(wsUrl, docId, ydoc);
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", {
      name: userName,
      color: userColor,
    });

    // Notify parent when Yjs is synced
    if (provider.synced) {
      onSynced?.();
    } else {
      provider.once("sync", () => {
        onSynced?.();
      });
    }

    setReady(true);

    return () => {
      provider.destroy();
      providerRef.current = null;
    };
  }, [docId, userName, userColor, onSynced]);

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

  // Register import handler so parent can trigger HTML import
  useEffect(() => {
    if (!registerImportHtml || !editor) return;
    registerImportHtml(async (html: string) => {
      try {
        const blocks = await editor.tryParseHTMLToBlocks(html);
        // Insert imported blocks at the end of the document
        const lastBlock = editor.document[editor.document.length - 1];
        editor.insertBlocks(blocks, lastBlock, "after");
      } catch (err) {
        console.error("Failed to import HTML into editor:", err);
      }
    });
  }, [editor, registerImportHtml]);

  if (!ready || !providerRef.current) {
    return null;
  }

  return <BlockNoteView editor={editor} theme="light" />;
}
