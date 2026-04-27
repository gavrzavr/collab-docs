"use client";

/**
 * Tiptap extension that auto-replaces common arrow ASCII sequences with
 * their Unicode counterparts as the user types. Mirrors what Notion /
 * Google Docs do.
 *
 * What's intentionally NOT included:
 *   - `->` alone — collides with JS arrow functions, type annotations,
 *     Hindley-Milner notation, etc. Users typing prose can use the
 *     longer `-->` (double dash) or the en-dash variant `–>`.
 *   - `=>`, `<=`, `>=` — conflict with code (comparison operators,
 *     fat-arrow functions). If we ever add a "code paragraph" mode we
 *     can revisit; for now, prose-leaning rules only.
 *   - Curly quotes — too easy to break copy-pasted code.
 *
 * BlockNote / tiptap InputRules don't fire inside code blocks by default,
 * so even the rules we do include are safe in `code`/`codeBlock` contexts.
 */
import { Extension, InputRule } from "@tiptap/core";

function arrowRule(pattern: RegExp, replacement: string): InputRule {
  return new InputRule({
    find: pattern,
    handler: ({ state, range }) => {
      state.tr.replaceWith(range.from, range.to, state.schema.text(replacement));
    },
  });
}

export const ArrowShortcuts = Extension.create({
  name: "postpaperArrowShortcuts",
  addInputRules() {
    return [
      // Bidirectional first (longer matches must come before shorter ones
      // so the regex engine doesn't bail out on the prefix).
      arrowRule(/<-->$/, "↔"),
      arrowRule(/<–>$/, "↔"),
      // Right
      arrowRule(/-->$/, "→"),
      arrowRule(/–>$/, "→"),
      // Left
      arrowRule(/<--$/, "←"),
      arrowRule(/<–$/, "←"),
    ];
  },
});
