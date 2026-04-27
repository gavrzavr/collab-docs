"use client";

/**
 * Tiptap extension that auto-replaces common ASCII typography sequences
 * with their Unicode counterparts as the user types. Mirrors what
 * Notion / Google Docs do.
 *
 * Conservative set — only sequences that are unambiguously prose:
 *   Arrows: `-->` `–>` → `→`, `<--` `<–` → `←`, `<-->` `<–>` → `↔`
 *   Symbols: `(c)` → `©`, `(r)` → `®`, `(tm)` → `™` (case-insensitive)
 *   Ellipsis: `...` → `…`
 *
 * What's intentionally NOT included:
 *   - `->` alone — collides with JS arrow functions, type annotations,
 *     Hindley-Milner notation. Users can use the explicit `-->` /  `–>`.
 *   - `=>`, `<=`, `>=` — comparison operators / fat-arrow functions.
 *   - `--` → `–` (en-dash) — would block `-->` → `→` since it'd fire
 *     before the third character. Users typing en-dash do it directly
 *     (Option+- on Mac, etc.).
 *   - Curly quotes — too easy to break copy-pasted code.
 *
 * Tiptap InputRules don't fire inside code blocks by default, so even
 * the rules we do include are safe in `code` / `codeBlock` contexts.
 */
import { Extension, InputRule } from "@tiptap/core";

function replaceRule(pattern: RegExp, replacement: string): InputRule {
  return new InputRule({
    find: pattern,
    handler: ({ state, range }) => {
      state.tr.replaceWith(range.from, range.to, state.schema.text(replacement));
    },
  });
}

export const TypographyShortcuts = Extension.create({
  name: "postpaperTypographyShortcuts",
  addInputRules() {
    return [
      // Bidirectional arrows first — longer matches must come before
      // shorter ones so the regex engine doesn't bail out on the prefix.
      replaceRule(/<-->$/, "↔"),
      replaceRule(/<–>$/, "↔"),
      // Right arrow
      replaceRule(/-->$/, "→"),
      replaceRule(/–>$/, "→"),
      // Left arrow
      replaceRule(/<--$/, "←"),
      replaceRule(/<–$/, "←"),
      // Symbols (case-insensitive)
      replaceRule(/\(c\)$/i, "©"),
      replaceRule(/\(r\)$/i, "®"),
      replaceRule(/\(tm\)$/i, "™"),
      // Ellipsis — fires on the third dot.
      replaceRule(/\.\.\.$/, "…"),
    ];
  },
});
