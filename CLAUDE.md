# CLAUDE.md — notes for coding agents

See `README.md` for the user-facing description and `AGENTS.md` for the hard
rule about this project using Next.js 16 (not your training-data Next.js).

## Architecture at a glance

Two processes:

1. **Next.js app** (`app/`) — UI, auth, REST API. Deployed to Vercel.
2. **ws-server** (`server/ws-server.ts`) — a single Node.js process that hosts
   three servers on the same port: WebSocket sync for Yjs, a small REST API,
   and an HTTP MCP endpoint at `/mcp`. Deployed to Railway with a SQLite volume.

The two processes share state only via:
- the **SQLite database** (metadata + serialized Yjs state), and
- short-lived **y-websocket clients** opened by the Next.js REST layer
  (`lib/yjs-api-bridge.ts`) when it needs to apply an edit.

## Yjs / BlockNote model

The editor content lives in a `Y.XmlFragment` named `blocknote`. Structure:

```
fragment
└── blockGroup
    └── blockContainer (id = nanoid)
        ├── heading | paragraph | bulletListItem | … (attrs: level, colors, alignment)
        │   └── Y.XmlText  (inline formatting via marks)
        └── blockGroup?  (nested children)
```

**Critical quirks** (learned the hard way — don't rediscover them):

- Yjs stores every block attr as a **string**: `level: "1"`, `isToggleable: "false"`.
  When comparing to BlockNote API values (numbers/booleans), use loose equality
  (`==`) or coerce. This is why `components/Editor.tsx` ships a
  `CollabBlockTypeSelect` that replaces the default `BlockTypeSelect` — the
  default uses `!==` and hides itself on headings.
- Inline marks through y-prosemirror are stored as `{ markName: markAttrs }`.
  Links are `{ link: { href: "…" } }`, **not** `{ link: "…"}`.
- `Y.XmlText#toJSON()` on a text with marks returns ProseMirror XML
  (`<link 0="h" 1="t" …>`). For clean output use `toDelta()` and reconstruct
  markdown (`server/ws-server.ts → getTextContent`).
- `Y.XmlText#insert(pos, text, attrs)` inherits formatting from the previous
  insert unless you pass an explicit `{}` attrs object. If you're appending
  unformatted text after a styled run, pass `{}`.
- `getAttribute()` on a **detached** `Y.XmlElement` returns `""`. If you need
  the ID of a newly-created block, store it in a local variable before
  inserting the element into the tree.

## MCP tools (defined in `server/ws-server.ts`)

Always go through the Yjs layer so changes are broadcast to live editors:

| Tool | Function used |
| --- | --- |
| `read_document` | `extractBlocksWithIds(ydoc)` |
| `edit_document` | `parseMarkdown → appendBlocks / replaceAll` |
| `update_block` | `updateBlockText` |
| `insert_block` | `insertBlockAfter` |
| `delete_block` | `deleteBlock` |
| `create_table` | `appendTable` / `insertTableAfter` |

The tool **descriptions** (string passed to `mcp.tool(...)`) are where Claude
actually reads instructions — the `instructions` field on `McpServer` is often
ignored by clients. So when you want Claude to behave differently (e.g. use
colors), update the descriptions and the tool responses, not just
`MCP_INSTRUCTIONS`.

## Editor component

`components/Editor.tsx` is a client component. Do not put business logic in it —
it's purely the BlockNote integration. The parent (`app/doc/[id]/...`) owns
state like current user and registers callbacks via refs
(`registerImportHtml`). The `formattingToolbar={false}` override is deliberate;
see the Yjs string-vs-number note above.

## REST bridge gotcha

`lib/yjs-api-bridge.ts` ends with a hardcoded 2-second sleep to let the
WS server persist the change before the HTTP handler returns. It's ugly but it
exists because the WS server debounces saves at 500 ms. If you change the
debounce, change the sleep.

## UI language

**All UI is English. Always.** Button labels, tooltips, alerts, error
toasts, placeholders, empty states, dropdown descriptions — everything
the user sees in the chrome is in English, no exceptions. This applies
even if the conversation with the user is in Russian.

The one deliberate exception is the hidden AI-setup instruction block
in `app/doc/[id]/page.tsx` — that's content aimed at end users via an
AI agent, not UI chrome.

## Do / don't

- **Do** keep SQLite writes debounced — the WS server handles this.
- **Do** validate `docId` against `^[A-Za-z0-9_-]+$` whenever it comes from a
  URL; the ws-server already enforces this.
- **Don't** call `ydoc.destroy()` while the debounce timer is still scheduled;
  clear the timer first.
- **Don't** duplicate the Yjs traversal logic — if you need to extract blocks
  again, reuse `extractBlocksWithIds` or refactor both call sites.
- **Don't** put Russian (or any non-English) strings into UI components.
  See "UI language" above.

## Release checklist

After shipping any user-visible change (new MCP tool, new feature,
changed behavior, deprecation), DO TWO THINGS before considering the
work done. Skipping these is the difference between "feature shipped"
and "feature discoverable."

### 1. Update `lib/release-notes.ts` — only for MCP-surface changes

Required when the change is observable through the MCP tool surface —
new tool, removed tool, changed tool behavior or description. Skip for
pure UI- or REST-only changes.

- Bump `MCP_SERVER_VERSION` (semver: minor for new tools, patch for
  bugfixes, major for breaking).
- Add a `RELEASE_NOTES` entry written **for the end user** — what they
  can do that they couldn't before. Not "added X function" — write
  "ask Claude to X."

That single diff updates two surfaces simultaneously: the in-Claude
hint (`server/ws-server.ts` injects on first authenticated tool call
after a bump) AND the dashboard banner
(`app/dashboard/page.tsx` reads the same map).

### 2. Update the project documentation doc

Doc ID: `rUYNEJ_qBV` ("PostPaper — внутренняя документация проекта").
Required for EVERY user-observable change AND every internal
architectural decision worth remembering (incidents, quirks, gotchas).

- Use surgical `insert_block` / `update_block` — never
  `edit_document(replace)`.
- Common landing sections:
  - §2 «Основные фичи» — new user-visible features
  - §3 «Критические особенности» — hard-won quirks, BlockNote/Yjs gotchas
  - §6 «REST API» — new endpoints
  - §7 «Структура репозитория» — new files
  - §9 «Деплой» — operational changes (admin endpoints, infra notes)
  - §10 «Do/Don't» — rules learned from incidents
  - §12 «Что дальше» — backlog items

When unsure whether something deserves doc, lean toward yes. Cost is
a paragraph. Benefit is no future agent rediscovering the same trap.

## Legacy code

`mcp-server/` is an **older** stdio MCP that wraps the REST API. It's not
deployed; it exists so Claude Code (CLI) can mount an MCP without an HTTP
tunnel. If you edit tools, update both places or deprecate `mcp-server/`.

## Running locally

```bash
npm run ws-server   # terminal 1
npm run dev         # terminal 2
```

Data ends up in `./data/collab-docs.db`. Keep the two SQLite backups in that
folder out of git — they are there for hand-rollback during development.
