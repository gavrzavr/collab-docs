"use client";

/**
 * "Turn into" submenu item for the drag-handle menu (sidemenu).
 *
 * Reproduces Notion's UX: click the drag-dots → Turn into → pick block
 * type (Paragraph / Heading 1-3 / Quote / Bullet / Numbered / Check),
 * without first having to select the block's text.
 *
 * Implementation notes:
 *
 * - The current block is read from `SideMenuExtension` state (the same
 *   source `BlockColorsItem` uses), not from the editor's selection —
 *   the user opened the menu by clicking the drag-handle, the cursor
 *   may be elsewhere.
 *
 * - We use loose equality (`==`) when matching the current type so the
 *   "selected" indicator works for headings even though Yjs stores
 *   `level` as a STRING ("1") while BlockNote runtime expects a NUMBER
 *   (1). Same Yjs string-vs-number quirk that motivated the
 *   `CollabBlockTypeSelect` in `Editor.tsx` — see project doc § 3.
 *
 * - The submenu pattern follows `BlockColorsItem` from @blocknote/react:
 *   `Menu.Root sub` + `Menu.Trigger sub` + `Menu.Dropdown sub`.
 */
import { ReactNode } from "react";
import {
  RiText, RiH1, RiH2, RiH3, RiListUnordered, RiListOrdered, RiListCheck3, RiQuoteText,
} from "react-icons/ri";
import { useComponentsContext, useBlockNoteEditor } from "@blocknote/react";
import { useExtensionState } from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";

interface TypeOption {
  name: string;
  type: string;
  // Optional props (e.g. heading level). Compared with `==` against the
  // block's current props because Yjs stores them stringified.
  props?: Record<string, unknown>;
  Icon: React.ComponentType<{ size?: number | string }>;
}

const OPTIONS: TypeOption[] = [
  { name: "Paragraph",     type: "paragraph",        Icon: RiText },
  { name: "Heading 1",     type: "heading",          props: { level: 1 }, Icon: RiH1 },
  { name: "Heading 2",     type: "heading",          props: { level: 2 }, Icon: RiH2 },
  { name: "Heading 3",     type: "heading",          props: { level: 3 }, Icon: RiH3 },
  { name: "Quote",         type: "quote",            Icon: RiQuoteText },
  { name: "Bullet List",   type: "bulletListItem",   Icon: RiListUnordered },
  { name: "Numbered List", type: "numberedListItem", Icon: RiListOrdered },
  { name: "Check List",    type: "checkListItem",    Icon: RiListCheck3 },
];

export function TurnIntoItem(props: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();

  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  if (!block) return null;

  // Don't show "Turn into" for blocks where it makes no sense
  // (htmlViz, table — converting them via this menu would lose content).
  // Tables and htmlViz blocks have non-text content; flipping their
  // type to "paragraph" would drop everything.
  if (block.type === "htmlViz" || block.type === "table") return null;

  return (
    <Components.Generic.Menu.Root position={"right"} sub={true}>
      <Components.Generic.Menu.Trigger sub={true}>
        <Components.Generic.Menu.Item
          className={"bn-menu-item"}
          subTrigger={true}
        >
          {props.children}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>

      <Components.Generic.Menu.Dropdown
        sub={true}
        className={"bn-menu-dropdown"}
      >
        {OPTIONS.map((opt) => {
          const typesMatch = block.type === opt.type;
          const propsMatch = Object.entries(opt.props || {}).every(
            // eslint-disable-next-line eqeqeq
            ([k, v]) => v == (block.props as Record<string, unknown>)[k]
          );
          const isCurrent = typesMatch && propsMatch;
          const Icon = opt.Icon;
          return (
            <Components.Generic.Menu.Item
              key={`${opt.type}-${JSON.stringify(opt.props || {})}`}
              className={"bn-menu-item"}
              icon={<Icon size={16} />}
              checked={isCurrent}
              onClick={() => {
                editor.focus();
                editor.updateBlock(block, {
                  type: opt.type as never,
                  props: (opt.props as never) ?? undefined,
                });
              }}
            >
              {opt.name}
            </Components.Generic.Menu.Item>
          );
        })}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
