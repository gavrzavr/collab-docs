"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import {
  useCreateBlockNote, FormattingToolbarController, FormattingToolbar, getFormattingToolbarItems,
  useBlockNoteEditor, useComponentsContext, useEditorState,
  SideMenuController, SideMenu,
  DragHandleMenu, BlockColorsItem, RemoveBlockItem,
} from "@blocknote/react";
import type { BlockTypeSelectItem } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { createExtension } from "@blocknote/core";
import { TurnIntoItem } from "./TurnIntoItem";
import { RiText, RiH1, RiH2, RiH3, RiListUnordered, RiListOrdered, RiListCheck3, RiQuoteText } from "react-icons/ri";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import { useEffect, useMemo } from "react";

import { editorSchema } from "./blocknote-schema";
import { TypographyShortcuts } from "./typography-shortcuts";

// Wrap our Tiptap extension in a BlockNote-compatible extension so the
// schema picks it up alongside the built-in ones (sideMenu, formatting,
// etc.). Single shared instance — extensions are stateless here.
const typographyShortcutsExtension = createExtension({
  key: "postpaper-typography-shortcuts",
  tiptapExtensions: [TypographyShortcuts],
});

interface EditorProps {
  /** The shared Y.Doc for this document. Owned by the parent (DocClient) so
   *  that tab switches don't tear down the WebSocket connection. */
  ydoc: Y.Doc;
  /** The y-websocket provider, also owned by the parent. */
  provider: WebsocketProvider;
  /** The Yjs XmlFragment name this editor binds to.
   *  For multi-page docs each page gets its own fragment; the first page
   *  historically uses "blocknote" for backward compat with legacy docs. */
  fragmentName: string;
  userName: string;
  userColor: string;
  registerImportHtml?: (fn: (html: string) => void) => void;
  registerEditor?: (editor: unknown) => void;
  /** Disable edits in the UI. The ws-server enforces this server-side too
   *  (viewer tokens have their sync updates dropped). */
  readOnly?: boolean;
}

// Custom BlockTypeSelect that handles Yjs string props (level: "1" vs 1)
const items: BlockTypeSelectItem[] = [
  { name: "Paragraph", type: "paragraph", icon: RiText },
  { name: "Heading 1", type: "heading", props: { level: 1 }, icon: RiH1 },
  { name: "Heading 2", type: "heading", props: { level: 2 }, icon: RiH2 },
  { name: "Heading 3", type: "heading", props: { level: 3 }, icon: RiH3 },
  { name: "Quote", type: "quote", icon: RiQuoteText },
  { name: "Bullet List", type: "bulletListItem", icon: RiListUnordered },
  { name: "Numbered List", type: "numberedListItem", icon: RiListOrdered },
  { name: "Check List", type: "checkListItem", icon: RiListCheck3 },
];

function CollabBlockTypeSelect() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const selectedBlocks = useEditorState({
    editor,
    selector: ({ editor }: { editor: any }) =>
      editor.getSelection()?.blocks || [editor.getTextCursorPosition().block],
  });
  const block = selectedBlocks[0];

  const selectItems = items.map((item) => {
    const Icon = item.icon;
    const typesMatch = item.type === block.type;
    // Use loose equality (==) to handle Yjs string/number mismatch
    const propsMatch = Object.entries(item.props || {}).every(
      ([k, v]) => v == block.props[k]
    );
    return {
      text: item.name,
      icon: <Icon size={16} />,
      onClick: () => {
        editor.focus();
        for (const b of selectedBlocks) {
          editor.updateBlock(b, { type: item.type as any, props: item.props as any });
        }
      },
      isSelected: typesMatch && propsMatch,
    };
  });

  if (!selectItems.some((i) => i.isSelected) || !editor.isEditable) return null;

  return <Components.FormattingToolbar.Select className="bn-select" items={selectItems} />;
}

export default function Editor({ ydoc, provider, fragmentName, userName, userColor, registerImportHtml, registerEditor, readOnly }: EditorProps) {
  // Resolve the fragment from the shared ydoc. Memoized on fragmentName so
  // useCreateBlockNote gets a stable reference per page — when fragmentName
  // changes (tab switch), the parent should remount us via a React key, which
  // gives us a fresh BlockNote instance bound to the new fragment.
  const fragment = useMemo(() => ydoc.getXmlFragment(fragmentName), [ydoc, fragmentName]);

  const editor = useCreateBlockNote({
    schema: editorSchema,
    extensions: [typographyShortcutsExtension],
    collaboration: {
      provider,
      fragment,
      user: {
        name: userName,
        color: userColor,
      },
    },
  });

  // Expose editor instance to parent (for outline panel, etc.)
  useEffect(() => {
    if (!registerEditor || !editor) return;
    registerEditor(editor);
    return () => registerEditor(null);
  }, [editor, registerEditor]);

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

  return (
    <BlockNoteView editor={editor} theme="light" formattingToolbar={false} sideMenu={false} editable={!readOnly}>
      <FormattingToolbarController
        formattingToolbar={() => {
          const defaultItems = getFormattingToolbarItems();
          // Replace default BlockTypeSelect (first item) with our Yjs-compatible version
          return (
            <FormattingToolbar>
              <CollabBlockTypeSelect />
              {defaultItems.slice(1)}
            </FormattingToolbar>
          );
        }}
      />
      {/* Custom drag-handle menu with "Turn into" — Notion-like quick block-type switching
          without selecting text. Default BlockNote drag-handle menu only has Delete + Colors. */}
      <SideMenuController
        sideMenu={(props) => (
          <SideMenu
            {...props}
            dragHandleMenu={() => (
              <DragHandleMenu>
                <TurnIntoItem>Turn into</TurnIntoItem>
                <RemoveBlockItem>Delete</RemoveBlockItem>
                <BlockColorsItem>Colors</BlockColorsItem>
              </DragHandleMenu>
            )}
          />
        )}
      />
    </BlockNoteView>
  );
}
