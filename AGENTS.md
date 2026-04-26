<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Release checklist (after every user-visible change)

Two things are part of every release in this repo. Skipping either is the difference between "feature shipped" and "feature discoverable." Full rules and rationale live in `CLAUDE.md` under "Release checklist" — quick reminder here:

1. **`lib/release-notes.ts`** — bump `MCP_SERVER_VERSION` and add a `RELEASE_NOTES` entry written for the end user. Required only when the change is observable through the MCP tool surface (new/removed/changed tool). One diff updates both the in-Claude hint and the dashboard banner.
2. **Project doc `rUYNEJ_qBV`** ("PostPaper — внутренняя документация проекта") — surgical `insert_block` / `update_block` describing the change. Required for every user-observable change and every architectural decision worth remembering. Common sections: §2 features, §3 quirks, §6 REST API, §7 repo structure, §9 deploy, §10 do/don't, §12 backlog.

When unsure whether something qualifies, lean toward yes — a paragraph today saves a future agent from re-discovering the same trap.
