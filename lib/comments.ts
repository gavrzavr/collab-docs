/**
 * Yjs-backed comments — block-level threads stored in the same Y.Doc as the
 * editor content.
 *
 * Why Yjs and not a separate REST + websocket channel:
 *   - Sync for free through ws-server (same CRDT plumbing as the document)
 *   - Survives offline editing through y-indexeddb (the IDB mirror added
 *     04.05.2026 already covers this map, no extra wiring)
 *   - One CRDT means there's no "doc state vs comment state" merge problem
 *     when two clients comment + edit at the same time
 *
 * Storage shape — one flat `Y.Map<commentId, Comment>` keyed by nanoid.
 * Anchoring is by block id (`blockId`) plus the page id (`pageId`) the
 * block lives on; both are stable nanoids/UUIDs that survive Yjs sync.
 *
 * Threading — one level deep through `parentId`. Replies have a parentId
 * pointing at the root comment of the thread. No deeper nesting (Notion
 * convention) — threads stay readable in the side panel.
 *
 * Resolve — `resolved: true` is a soft hide. The panel filters them out
 * by default; a "Show N resolved" toggle reveals them. We do NOT delete
 * resolved comments because someone else may have replied and we want
 * the audit trail.
 *
 * Block-removal handling — if the underlying block is deleted, the
 * comment becomes "orphaned" (its `blockId` doesn't match any block on
 * `pageId`). The panel still surfaces it but flagged as removed; users
 * can delete it explicitly from the panel.
 */

import * as Y from "yjs";

const COMMENT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** ~8B-key id space — collision-resistant for our scale and short enough
 *  to keep Yjs map keys cheap. */
function generateCommentId(): string {
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += COMMENT_ID_ALPHABET[Math.floor(Math.random() * COMMENT_ID_ALPHABET.length)];
  }
  return id;
}

export type CommentAuthor = {
  /** Email is the canonical identifier. Even for AI agents we record the
   *  user-account-key email that minted the agent's session, so the
   *  attribution chain is traceable. */
  email: string;
  /** Display name. For users — Google profile name. For agents — the
   *  agent's brand name ("Claude") so the panel renders predictably. */
  name: string;
  /** Optional avatar URL (Google profile image for users). Agents pass
   *  null here; the panel substitutes a stylised AI badge. */
  image?: string | null;
  /** Discriminator — drives the visual treatment in the panel. Plain
   *  users get an avatar; agents get a 🤖 mark + the agent name. */
  kind: "user" | "agent";
};

export type Comment = {
  id: string;
  /** Block this comment is anchored to. Stable through edits; goes
   *  orphaned only if the user deletes the block. */
  blockId: string;
  /** Page (Yjs fragment id) that hosts the block. Multi-page docs need
   *  this to route the panel-click jump to the correct tab. */
  pageId: string;
  author: CommentAuthor;
  /** Plain text in v1. Markdown-with-the-same-syntax-as-the-editor is a
   *  v1.5 upgrade — easy to add later without changing the storage. */
  text: string;
  /** Unix epoch ms. Used for sort order within a thread. */
  createdAt: number;
  resolved: boolean;
  /** null for top-of-thread, otherwise the id of the comment we're
   *  replying to. One level only — replies of replies still parent to
   *  the same root. */
  parentId: string | null;
};

/** Returns the doc-scoped Yjs Map of comments. Auto-creates on first read. */
export function getCommentsMap(ydoc: Y.Doc): Y.Map<Comment> {
  return ydoc.getMap<Comment>("comments");
}

export function addComment(
  ydoc: Y.Doc,
  partial: Omit<Comment, "id" | "createdAt" | "resolved"> & {
    resolved?: boolean;
  }
): string {
  const id = generateCommentId();
  const comment: Comment = {
    ...partial,
    id,
    createdAt: Date.now(),
    resolved: partial.resolved ?? false,
  };
  getCommentsMap(ydoc).set(id, comment);
  return id;
}

export function updateCommentText(
  ydoc: Y.Doc,
  commentId: string,
  text: string
): boolean {
  const map = getCommentsMap(ydoc);
  const c = map.get(commentId);
  if (!c) return false;
  map.set(commentId, { ...c, text });
  return true;
}

export function resolveComment(
  ydoc: Y.Doc,
  commentId: string,
  resolved: boolean = true
): boolean {
  const map = getCommentsMap(ydoc);
  const c = map.get(commentId);
  if (!c) return false;
  map.set(commentId, { ...c, resolved });
  return true;
}

export function deleteComment(ydoc: Y.Doc, commentId: string): boolean {
  const map = getCommentsMap(ydoc);
  if (!map.has(commentId)) return false;
  // Also delete any replies parented to this comment so we don't leave
  // detached orphans. Cheap pass — the map is small.
  map.forEach((other, otherId) => {
    if (other.parentId === commentId) map.delete(otherId);
  });
  map.delete(commentId);
  return true;
}

export function listComments(ydoc: Y.Doc): Comment[] {
  return Array.from(getCommentsMap(ydoc).values());
}

/** Subscribe to ANY change in the map (add/update/delete). Returns
 *  unsubscribe. Uses observeDeep so updates to nested values (e.g. via
 *  set(id, {...c, resolved:true})) also fire. */
export function observeComments(ydoc: Y.Doc, cb: () => void): () => void {
  const map = getCommentsMap(ydoc);
  map.observeDeep(cb);
  return () => map.unobserveDeep(cb);
}

/** Group comments by their root thread (top-of-thread comment + replies).
 *  Returns one entry per root, with the root's metadata + replies sorted
 *  by createdAt ascending. Orphaned replies (parent missing) are promoted
 *  to roots so they don't get silently dropped. */
export type CommentThread = {
  root: Comment;
  replies: Comment[];
};

export function groupCommentsIntoThreads(comments: Comment[]): CommentThread[] {
  const byId = new Map<string, Comment>();
  for (const c of comments) byId.set(c.id, c);

  const replies = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) {
      const list = replies.get(c.parentId) || [];
      list.push(c);
      replies.set(c.parentId, list);
    } else {
      // Either top-of-thread or orphaned reply (parent deleted).
      roots.push(c);
    }
  }

  return roots
    .map((root) => ({
      root,
      replies: (replies.get(root.id) || []).sort(
        (a, b) => a.createdAt - b.createdAt
      ),
    }))
    .sort((a, b) => a.root.createdAt - b.root.createdAt);
}
