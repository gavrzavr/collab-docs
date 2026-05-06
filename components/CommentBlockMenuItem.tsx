"use client";

/**
 * "Comment" item for the drag-handle menu (sidemenu).
 *
 * Pattern mirrors CopyLinkItem / TurnIntoItem — read the active block
 * from SideMenuExtension state and call the parent's `onPickBlock`
 * callback with that block's id. The parent (DocClient) opens the
 * comments panel and points its composer at that block.
 *
 * We deliberately don't open a popover here — the user's mental model
 * is "all comments live in the right panel; per-block actions just
 * pre-fill the composer over there." Single surface for all comment UX.
 */
import { ReactNode } from "react";
import { RiChat3Line } from "react-icons/ri";
import {
  useComponentsContext,
  useBlockNoteEditor,
  useExtensionState,
} from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";

interface CommentBlockMenuItemProps {
  children: ReactNode;
  /** Called with the block id that the user wants to comment on.
   *  Parent should: open the comments panel, set the composer's
   *  target block id, focus the composer textarea. */
  onPickBlock: (blockId: string) => void;
}

export function CommentBlockMenuItem({
  children,
  onPickBlock,
}: CommentBlockMenuItemProps) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  if (!block) return null;

  return (
    <Components.Generic.Menu.Item
      className={"bn-menu-item"}
      icon={<RiChat3Line size={16} />}
      onClick={() => onPickBlock(String(block.id))}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}
