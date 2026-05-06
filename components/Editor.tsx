"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import {
  useCreateBlockNote, FormattingToolbarController, FormattingToolbar, getFormattingToolbarItems,
  useBlockNoteEditor, useComponentsContext, useEditorState,
  SideMenuController, SideMenu,
  DragHandleMenu, BlockColorsItem, RemoveBlockItem,
  SuggestionMenuController, getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import type { BlockTypeSelectItem, DefaultReactSuggestionItem } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { createExtension } from "@blocknote/core";
import { TurnIntoItem } from "./TurnIntoItem";
import { CopyLinkItem } from "./CopyLinkItem";
import { CommentBlockMenuItem } from "./CommentBlockMenuItem";
import { CommentSelectionButton } from "./CommentSelectionButton";
import { RiText, RiH1, RiH2, RiH3, RiListUnordered, RiListOrdered, RiListCheck3, RiQuoteText, RiLinkM } from "react-icons/ri";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import { useEffect, useMemo } from "react";

import { editorSchema } from "./blocknote-schema";
import { TypographyShortcuts } from "./typography-shortcuts";
import { uploadImage } from "./image-upload";

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
  /** The doc's id (route param), used to scope image uploads to this doc
   *  for orphan-GC and observability. */
  docId: string;
  /** Active page id at mount time. Threaded into the drag-handle "Copy
   *  link" item so the URL it copies points to the right tab. */
  activePageId: string;
  registerImportHtml?: (fn: (html: string) => void) => void;
  registerEditor?: (editor: unknown) => void;
  /** Called when the user picks the "Link to block" slash-menu item.
   *  Parent (DocClient) opens a fuzzy-search modal of every tab and
   *  block in the doc; on select it inserts a link at the editor's
   *  current cursor position. */
  onOpenLinkPicker?: () => void;
  /** Called when the user picks "Comment" in the drag-handle menu. The
   *  parent should open the comments panel and target the composer at
   *  the given block id. */
  onAddComment?: (blockId: string) => void;
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

export default function Editor({ ydoc, provider, fragmentName, userName, userColor, docId, activePageId, registerImportHtml, registerEditor, onOpenLinkPicker, onAddComment, readOnly }: EditorProps) {
  // Resolve the fragment from the shared ydoc. Memoized on fragmentName so
  // useCreateBlockNote gets a stable reference per page — when fragmentName
  // changes (tab switch), the parent should remount us via a React key, which
  // gives us a fresh BlockNote instance bound to the new fragment.
  const fragment = useMemo(() => ydoc.getXmlFragment(fragmentName), [ydoc, fragmentName]);

  const editor = useCreateBlockNote({
    schema: editorSchema,
    extensions: [typographyShortcutsExtension],
    // Compress on the client, upload to /api/v1/uploads, returns the
    // final Vercel Blob URL. BlockNote stores it on the image block's
    // `url` prop. Errors surface as alert() — BlockNote doesn't have
    // a built-in toast surface in 0.47.
    uploadFile: async (file: File) => {
      try {
        return await uploadImage(file, docId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (typeof window !== "undefined") window.alert(`Image upload failed: ${msg}`);
        throw err;
      }
    },
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
    <BlockNoteView editor={editor} theme="light" formattingToolbar={false} sideMenu={false} slashMenu={false} editable={!readOnly}>
      <FormattingToolbarController
        formattingToolbar={() => {
          const defaultItems = getFormattingToolbarItems();
          // Replace default BlockTypeSelect (first item) with our Yjs-compatible version.
          // Append a Comment button at the end — discoverable entry point for
          // commenting from a text selection (Notion / Docs muscle memory).
          return (
            <FormattingToolbar>
              <CollabBlockTypeSelect />
              {defaultItems.slice(1)}
              {onAddComment && !readOnly && (
                <CommentSelectionButton onAddComment={onAddComment} />
              )}
            </FormattingToolbar>
          );
        }}
      />
      {/* Custom drag-handle menu with "Turn into" + "Copy link" — Notion-like
          quick block-type switching and intra-doc deep-linking without
          first selecting text. Default BlockNote drag-handle menu only
          has Delete + Colors. */}
      <SideMenuController
        sideMenu={(props) => (
          <SideMenu
            {...props}
            dragHandleMenu={() => (
              <DragHandleMenu>
                <TurnIntoItem>Turn into</TurnIntoItem>
                <CopyLinkItem docId={docId} activePageId={activePageId}>
                  Copy link
                </CopyLinkItem>
                {onAddComment && !readOnly && (
                  <CommentBlockMenuItem onPickBlock={onAddComment}>
                    Comment
                  </CommentBlockMenuItem>
                )}
                <RemoveBlockItem>Delete</RemoveBlockItem>
                <BlockColorsItem>Colors</BlockColorsItem>
              </DragHandleMenu>
            )}
          />
        )}
      />
      {/* Custom slash menu — defaults + "Link to block". Selecting "Link
          to block" delegates to the parent (DocClient), which opens a
          fuzzy-search modal of every tab and block. On pick, the parent
          inserts a styled link at the cursor.
          Disabled the built-in slashMenu={false} above so this controller
          is the single source of truth — otherwise both render. */}
      <SuggestionMenuController
        triggerCharacter={"/"}
        getItems={async (query) => {
          const defaults = getDefaultReactSlashMenuItems(editor);
          const linkItem: DefaultReactSuggestionItem = {
            title: "Link to block",
            subtext: "Insert a link to a tab or block in this document",
            icon: <RiLinkM size={18} />,
            group: "Other",
            aliases: ["link", "ref", "reference", "mention", "anchor"],
            onItemClick: () => {
              onOpenLinkPicker?.();
            },
          };
          const all = [...defaults, linkItem];
          const q = query.toLowerCase().trim();
          if (!q) return all;
          return all.filter((it) => {
            const hay =
              (it.title + " " + (it.subtext || "") + " " + (it.aliases || []).join(" "))
                .toLowerCase();
            return hay.includes(q);
          });
        }}
      />
    </BlockNoteView>
  );
}
