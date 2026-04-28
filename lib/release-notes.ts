/**
 * Single source of truth for MCP server version + release notes.
 *
 * Imported by:
 *   - server/ws-server.ts → injects "what's new" hint into the first
 *     authenticated MCP tool response per (user, version) pair so users
 *     learn that they need to reconnect their MCP client to see new tools.
 *   - app/dashboard/page.tsx → shows a dismissible banner with the same
 *     content for users who land on the dashboard.
 *
 * When shipping a new tool / behavior change:
 *   1. Bump MCP_SERVER_VERSION (semver, e.g. "0.5.0" → "0.6.0").
 *   2. Add an entry to RELEASE_NOTES describing it in one sentence
 *      addressed at the end user — they're the audience, not us.
 *   3. Older entries stay; the hint will list everything newer than what
 *      the user last saw, so a user who last connected at 0.4.x sees
 *      both 0.5.0 and 0.6.0 notes on first call after the 0.6.0 deploy.
 */

export const MCP_SERVER_VERSION = "0.6.2";

export const RELEASE_NOTES: Record<string, string> = {
  "0.5.0":
    "New tool: list_my_documents — lists every PostPaper doc you own or that's shared with you. Ask Claude 'what docs do I have access to in PostPaper?'",
  "0.5.1":
    "create_table no longer renders ghost empty columns when Claude accidentally pads rows with trailing empty cells. Tables in your docs that already have phantom columns from earlier — ask Claude to recreate them and they'll come out clean.",
  "0.5.2":
    "Documented a known issue with create_table: when you have the same doc open in another browser tab while Claude inserts a table, BlockNote's normalization can pad rows with ghost empty columns. Workaround: close other tabs of the doc before asking Claude to insert tables. Permanent fix is in backlog.",
  "0.5.3":
    "Reverted a speculative create_table fix that broke the editor (blank screen on docs containing affected tables). Tables created via Claude during 0.5.2 may now render correctly again — refresh the doc. Ghost-columns issue from 0.5.2 release notes is back to known-issue status.",
  "0.6.0":
    "create_table ghost-columns bug FIXED. Root cause diagnosed via DevTools: cells were missing 4 schema attrs (textColor, backgroundColor, textAlignment, colwidth) and had colspan/rowspan as STRINGS instead of NUMBERS. BlockNote's normalization treated the type mismatch as 'broken cell' and recursively padded rows. Now cells match BlockNote's schema-default shape exactly. Old tables in your docs are still corrupt — ask Claude to recreate them.",
  "0.6.1":
    "create_table tool description cleaned up — removed the obsolete 'KNOWN ISSUE: close other tabs' warning that Claude was still reading after the v0.6.0 fix. New tables work fine with any number of open tabs. Description now also tells Claude how to repair pre-v0.6.0 broken tables (delete + recreate).",
  "0.6.2":
    "When you paste a postpaper.co URL into a fresh Claude chat, Claude will now read it via the PostPaper MCP instead of trying WebFetch (which only saw the login page and gave up). Strengthened the read_document tool description with an explicit URL trigger. After reconnect, just paste the link — Claude will recognize and open it directly.",
};

/** Compares two semver-ish version strings ("a.b.c"). Returns -/0/+. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Returns release notes for every version strictly newer than `lastSeen`.
 * Empty array means user is up to date. Used by both surfaces to render
 * the same content.
 */
export function notesNewerThan(lastSeen: string): Array<{ version: string; note: string }> {
  return Object.keys(RELEASE_NOTES)
    .filter((v) => compareVersions(v, lastSeen) > 0)
    .sort(compareVersions)
    .map((v) => ({ version: v, note: RELEASE_NOTES[v] }));
}
