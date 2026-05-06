"use client";

/**
 * Right-side comments navigation panel.
 *
 * Mirrors OutlinePanel's UX patterns:
 *   - Permanently visible (when toggled on) — not a popover
 *   - Lists threads sorted by their anchor block's position in the doc
 *   - Click on a thread → switch tab if needed + scroll to block + flash highlight
 *   - The thread whose anchor block is currently in viewport is shown as "active"
 *     (IntersectionObserver pattern, identical to OutlinePanel)
 *
 * Why side-rail and not floating popovers — Daria 06.05.2026: she wants to
 * SEE all comments at once and jump between them like she navigates the
 * outline panel for headings. Persistent surface is the right shape for
 * that mental model.
 *
 * Comment composition itself happens through a per-block button that
 * focuses the input here — keeping all comment UX in one surface.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import {
  type Comment,
  type CommentThread,
  addComment as yAddComment,
  deleteComment as yDeleteComment,
  groupCommentsIntoThreads,
  listComments,
  observeComments,
  resolveComment as yResolveComment,
  updateCommentText as yUpdateCommentText,
} from "@/lib/comments";

interface CommentsPanelProps {
  ydoc: Y.Doc;
  scrollContainer: HTMLElement | null;
  /** Active page id — needed when adding new comments so they're anchored
   *  to the current tab. Threads on OTHER tabs are also shown but the
   *  composer below targets the current tab. */
  activePageId: string;
  /** Resolves a thread's anchor (pageId + blockId) to "click target":
   *  switches tabs if needed and scrolls + highlights. Wired to the
   *  same `scrollToBlock` we use for intra-doc links. */
  onJumpTo: (pageId: string, blockId: string) => void;
  /** Author info for new comments. Null if user not signed in (panel
   *  hides the composer in that case). */
  currentUser:
    | { email: string; name: string; image?: string | null }
    | null;
  /** When true, the composer is hidden and resolve/delete actions are
   *  read-only. Drives /v/:token viewer behaviour. */
  readOnly?: boolean;
  /** Doc-owner gets the moderation power: delete ANY comment (not just
   *  their own). Editing a stranger's text isn't allowed — that would be
   *  rewriting someone else's words — but deletion as a spam/moderation
   *  hammer is. */
  isDocOwner?: boolean;
  /** Block id the composer should target on the next add. Set when the
   *  user clicks a per-block "Add comment" trigger — pre-fills the
   *  panel's compose target. Null = compose disabled (pick a block first). */
  composeTargetBlockId: string | null;
  /** Cleared after the user actually submits a comment, so the next
   *  click of the per-block trigger sets a fresh target. */
  onComposeTargetUsed: () => void;
}

export default function CommentsPanel({
  ydoc,
  scrollContainer,
  activePageId,
  onJumpTo,
  currentUser,
  readOnly,
  isDocOwner,
  composeTargetBlockId,
  onComposeTargetUsed,
}: CommentsPanelProps) {
  // Bump on every Yjs comments-map change to force re-derivation.
  const [tick, setTick] = useState(0);
  // Active thread id — derived from IntersectionObserver of anchor blocks.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Locked when the user click-jumps; prevents observer flips mid-scroll.
  const [preferredThreadId, setPreferredThreadId] = useState<string | null>(
    null
  );
  const observerLockedRef = useRef(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Show resolved threads toggle. Hidden by default.
  const [showResolved, setShowResolved] = useState(false);
  // Composer textarea state.
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    return observeComments(ydoc, () => setTick((t) => t + 1));
    // tick subscription is the trigger; map ref is stable per ydoc.
  }, [ydoc]);

  const allComments = useMemo<Comment[]>(
    () => listComments(ydoc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ydoc, tick]
  );

  const threads = useMemo<CommentThread[]>(() => {
    const filtered = showResolved
      ? allComments
      : allComments.filter((c) => !c.resolved || hasUnresolvedReply(c, allComments));
    return groupCommentsIntoThreads(filtered);
  }, [allComments, showResolved]);

  // Sort threads by the visual position of their anchor block within the
  // scroll container. Threads on other pages float to the bottom, grouped
  // by pageId — they're navigable but visually "elsewhere".
  const sortedThreads = useMemo(() => {
    if (!scrollContainer) return threads;
    const orderById = new Map<string, number>();
    const blocks = scrollContainer.querySelectorAll<HTMLElement>(
      ".bn-block-outer[data-id]"
    );
    blocks.forEach((el, i) => {
      const id = el.dataset.id;
      if (id) orderById.set(id, i);
    });

    const onPage: CommentThread[] = [];
    const offPage: CommentThread[] = [];
    for (const t of threads) {
      if (t.root.pageId === activePageId) onPage.push(t);
      else offPage.push(t);
    }
    onPage.sort((a, b) => {
      const ai = orderById.get(a.root.blockId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderById.get(b.root.blockId) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.root.createdAt - b.root.createdAt;
    });
    offPage.sort((a, b) => a.root.createdAt - b.root.createdAt);
    return [...onPage, ...offPage];
  }, [threads, scrollContainer, activePageId, tick]);

  // IntersectionObserver — mirror the outline panel pattern. Watches every
  // current-page anchor block and tracks which one is "topmost visible";
  // panel highlights that thread.
  const anchorIdsKey = useMemo(
    () =>
      sortedThreads
        .filter((t) => t.root.pageId === activePageId)
        .map((t) => t.root.blockId)
        .join(","),
    [sortedThreads, activePageId]
  );
  useEffect(() => {
    if (!scrollContainer || anchorIdsKey === "") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (observerLockedRef.current) return;
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort(
          (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
        );
        const topBlockId = visible[0].target.getAttribute("data-id");
        if (!topBlockId) return;
        const thread = sortedThreads.find(
          (t) => t.root.pageId === activePageId && t.root.blockId === topBlockId
        );
        if (thread) setActiveThreadId(thread.root.id);
      },
      {
        root: scrollContainer,
        rootMargin: "0px 0px -70% 0px",
        threshold: 0,
      }
    );
    const ids = anchorIdsKey.split(",");
    const raf = requestAnimationFrame(() => {
      for (const id of ids) {
        const el = scrollContainer.querySelector(
          `[data-id="${CSS.escape(id)}"].bn-block-outer`
        );
        if (el) observer.observe(el);
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [anchorIdsKey, scrollContainer, sortedThreads, activePageId]);

  useEffect(() => {
    return () => {
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    };
  }, []);

  // Focus composer when a per-block trigger sets the target.
  useEffect(() => {
    if (composeTargetBlockId && draftRef.current) {
      draftRef.current.focus();
    }
  }, [composeTargetBlockId]);

  const effectiveActiveId =
    preferredThreadId &&
    sortedThreads.some((t) => t.root.id === preferredThreadId)
      ? preferredThreadId
      : activeThreadId;

  const handleJump = useCallback(
    (thread: CommentThread) => {
      setPreferredThreadId(thread.root.id);
      observerLockedRef.current = true;
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = setTimeout(() => {
        observerLockedRef.current = false;
        unlockTimerRef.current = null;
        setPreferredThreadId(null);
      }, 600);
      onJumpTo(thread.root.pageId, thread.root.blockId);
    },
    [onJumpTo]
  );

  const handleAdd = useCallback(
    (parentId: string | null, targetBlockId: string) => {
      if (!currentUser || !draft.trim()) return;
      yAddComment(ydoc, {
        blockId: targetBlockId,
        pageId: activePageId,
        author: {
          email: currentUser.email,
          name: currentUser.name,
          image: currentUser.image ?? null,
          kind: "user",
        },
        text: draft.trim(),
        parentId,
      });
      setDraft("");
      onComposeTargetUsed();
    },
    [currentUser, draft, ydoc, activePageId, onComposeTargetUsed]
  );

  const handleResolve = useCallback(
    (commentId: string, currentlyResolved: boolean) => {
      yResolveComment(ydoc, commentId, !currentlyResolved);
    },
    [ydoc]
  );

  const handleDelete = useCallback(
    (commentId: string) => {
      if (!confirm("Delete this comment? This cannot be undone.")) return;
      yDeleteComment(ydoc, commentId);
    },
    [ydoc]
  );

  const handleEdit = useCallback(
    (commentId: string, newText: string) => {
      yUpdateCommentText(ydoc, commentId, newText.trim());
    },
    [ydoc]
  );

  const unresolvedCount = useMemo(
    () =>
      sortedThreads.filter(
        (t) => !t.root.resolved || t.replies.some((r) => !r.resolved)
      ).length,
    [sortedThreads]
  );

  return (
    <aside
      aria-label="Comments"
      className="hidden lg:flex flex-shrink-0 w-[320px] flex-col border-l border-gray-200 bg-gray-50/50"
    >
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="text-sm font-semibold text-gray-900">Comments</div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          {unresolvedCount === 0
            ? "No active threads"
            : `${unresolvedCount} active thread${unresolvedCount === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {sortedThreads.length === 0 ? (
          <div className="text-xs text-gray-500 px-2 py-4 leading-relaxed space-y-2">
            <p className="text-gray-700 font-medium">No comments yet.</p>
            <p>
              Hover any block in the document — a <span aria-hidden>💬</span>{" "}
              icon appears on the right. Click it to start a thread anchored to
              that block.
            </p>
          </div>
        ) : (
          <ul className="list-none p-0 m-0 space-y-2">
            {sortedThreads.map((thread) => {
              const isActive = effectiveActiveId === thread.root.id;
              const onCurrentPage = thread.root.pageId === activePageId;
              return (
                <li
                  key={thread.root.id}
                  className={[
                    "rounded-md border px-3 py-2 transition-colors",
                    isActive
                      ? "bg-amber-50 border-amber-300 shadow-sm"
                      : "bg-white border-gray-200 hover:border-gray-300",
                    !onCurrentPage ? "opacity-70" : "",
                  ].join(" ")}
                >
                  {!onCurrentPage && (
                    <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                      Other tab
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleJump(thread)}
                    className="w-full text-left mb-2 group"
                    title="Jump to block"
                  >
                    <div className="text-[11px] text-blue-600 group-hover:underline">
                      → Go to block
                    </div>
                  </button>
                  <CommentRow
                    comment={thread.root}
                    isAuthor={
                      currentUser?.email === thread.root.author.email
                    }
                    isDocOwner={!!isDocOwner}
                    readOnly={!!readOnly}
                    onResolve={() =>
                      handleResolve(thread.root.id, thread.root.resolved)
                    }
                    onDelete={() => handleDelete(thread.root.id)}
                    onEdit={(t) => handleEdit(thread.root.id, t)}
                  />
                  {thread.replies.length > 0 && (
                    <div className="mt-2 ml-3 pl-3 border-l-2 border-gray-200 space-y-2">
                      {thread.replies.map((r) => (
                        <CommentRow
                          key={r.id}
                          comment={r}
                          isAuthor={currentUser?.email === r.author.email}
                          isDocOwner={!!isDocOwner}
                          readOnly={!!readOnly}
                          onResolve={() => handleResolve(r.id, r.resolved)}
                          onDelete={() => handleDelete(r.id)}
                          onEdit={(t) => handleEdit(r.id, t)}
                        />
                      ))}
                    </div>
                  )}
                  {/* Reply form, available on all threads when user can write. */}
                  {currentUser && !readOnly && (
                    <ReplyForm
                      onSubmit={(text) => {
                        yAddComment(ydoc, {
                          blockId: thread.root.blockId,
                          pageId: thread.root.pageId,
                          author: {
                            email: currentUser.email,
                            name: currentUser.name,
                            image: currentUser.image ?? null,
                            kind: "user",
                          },
                          text: text.trim(),
                          parentId: thread.root.id,
                        });
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-gray-200 px-3 py-2 bg-white">
        <label className="flex items-center gap-2 text-[11px] text-gray-500 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="cursor-pointer"
          />
          Show resolved
        </label>
        {currentUser && !readOnly && composeTargetBlockId && (
          <div className="mt-2">
            <div className="text-[11px] text-gray-500 mb-1">
              New comment on selected block:
            </div>
            <textarea
              ref={draftRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleAdd(null, composeTargetBlockId);
                }
              }}
              placeholder="Write a comment… (⌘↩ to send)"
              rows={3}
              className="w-full text-sm border border-gray-300 rounded p-2 outline-none focus:border-blue-500"
            />
            <div className="flex items-center justify-between mt-1">
              <button
                type="button"
                onClick={() => onComposeTargetUsed()}
                className="text-[11px] text-gray-400 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleAdd(null, composeTargetBlockId)}
                disabled={!draft.trim()}
                className="text-[12px] px-3 py-1 bg-blue-600 text-white rounded font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Returns true if any reply on this comment's thread is unresolved.
 *  Used to keep the whole thread visible while showResolved is false
 *  but the root has been resolved — otherwise resolving a root would
 *  hide active replies, which would be confusing. */
function hasUnresolvedReply(c: Comment, all: Comment[]): boolean {
  if (!c.parentId) {
    // c is a root — check its replies.
    return all.some((other) => other.parentId === c.id && !other.resolved);
  }
  return false;
}

/** One comment line — author + relative time + text + actions.
 *
 * Action visibility rules:
 *   Resolve/Reopen: anyone non-readOnly (collaborative action)
 *   Edit:           only the comment's author
 *   Delete:         comment author OR doc owner (moderation)
 */
function CommentRow({
  comment,
  isAuthor,
  isDocOwner,
  readOnly,
  onResolve,
  onDelete,
  onEdit,
}: {
  comment: Comment;
  isAuthor: boolean;
  isDocOwner: boolean;
  readOnly: boolean;
  onResolve: () => void;
  onDelete: () => void;
  onEdit: (newText: string) => void;
}) {
  const canDelete = isAuthor || isDocOwner;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  useEffect(() => {
    if (!editing) setDraft(comment.text);
  }, [comment.text, editing]);

  return (
    <div className={comment.resolved ? "opacity-60" : ""}>
      <div className="flex items-baseline gap-2 mb-0.5">
        {comment.author.kind === "agent" ? (
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-gray-700">
            <span aria-hidden className="text-[11px]">🤖</span>
            {comment.author.name}
          </span>
        ) : (
          <span className="text-[12px] font-medium text-gray-800">
            {comment.author.name}
          </span>
        )}
        <span className="text-[10px] text-gray-400">
          {formatRelativeTime(comment.createdAt)}
        </span>
        {comment.resolved && (
          <span className="text-[10px] text-emerald-600 ml-auto">resolved</span>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="w-full text-[13px] border border-gray-300 rounded p-1.5 outline-none focus:border-blue-500"
          />
          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={() => {
                if (draft.trim() && draft.trim() !== comment.text) onEdit(draft);
                setEditing(false);
              }}
              className="text-[11px] text-blue-600 hover:underline"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(comment.text);
                setEditing(false);
              }}
              className="text-[11px] text-gray-400 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[13px] text-gray-800 whitespace-pre-wrap leading-snug break-words">
          {comment.text}
        </div>
      )}
      {!editing && !readOnly && (
        <div className="flex gap-3 mt-1 text-[11px] text-gray-400">
          <button
            type="button"
            onClick={onResolve}
            className="hover:text-emerald-600"
          >
            {comment.resolved ? "Reopen" : "Resolve"}
          </button>
          {isAuthor && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="hover:text-gray-700"
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="hover:text-rose-600"
              title={
                isAuthor
                  ? "Delete this comment"
                  : "Delete (doc owner moderation)"
              }
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline reply textarea, expanded on focus. Keeps the panel compact when
 *  there are many threads. */
function ReplyForm({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-[11px] text-gray-400 hover:text-gray-700"
      >
        + Reply
      </button>
    );
  }
  return (
    <div className="mt-2">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            onSubmit(draft);
            setDraft("");
            setOpen(false);
          }
        }}
        placeholder="Reply…"
        rows={2}
        className="w-full text-[13px] border border-gray-300 rounded p-1.5 outline-none focus:border-blue-500"
      />
      <div className="flex gap-2 mt-1">
        <button
          type="button"
          onClick={() => {
            if (draft.trim()) {
              onSubmit(draft);
              setDraft("");
              setOpen(false);
            }
          }}
          disabled={!draft.trim()}
          className="text-[11px] text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft("");
            setOpen(false);
          }}
          className="text-[11px] text-gray-400 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * 24 * 60 * 60_000)
    return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString();
}
