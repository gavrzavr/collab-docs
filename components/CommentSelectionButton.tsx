"use client";

/**
 * "Add comment" button in BlockNote's FormattingToolbar — appears when
 * the user has text selected. Click → resolves the BLOCK containing the
 * selection start and asks the parent to open the comments composer
 * targeting that block.
 *
 * Why block-level even though this lives in the text-selection toolbar:
 * our v1 storage anchors comments to a block id. Selecting text inside
 * a block and clicking this still gets you a comment on the right block;
 * we just don't yet save the highlighted range. v2 would upgrade to
 * Yjs-RelativePosition-anchored ranges with a custom mark, exposed via
 * BlockNote's CommentsExtension or our own equivalent. For now this is
 * the discoverable entry point users want — "select → comment" matches
 * Notion / Docs muscle memory.
 */
import { useCallback } from "react";
import { RiChat3Line } from "react-icons/ri";
import { useComponentsContext, useBlockNoteEditor } from "@blocknote/react";

interface CommentSelectionButtonProps {
  onAddComment: (blockId: string) => void;
}

export function CommentSelectionButton({ onAddComment }: CommentSelectionButtonProps) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();

  const handleClick = useCallback(() => {
    // The selection always lives inside a block; getTextCursorPosition()
    // returns the block surrounding the cursor (selection start). For a
    // multi-block selection the user gets the first block — fine for v1
    // since we anchor to a single block anyway.
    const pos = editor.getTextCursorPosition();
    const blockId = pos?.block?.id;
    if (typeof blockId === "string") onAddComment(blockId);
  }, [editor, onAddComment]);

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Comment"
      mainTooltip="Add a comment on this block"
      icon={<RiChat3Line />}
      onClick={handleClick}
    />
  );
}
