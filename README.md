# PostPaper

Real-time collaborative block editor with an MCP server that lets Claude read
and write documents directly.

- **Editor**: Next.js 16 + React 19 + [BlockNote](https://www.blocknotejs.org/) on
  [Mantine](https://mantine.dev/), with Yjs/y-websocket for CRDT-based multi-user
  collaboration.
- **Realtime server** (`server/ws-server.ts`): single Node.js process that serves
  WebSocket sync, a REST API, and an HTTP MCP endpoint. State lives in a SQLite
  file (`better-sqlite3`, WAL mode).
- **MCP integration**: Claude connects via HTTP MCP (`/mcp`) and uses six tools to
  edit documents: `read_document`, `edit_document`, `update_block`, `insert_block`,
  `delete_block`, `create_table`.
- **Auth**: NextAuth v5 (Google sign-in). Each document has an owner and appears
  in `/dashboard`.

```
┌─────────────┐  WebSocket (Yjs)   ┌──────────────────────────┐
│ BlockNote   │ ─────────────────▶ │                          │
│ (browser)   │ ◀───────────────── │  ws-server.ts            │
└─────────────┘                    │  ┌────────────────────┐  │
                                   │  │ WebSocket (y-proto)│  │
┌─────────────┐  HTTPS /mcp        │  │ REST /api/v1       │  │
│   Claude    │ ─────────────────▶ │  │ MCP  /mcp          │  │
└─────────────┘                    │  └────────────────────┘  │
                                   │         │                │
                                   │         ▼                │
                                   │    SQLite (WAL)          │
                                   └──────────────────────────┘
```

## Getting started

```bash
npm install
cp .env.example .env.local            # then fill in secrets (see below)
npm run ws-server                     # terminal 1 — WS + MCP on :1234
npm run dev                           # terminal 2 — Next.js on :3000
```

Open <http://localhost:3000>, sign in, create a document.

### Required environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `AUTH_SECRET` | Next.js | NextAuth session encryption |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Next.js | Google OAuth |
| `NEXT_PUBLIC_WS_URL` | Next.js (browser) | e.g. `wss://your-railway-app.up.railway.app` |
| `WS_URL` | Next.js (server) | Same host, used by the REST bridge |
| `DATA_DIR` | ws-server | Where SQLite lives (defaults to `/app/data` on Railway, `./data` locally) |
| `PORT` | ws-server | WS + MCP port (default 1234) |
| `VERCEL_URL` | ws-server | Public URL of the Next.js app (used in MCP responses) |

## Deployment

- **Next.js** → Vercel (static-ish; uses Edge-style route handlers).
- **ws-server** → Railway with a mounted volume at `/app/data` (SQLite persistence).
  `railway.json` and `Dockerfile` at the repo root build and run it.

On Railway redeploy the server receives SIGTERM; `persistAllDocs()` flushes every
in-memory Yjs doc to SQLite before exit.

## Connecting Claude

The MCP endpoint is public (no auth). That's OK for the current MVP because
document IDs are unguessable nanoids — anyone without the ID can't find the
doc. Revisit this before moving to sensitive content.

**Endpoint:** `https://ws.postpaper.co/mcp`

### Claude.ai (web)

1. Settings → Connectors → **Add custom connector**
2. Name: `PostPaper` · URL: the endpoint above
3. Save, then click **Connect**

### Claude Desktop

1. Settings → Connectors → **Add custom connector**
2. Same URL as above
3. Fully quit the app (⌘Q on macOS) and reopen so it picks up the new tools

### Claude Code (CLI)

```bash
claude mcp add --transport http collab-docs https://ws.postpaper.co/mcp
```

### Verifying the connection

Ask Claude: *"What tools do you have for collab-docs?"*

You should see a live, block-based editor framing and six tools:
`read_document`, `edit_document`, `update_block`, `insert_block`,
`delete_block`, `create_table`. If the framing talks about
"Editorial Typography Expert" you're on an old cached description — see
**When tools look stale** below.

### Giving Claude a document

Paste the document URL or ID into the chat, e.g.
`https://postpaper.co/doc/abc123`. Claude extracts the ID and
calls `read_document`. IDs must match `^[A-Za-z0-9_-]{1,64}$`; anything else
is rejected server-side.

Example prompts:

- *"Read https://postpaper.co/doc/abc123 and summarize it."*
- *"In that doc, turn the third bullet into a heading and make the price bold."*
- *"Add a table of Q1 metrics after the Revenue section."*

### When tools look stale

MCP clients cache tool descriptions at connection time. After we push changes
to tool descriptions or add new tools, you need to reconnect to pick them up:

- Claude.ai / Desktop: Settings → Connectors → disconnect PostPaper →
  connect again.
- Claude Code: `claude mcp remove collab-docs` then re-run the `add` command.

Quick sanity check: ask Claude *"what's the first rule of editing
collab-docs?"* — current tool descriptions start with *"think in blocks, not
pages"*. An old cache will sound like *"Editorial Typography Expert"*.

### Tools

| Tool | Purpose |
| --- | --- |
| `read_document` | Return blocks with IDs, types, and markdown text |
| `edit_document` | Append (default) or replace content from markdown |
| `update_block` | Replace text and/or attrs (type, colors, alignment) on one block |
| `insert_block` | Insert a new block after a given ID |
| `delete_block` | Remove a block by ID |
| `create_table` | Insert a table from a 2D array |

For targeted edits always prefer `update_block` / `insert_block` /
`delete_block` over `edit_document(mode="replace")` — they preserve block
IDs, don't disturb other collaborators, and keep cursor positions valid for
everyone editing live.

Inline formatting in all `text` arguments: `**bold**`, `*italic*`,
`~~strike~~`, `` `code` ``, `__underline__`, `[label](url)`.

Colors accepted by `update_block` / `insert_block`: `default`, `gray`,
`brown`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`.

### Legacy stdio MCP (`mcp-server/`)

There's an older stdio variant under `mcp-server/` that wraps the REST API.
It exists so Claude Code can mount an MCP without an HTTP tunnel during
local development. For everything else, prefer the HTTP endpoint above.

## REST API

Minimal surface under `/api/v1/docs`:

- `GET /api/v1/docs` — list current user's documents
- `POST /api/v1/docs` — create a new document (returns `{ id }`)
- `GET /api/v1/docs/:id` — document metadata
- `GET /api/v1/docs/:id/text` — plain-text dump (used by the standalone stdio MCP)
- `POST /api/v1/docs/:id/append` — append markdown blocks
- `POST /api/v1/docs/:id/replace` — replace whole document from markdown
- `GET /api/v1/docs/:id/export?format=docx|md` — download

All writes go through `lib/yjs-api-bridge.ts`, which opens a short-lived
y-websocket client, applies the operation in a transaction, and waits for the
WS server to persist.

## Repository layout

```
app/                  Next.js app router (UI + REST API)
components/Editor.tsx BlockNote editor + custom FormattingToolbar
lib/                  DB helpers, Yjs bridge, export utilities
server/ws-server.ts   WebSocket + REST + HTTP MCP (single process)
mcp-server/           Legacy stdio MCP (wraps REST API; kept for local Claude Code)
data/                 SQLite database + WAL files (gitignored on prod)
```

## Scripts

- `npm run dev` — Next.js dev server
- `npm run build` — production build
- `npm run ws-server` — run the WS + MCP server with `tsx`
- `npm run lint` — ESLint
