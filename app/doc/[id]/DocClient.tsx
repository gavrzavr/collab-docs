"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import NamePrompt from "@/components/NamePrompt";
import Toolbar from "@/components/Toolbar";
import DocPreview from "@/components/DocPreview";
import OutlinePanel from "@/components/OutlinePanel";
import PageTabs, { type PageMeta } from "@/components/PageTabs";
import LinkPicker, { type LinkTarget } from "@/components/LinkPicker";
import CommentsPanel from "@/components/CommentsPanel";
import { extractBlocks } from "@/lib/yjs-blocks";
import { listComments, observeComments } from "@/lib/comments";

const Editor = dynamic(() => import("@/components/Editor"), { ssr: false });

const COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#FFA07A",
  "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
];

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  text: string;
}

interface DocClientProps {
  id: string;
  initialBlocks: Block[];
  /** Passed when entering via /v/:token — enables viewer mode. */
  shareToken?: string;
  /** Short-lived HS256 JWT attesting to the signed-in user's access role,
   *  minted by `/doc/[id]/page.tsx`. The WS server verifies it. Not used when
   *  `shareToken` is present — share tokens are a separate auth path that
   *  doesn't require an identity. */
  sessionToken?: string;
  /** Role granted by the share token (if any). Defaults to "editor". */
  role?: "viewer" | "commenter" | "editor";
  /** True when the signed-in user owns this document. Enables owner-only
   *  UI (minting editor invite links, managing collaborators). */
  isOwner?: boolean;
}

/**
 * The first page of every document uses the fragment name "blocknote".
 * This preserves backward compat with single-page docs created before
 * multi-page landed (their existing content lives in that fragment) and
 * keeps the server-side SSR preview path (which reads "blocknote") working
 * unchanged for freshly-created docs.
 */
const FIRST_PAGE_ID = "blocknote";
const DEFAULT_FIRST_PAGE_TITLE = "Page 1";

/**
 * Parse a URL hash into the optional page + block we should jump to.
 *
 * Hash grammar:
 *   #pageId            → switch to that tab (existing behavior)
 *   #pageId.blockId    → switch to that tab AND scroll/highlight blockId
 *   #blockId           → scroll/highlight blockId (page resolved by lookup)
 *
 * Nanoids never contain dots, so the dot is an unambiguous separator.
 * Returning null fields means "no constraint at this level."
 */
function parseHash(rawHash: string): { pageId: string | null; blockId: string | null } {
  const cleaned = rawHash.replace(/^#/, "");
  if (!cleaned) return { pageId: null, blockId: null };
  const dotIdx = cleaned.indexOf(".");
  if (dotIdx >= 0) {
    return {
      pageId: cleaned.slice(0, dotIdx) || null,
      blockId: cleaned.slice(dotIdx + 1) || null,
    };
  }
  return { pageId: cleaned, blockId: null };
}

export default function DocClient({ id, initialBlocks, shareToken, sessionToken, role, isOwner }: DocClientProps) {
  const readOnly = role === "viewer";
  const [user, setUser] = useState<{ name: string; color: string; image?: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [sessionUser, setSessionUser] = useState<{ name: string; email: string; image?: string } | null>(null);

  // ── Yjs: single ydoc + provider per document open ───────────────────
  //
  // Owning these here (rather than inside <Editor>) means tab switches
  // remount BlockNote without re-opening the WebSocket. That's the whole
  // point of multi-page: cheap tab switching, one sync session.
  const [ydoc] = useState<Y.Doc>(() => new Y.Doc());
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [synced, setSynced] = useState(false);
  /**
   * WebSocket connection status, surfaced as a small dot in the toolbar so
   * users can SEE when sync is broken. Default "connecting" — flips to
   * "connected" on the provider's "status" event, "offline" if the
   * connection drops or the browser is offline.
   *
   * Why this exists: Daria reported losing ~2h of work after a deploy.
   * Root-cause analysis pointed at a silent WebSocket disconnect — y-websocket
   * keeps reconnecting in the background, but without IDB persistence, edits
   * made while disconnected lived only in browser memory and vanished on
   * reload. The new IDB pipeline below fixes the data-loss; this indicator
   * gives the user advance warning that we're in offline mode.
   */
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "offline">("connecting");

  // ── Pages ──────────────────────────────────────────────────────────
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [activePageId, setActivePageIdState] = useState<string>(FIRST_PAGE_ID);
  /** Link picker (slash command "Link to block") state. */
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  /** Comments composer target — set when the user clicks the per-block
   *  hover icon (or drag-handle → Comment) so the panel's input pre-fills
   *  the right block. The panel itself is always visible; this is just
   *  the "compose mode" indicator. */
  const [composeTargetBlockId, setComposeTargetBlockId] = useState<string | null>(
    null
  );
  /** Bumped on every Yjs comments-map change so `commentBlockIds` re-derives. */
  const [commentsTick, setCommentsTick] = useState(0);
  /** Imperative scroll-to-block. Stable across renders via useRef holding
   *  the latest scrollEl. We avoid React state for the pending block id
   *  because the state→effect cycle introduced a self-cancellation race
   *  in DevTools (RAF saw cancelled=true from the cleanup that fired
   *  when the effect set the state to null). Direct DOM manipulation is
   *  simpler and doesn't depend on React commit timing. */
  const scrollElRef = useRef<HTMLElement | null>(null);
  const scrollToBlock = useCallback((blockId: string) => {
    let attempt = 0;
    const HEADROOM_PX = 24;
    const MAX_ATTEMPTS = 30;

    // BlockNote re-renders aggressively on click (PM transactions, link
    // toolbar mount, selection sync). The DOM node we found in `tick()`
    // can be DETACHED by the time the deferred RAF/setTimeout fires —
    // a detached node's getBoundingClientRect returns 0,0, which made
    // our scrollTop calculation negative (clamped to 0 → no scroll).
    // Diagnosed via console.log in prod: calc=-117.5 = (0 - 94 [container
    // rect top] - 24 [headroom]) instead of the expected ~938. Fix: ALWAYS
    // re-query the live DOM by id inside doScroll, never trust a captured
    // reference across an async boundary.
    const doScroll = () => {
      const live = document.querySelector(
        `[data-id="${CSS.escape(blockId)}"].bn-block-outer`
      ) as HTMLElement | null;
      const container = scrollElRef.current;
      if (!live || !container) return;
      const elRect = live.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const top = container.scrollTop + (elRect.top - containerRect.top) - HEADROOM_PX;
      container.scrollTop = Math.max(0, top);
    };

    const highlight = () => {
      const live = document.querySelector(
        `[data-id="${CSS.escape(blockId)}"].bn-block-outer`
      ) as HTMLElement | null;
      if (!live) return;
      live.classList.add("bn-highlight-target");
      // Match the 4s `bn-highlight-fade` keyframe — keep the class on the
      // node until the animation has fully faded, then remove so future
      // jumps can re-trigger the same animation cleanly.
      setTimeout(() => {
        // Re-query because the element may have been re-mounted in the
        // meantime; remove the class from whichever node currently holds
        // the id. Running on the original `live` would silently no-op
        // if it's been replaced.
        const cur = document.querySelector(
          `[data-id="${CSS.escape(blockId)}"].bn-block-outer`
        ) as HTMLElement | null;
        if (cur) cur.classList.remove("bn-highlight-target");
        else live.classList.remove("bn-highlight-target");
      }, 4000);
    };

    const tick = () => {
      const el = document.querySelector(
        `[data-id="${CSS.escape(blockId)}"].bn-block-outer`
      ) as HTMLElement | null;
      const container = scrollElRef.current;
      if (el && container) {
        // Trigger three scroll passes — each re-queries the DOM, so any
        // re-mount between passes is harmless. Three passes catch:
        //   raf — beats PM's mid-click scroll-to-cursor
        //   t250 — fires after BlockNote's "selection settled" re-render
        //   t500 — corrects for layout drift as filler blocks above
        //          finish committing height changes
        requestAnimationFrame(doScroll);
        setTimeout(doScroll, 250);
        setTimeout(doScroll, 500);
        highlight();
        return;
      }
      if (attempt++ < MAX_ATTEMPTS) setTimeout(tick, 100);
    };
    tick();
  }, []);

  // Push active page id to the URL hash so deep-links survive reloads and
  // can be shared internally (e.g. "open the API specs tab directly").
  const setActivePageId = useCallback((next: string) => {
    setActivePageIdState(next);
    if (typeof window !== "undefined") {
      const newHash = next === FIRST_PAGE_ID ? "" : next;
      // Avoid pushing duplicate history entries if nothing changed.
      if (window.location.hash.replace(/^#/, "") !== newHash) {
        if (newHash) window.history.replaceState(null, "", `#${newHash}`);
        else window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
  }, []);

  const [editor, setEditor] = useState<unknown>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const importHtmlRef = useRef<((html: string) => void) | null>(null);

  const handleImportHtml = useCallback((html: string) => {
    importHtmlRef.current?.(html);
  }, []);

  const handleRegisterEditor = useCallback((e: unknown) => {
    setEditor(e);
  }, []);

  const handleScrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollEl(node);
    scrollElRef.current = node;
  }, []);

  const registerImportHtml = useCallback((fn: (html: string) => void) => {
    importHtmlRef.current = fn;
  }, []);

  // ── Session / name bootstrap ───────────────────────────────────────
  //
  // Three paths into here:
  //   1. /doc/:id — user is always signed in (auth gate in page.tsx),
  //      so we'll always read their Google name.
  //   2. /v/:token (viewer mode) — anonymous read-only. We DO NOT prompt
  //      for a display name: viewers can't write, and the marketing
  //      landing pages we share to prospects shouldn't gate first
  //      impression behind a name input. We generate a throwaway
  //      "Viewer" identity for the awareness layer (no one sees it
  //      anyway since viewer awareness updates are dropped server-side).
  //   3. Edge case: signed-out user somehow on /doc/:id (shouldn't
  //      happen post-auth-gate, but the legacy NamePrompt path stays
  //      as a fallback for that and for any future anon-edit flow).
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data?.user?.name) {
          const color = localStorage.getItem("collab-docs-color") || randomColor();
          localStorage.setItem("collab-docs-color", color);
          setSessionUser(data.user);
          setUser({ name: data.user.name, color, image: data.user.image });
          setChecked(true);
          return;
        }
        if (shareToken) {
          // Viewer-only path — no prompt, no friction.
          const color = localStorage.getItem("collab-docs-color") || randomColor();
          setUser({ name: "Viewer", color });
          setChecked(true);
          return;
        }
        const name = localStorage.getItem("collab-docs-name");
        const color = localStorage.getItem("collab-docs-color");
        if (name && color) {
          setUser({ name, color });
        }
        setChecked(true);
      })
      .catch(() => {
        if (shareToken) {
          const color = localStorage.getItem("collab-docs-color") || randomColor();
          setUser({ name: "Viewer", color });
          setChecked(true);
          return;
        }
        const name = localStorage.getItem("collab-docs-name");
        const color = localStorage.getItem("collab-docs-color");
        if (name && color) {
          setUser({ name, color });
        }
        setChecked(true);
      });
  }, [shareToken]);

  // ── Local IndexedDB persistence ────────────────────────────────────
  //
  // y-indexeddb mirrors the Y.Doc to the browser's IndexedDB. Data path:
  //
  //   user types → BlockNote → Y.Doc → [IDB write] + [WS send to ws-server]
  //   reload    → Y.Doc loads from IDB instantly → WS catches up server-side
  //
  // The Yjs CRDT merges IDB-restored state with whatever the server sends,
  // so there's no "which one wins" decision to make — just a free-form
  // catch-up. Edits made while the WebSocket is down stay in IDB and get
  // delivered on reconnect; the user can keep editing through a deploy /
  // network blip without losing anything to a refresh.
  //
  // Privacy carve-out: anonymous viewers on /v/:token may be on a shared
  // computer. We DO NOT cache their doc in IDB — once they close the tab
  // there should be no trace. Editors signed in with their Google account
  // get IDB caching. The 'allow-IDB' check is `!shareToken`.
  //
  // Storage scope: IDB databases are origin-scoped, so no cross-doc leakage.
  // Each doc gets its own database name (`collab-doc-${id}`), keyed off the
  // route param, which is also the canonical doc id.
  useEffect(() => {
    if (!ydoc || shareToken) return; // skip for anon viewers — see comment above
    const idb = new IndexeddbPersistence(`collab-doc-${id}`, ydoc);
    return () => {
      // destroy() flushes any pending writes before tearing down. Don't
      // use clearData() — that would wipe the cache, defeating the point.
      idb.destroy();
    };
  }, [id, ydoc, shareToken]);

  // ── Open WebSocket connection once user is resolved ────────────────
  useEffect(() => {
    if (!user) return;
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `ws://${window.location.hostname}:1234`;
    // Auth path priority: share-token (anon viewer) > session-JWT (signed-in
    // member). If neither is present the WS server will reject the connection;
    // that shouldn't happen because /doc/:id SSR mints a JWT and /v/:token
    // supplies a share-token — but we don't invent a fallback here.
    const params: Record<string, string> | undefined = shareToken
      ? { token: shareToken }
      : sessionToken
      ? { session: sessionToken }
      : undefined;
    const p = new WebsocketProvider(
      wsUrl,
      id,
      ydoc,
      params ? { params } : undefined
    );
    p.awareness.setLocalStateField("user", { name: user.name, color: user.color });

    if (p.synced) {
      setSynced(true);
    } else {
      p.once("sync", () => setSynced(true));
    }

    // Surface WebSocket status as a UI signal. y-websocket emits 'status'
    // with { status: "connecting" | "connected" | "disconnected" }.
    //
    // Hysteresis: connect/disconnect blips of <2s shouldn't flash a scary
    // "Offline" badge. Reconnect cycles (mobile sleep/wake, deploy, transient
    // network) routinely generate sub-second flickers that don't represent
    // real data risk — IDB has the local copy regardless. We delay the
    // offline state by 2.5s; if the connection comes back within that
    // window, the user sees no flicker at all.
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelOfflineTimer = () => {
      if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    };
    const onStatus = ({ status }: { status: "connecting" | "connected" | "disconnected" }) => {
      if (status === "connected") {
        cancelOfflineTimer();
        setWsStatus("connected");
      } else if (status === "connecting") {
        // Don't overwrite "connected" with "connecting" instantly — only
        // flip if we were already in a non-connected state, OR after the
        // offline timer would have fired anyway. This avoids a sync→connecting
        // flash on every awareness renewal cycle.
        cancelOfflineTimer();
        offlineTimer = setTimeout(() => {
          setWsStatus("offline");
          offlineTimer = null;
        }, 2500);
      } else {
        cancelOfflineTimer();
        offlineTimer = setTimeout(() => {
          setWsStatus("offline");
          offlineTimer = null;
        }, 2500);
      }
    };
    p.on("status", onStatus);
    if (p.wsconnected) setWsStatus("connected");

    setProvider(p);
    return () => {
      cancelOfflineTimer();
      p.off("status", onStatus);
      p.destroy();
      setProvider(null);
      setSynced(false);
    };
  }, [id, ydoc, shareToken, sessionToken, user]);

  // ── Subscribe to the pages list in Yjs ─────────────────────────────
  //
  // On first sync, if the doc has no pages array yet (legacy doc or brand
  // new one), seed it with a single "Page 1" entry pointing at the
  // "blocknote" fragment. This is the only migration needed — existing
  // content lives in that fragment already, so no data copy.
  useEffect(() => {
    if (!synced) return;
    const order = ydoc.getArray<string>("pageOrder");
    const titles = ydoc.getMap<string>("pageTitles");

    // Viewer-mode coerces read-only even at CRDT level (ws-server drops
    // their updates), so we avoid seeding from a viewer session. Editors
    // opening a fresh doc handle the seeding.
    if (order.length === 0 && !readOnly) {
      ydoc.transact(() => {
        order.push([FIRST_PAGE_ID]);
        titles.set(FIRST_PAGE_ID, DEFAULT_FIRST_PAGE_TITLE);
      });
    }

    const update = () => {
      // Defensive dedupe: two clients opening a brand-new doc simultaneously
      // can both seed, resulting in duplicate ids in pageOrder. Rendering
      // with duplicate React keys breaks, so we collapse them here. The
      // underlying Yjs state stays slightly dirty — acceptable, as the
      // race window is microsecond-wide and users don't see duplicates.
      const ids = order.toArray();
      const seen = new Set<string>();
      const list: PageMeta[] = [];
      for (const pid of ids) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        list.push({ id: pid, title: titles.get(pid) || "Untitled" });
      }
      setPages(list);
    };

    update();
    order.observe(update);
    titles.observe(update);
    return () => {
      order.unobserve(update);
      titles.unobserve(update);
    };
  }, [synced, ydoc, readOnly]);

  // ── Resolve initial active page (and pending block scroll) from hash ─
  //
  // Hash forms (see parseHash):
  //   #pageId           → switch tab
  //   #pageId.blockId   → switch tab + scroll to block
  //   #blockId          → scroll to block on whichever page contains it
  //                       (the lookup pass runs after pages are loaded)
  useEffect(() => {
    if (!synced || pages.length === 0) return;
    const raw = typeof window !== "undefined" ? window.location.hash : "";
    const { pageId, blockId } = parseHash(raw);

    let targetPageId = pages[0]?.id || FIRST_PAGE_ID;
    let scrollTarget: string | null = null;
    if (pageId && pages.some((p) => p.id === pageId)) {
      targetPageId = pageId;
    } else if (pageId && !blockId) {
      // pageId is in fact a block id (no dot in hash, hash is unknown
      // page). Search all fragments for that block and route to its page.
      for (const p of pages) {
        const found = extractBlocks(ydoc, p.id).some((b) => b.id === pageId);
        if (found) {
          targetPageId = p.id;
          scrollTarget = pageId;
          break;
        }
      }
    }
    if (blockId) scrollTarget = blockId;
    if (targetPageId !== activePageId) {
      setActivePageIdState(targetPageId);
    }
    // Defer the scroll one tick — the editor may need to remount with a new
    // fragment if we just switched tabs. scrollToBlock polls for the block
    // element so it'll wait for the new render anyway, but giving it a head
    // start avoids a couple of failed attempts.
    if (scrollTarget) setTimeout(() => scrollToBlock(scrollTarget), 0);
    // One-shot resolver — subsequent navigation flows through setActivePageId
    // and the hashchange listener below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, pages.length]);

  // ── React to hash changes (back/forward, intra-doc link clicks) ────
  useEffect(() => {
    const onHash = () => {
      const { pageId, blockId } = parseHash(window.location.hash);
      let targetPageId: string | null = null;
      let scrollTarget: string | null = null;
      if (pageId && pages.some((p) => p.id === pageId)) {
        targetPageId = pageId;
      } else if (pageId && !blockId) {
        for (const p of pages) {
          if (extractBlocks(ydoc, p.id).some((b) => b.id === pageId)) {
            targetPageId = p.id;
            scrollTarget = pageId;
            break;
          }
        }
      } else if (!pageId) {
        targetPageId = FIRST_PAGE_ID;
      }
      if (blockId) scrollTarget = blockId;
      if (targetPageId && targetPageId !== activePageId) {
        setActivePageIdState(targetPageId);
      }
      // Imperative scroll. scrollToBlock is stable and polls for the
      // element, so it works whether the page is already mounted or
      // about to remount due to the setActivePageIdState above.
      if (scrollTarget) setTimeout(() => scrollToBlock(scrollTarget), 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [pages, activePageId, ydoc, scrollToBlock]);

  // (The old useState+useEffect scroll mechanism was removed in favour of
  //  the imperative `scrollToBlock` defined above. Cycle was: hashchange →
  //  setPendingScrollBlockId(blockId) → effect runs → effect schedules
  //  scroll AND sets state to null → re-render → cleanup runs cancelled=true
  //  BEFORE the RAF fires → no scroll. Direct DOM manipulation has no such
  //  ordering hazard.)

  // ── Intercept clicks on intra-doc anchor links ─────────────────────
  //
  // BlockNote stores absolute URLs (`https://postpaper.co/doc/<id>#anchor`),
  // so a vanilla click would do a full page reload. We intercept clicks on
  // links that point to THIS doc's URL with a hash and route them through
  // hash navigation instead — instant, no reload, IDB cache stays warm.
  //
  // Why we ALSO intercept mousedown: ProseMirror does not look at click
  // events to detect "single click on link." It listens to `mousedown`,
  // creates an internal MouseDown helper, then watches for the matching
  // mouseup on `view.root` (bubble phase). When that mouseup fires, PM
  // iterates plugins' `handleClick` props — and Tiptap's link extension
  // (which BlockNote enables with `openOnClick: true`) calls
  // `window.open(href, "_blank")`. Spurious new browser tab.
  //
  // Result: capture-phase `click` interception alone is too late — the
  // new tab is already opening. We have to kill the event chain at
  // mousedown so PM never starts the MouseDown lifecycle for our link.
  // Stack trace observed in DevTools (PM 1.40):
  //   window.open ← Tiptap.handleClick ← runHandlerOnContext
  //   ← view.someProp("handleClick") ← MouseDown.up ← mouseup
  //
  // Back-button restoration: before pushing the new entry, we replaceState
  // on the CURRENT entry with the active page id and current scroll position.
  // When the user presses back, popstate fires with that saved state, and the
  // popstate effect below restores tab + scroll. Without this the user lands
  // at the top of the previous tab — frustrating when they were halfway down
  // a long doc and just wanted to "peek" at a referenced block.
  useEffect(() => {
    const isIntraDocLink = (e: MouseEvent): URL | null => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
      const link = (e.target as HTMLElement | null)?.closest?.("a");
      if (!link) return null;
      const href = link.getAttribute("href");
      if (!href) return null;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return null;
      }
      // Host comparison treats apex and www. as the same logical origin.
      // Daria 06.05.2026: she had a link in the form `https://postpaper.co/...`
      // (no www) while viewing the doc on `https://www.postpaper.co/...`. The
      // strict `url.origin !== window.location.origin` check failed, so we
      // didn't intercept; Tiptap opened a new tab via window.open; the apex
      // host hit Vercel's www redirect; HTTP redirects DROP the URL fragment;
      // new tab loaded with no hash → no scroll. Visible symptom: "открывает
      // новую страницу, не открывает нужный раздел". Normalising the host
      // strips this mismatch so we always intra-tab nav regardless of which
      // form was pasted.
      const sameHost =
        url.protocol === window.location.protocol &&
        url.host.replace(/^www\./, "") ===
          window.location.host.replace(/^www\./, "");
      if (
        !sameHost ||
        url.pathname !== `/doc/${id}` ||
        !url.hash
      )
        return null;
      return url;
    };

    // mousedown: shut PM out before it sets up its MouseDown lifecycle.
    // Without this, PM hears mouseup → fires Tiptap's handleClick →
    // window.open spawns a new browser tab. preventDefault stops focus
    // / native drag init for the link, both of which we don't want for
    // an intra-doc nav anyway.
    const downHandler = (e: MouseEvent) => {
      if (!isIntraDocLink(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // mouseup: defense in depth — if PM somehow still got the mousedown
    // (shadow DOM, future PM rewrite), the mouseup capture stop kills
    // the handleClick dispatch.
    const upHandler = (e: MouseEvent) => {
      if (!isIntraDocLink(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const handler = (e: MouseEvent) => {
      // Only plain left-click — let modifier-clicks open in new tab.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as HTMLElement | null)?.closest?.("a");
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      // Same origin, same /doc/:id path, with a hash → intra-doc link.
      if (
        url.origin === window.location.origin &&
        url.pathname === `/doc/${id}` &&
        url.hash
      ) {
        e.preventDefault();
        // Kill Tiptap's link plugin too — its click handler defaults to
        // `openOnClick: true` and would *also* call window.open(href,
        // "_blank") in addition to our hash-nav. That second tab loading
        // up was Daria's "после клика открывается первый таб" report —
        // a fresh load before pages were populated, briefly visible.
        // stopImmediatePropagation prevents the bubble from reaching
        // ProseMirror's view.dom click listener.
        e.stopImmediatePropagation();
        if (window.location.hash !== url.hash) {
          // Stamp the source position onto the current entry so back returns
          // here with full fidelity. JSON.stringify-safe payload.
          try {
            window.history.replaceState(
              {
                __pp: true,
                pageId: activePageId,
                scrollY: scrollEl?.scrollTop ?? 0,
              },
              "",
              window.location.href
            );
          } catch {
            /* some browsers reject huge state objects — ours is tiny, ignore */
          }
          window.history.pushState({ __pp: true, navigated: true }, "", url.hash);
          // Use plain Event — `new HashChangeEvent()` isn't a constructable
          // class in every browser engine (Safari quirks). Our listener
          // re-reads window.location.hash anyway, so old/newURL on the
          // event object are unused.
          window.dispatchEvent(new Event("hashchange"));
        } else {
          // Same hash already — re-trigger the scroll/highlight directly.
          const { blockId } = parseHash(url.hash);
          if (blockId) scrollToBlock(blockId);
        }
      }
    };
    // Capture-phase so we run before ProseMirror's bubble-phase listeners.
    // mousedown is the critical one — see the comment block above for why.
    document.addEventListener("mousedown", downHandler, true);
    document.addEventListener("mouseup", upHandler, true);
    document.addEventListener("click", handler, true);
    return () => {
      document.removeEventListener("mousedown", downHandler, true);
      document.removeEventListener("mouseup", upHandler, true);
      document.removeEventListener("click", handler, true);
    };
  }, [id, activePageId, scrollEl]);

  // ── Restore tab + scroll on browser back/forward ──────────────────
  //
  // popstate fires AFTER the URL has been rolled to the previous entry, but
  // BEFORE our hashchange handler runs (both fire on the same browser
  // navigation). We rely on hashchange to switch the tab; we use popstate
  // only to schedule the scroll restoration, then defer it until the new
  // page has had time to render.
  //
  // The 250ms delay is empirical: enough for React + BlockNote to commit
  // the page switch, before BlockNote's own auto-scroll-to-cursor (which
  // tries to keep the editor cursor in view) fights us.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { __pp?: true; scrollY?: number } | null;
      if (state?.__pp && typeof state.scrollY === "number") {
        const savedScrollY = state.scrollY;
        setTimeout(() => {
          if (scrollEl) scrollEl.scrollTop = savedScrollY;
        }, 250);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [scrollEl]);

  // True once we have everything needed to mount the editor: user is set,
  // provider is open, we're synced, and we've resolved at least one page.
  const editorReady = useMemo(
    () => Boolean(user && provider && synced && pages.length > 0),
    [user, provider, synced, pages.length]
  );

  // ── Comments: subscribe + derive UI state ─────────────────────────
  //
  // The Yjs comments map is the single source of truth. We bump
  // `commentsTick` on every change so memos re-derive — same pattern
  // OutlinePanel uses for editor.onChange. From the snapshot we derive
  // (a) `commentBlockIds` — the set of block ids that have at least one
  // unresolved comment, used to paint `.pp-has-comment` on the editor's
  // rendered blocks, and (b) `unresolvedThreadCount` for the toolbar
  // badge.
  useEffect(() => {
    return observeComments(ydoc, () => setCommentsTick((t) => t + 1));
  }, [ydoc]);

  const commentBlockIds = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    for (const c of listComments(ydoc)) {
      if (!c.resolved) set.add(c.blockId);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, commentsTick]);

  // Apply `.pp-has-comment` to the rendered block-outer for each block id
  // in commentBlockIds. Yellow left-border + tint marker.
  //
  // BlockNote/ProseMirror manages the DOM under .bn-container and resets
  // unknown classes/attributes on every view-update transaction. The
  // first implementation just polled `apply()` 30× over 3s — that worked
  // briefly and then PM's next render stripped the class for good. Fix:
  // a MutationObserver on the editor root re-applies the class on EVERY
  // mutation. The work is O(comment-count), trivially cheap. Idempotent
  // because we always wipe + repaint the full set.
  // ── Comment markers as overlay layer ─────────────────────────────
  //
  // Why an overlay and not a class on .bn-block-outer: ProseMirror
  // owns the editor subtree and strips any non-standard class or
  // attribute it didn't put there itself. Verified four times in prod
  // (06.05.2026):
  //   - classList.add('pp-has-comment') → gone within milliseconds
  //   - setAttribute('data-pp-has-comment','1') → gone on next render
  //   - MutationObserver re-paints racing PM's view update — class
  //     lands on a node PM is about to swap out
  //   - Even setInterval polling fights with PM's view loop endlessly
  //
  // Solution: ONE container div appended to document.body, populated
  // with one absolute-positioned marker per commented block. Body is
  // outside PM's reach. We poll ~10×/sec to update positions for
  // scroll/resize/PM block height changes. Cost is bounded by comment
  // count, not block count.
  useEffect(() => {
    if (!editorReady) return;
    const layer = document.createElement("div");
    layer.className = "pp-comment-markers-layer";
    layer.style.position = "fixed";
    layer.style.inset = "0";
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "5"; // above editor content, below floating toolbar
    document.body.appendChild(layer);

    const idToMarker = new Map<string, HTMLElement>();

    const ensureMarker = (id: string): HTMLElement => {
      let m = idToMarker.get(id);
      if (m) return m;
      m = document.createElement("div");
      m.className = "pp-comment-marker";
      m.dataset.commentBlock = id;
      idToMarker.set(id, m);
      layer.appendChild(m);
      return m;
    };

    const place = () => {
      const seen = new Set<string>();
      for (const id of commentBlockIds) {
        const block = document.querySelector(
          `[data-id="${CSS.escape(id)}"].bn-block-outer`
        ) as HTMLElement | null;
        if (!block) continue;
        const rect = block.getBoundingClientRect();
        // Skip placement if the block is completely off-screen — saves
        // CPU on long docs. The marker stays in the layer with
        // display:none and re-appears when the block scrolls back in.
        const m = ensureMarker(id);
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
          m.style.display = "none";
        } else {
          m.style.display = "block";
          // Marker draws to the LEFT of the block as a thin amber bar
          // + faint tint extending into the block's width. Aligns
          // with how Notion / Linear show comment anchors.
          m.style.left = `${Math.round(rect.left - 10)}px`;
          m.style.top = `${Math.round(rect.top + 2)}px`;
          m.style.width = `${Math.round(rect.width + 14)}px`;
          m.style.height = `${Math.round(rect.height - 4)}px`;
        }
        seen.add(id);
      }
      // Garbage-collect markers for blocks that no longer have comments
      // (or whose comment was deleted/resolved).
      for (const [id, el] of idToMarker.entries()) {
        if (!seen.has(id)) {
          el.remove();
          idToMarker.delete(id);
        }
      }
    };

    place();
    const interval = setInterval(place, 100);

    // Reposition on scroll + resize too (the interval covers it but
    // these events make tracking feel instant during a scroll).
    const onScrollOrResize = () => place();
    if (scrollEl) scrollEl.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      clearInterval(interval);
      if (scrollEl) scrollEl.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      try {
        document.body.removeChild(layer);
      } catch {
        /* already gone */
      }
    };
  }, [commentBlockIds, activePageId, editorReady, scrollEl]);

  const handleAddCommentForBlock = useCallback((blockId: string) => {
    setComposeTargetBlockId(blockId);
  }, []);

  // ── Per-block hover trigger (`💬`) ─────────────────────────────────
  //
  // Discoverability: a "Comment" item lives in the drag-handle menu, but
  // users (Mikhail 06.05.2026) don't intuitively click the 6-dot grip when
  // they want to leave a comment — that's the icon for "drag/menu," not
  // for commenting. Add a dedicated trigger that follows the hovered
  // block. One click → the composer in the right panel pre-fills the
  // block id and focuses.
  //
  // Implementation note (06.05.2026): the OBVIOUS approach was to append
  // a button as a child of each `.bn-block-outer`. That FAILED in prod —
  // ProseMirror manages the subtree under .bn-block-outer and silently
  // removes unknown children on its next render pass. Instead we render
  // ONE floating button into document.body and reposition it on
  // mousemove to track whichever block-outer the cursor is currently
  // over. Same approach BlockNote uses for its own +/⋮⋮ side-menu —
  // the menu lives outside the editor DOM and is positioned by JS.
  useEffect(() => {
    if (!editorReady || readOnly || !sessionUser) return;
    const CLS = "pp-comment-trigger";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = CLS;
    btn.title = "Add comment";
    btn.setAttribute("aria-label", "Add comment to this block");
    btn.textContent = "💬";
    btn.style.position = "fixed";
    btn.style.zIndex = "30";
    btn.style.opacity = "0";
    btn.style.pointerEvents = "none";
    document.body.appendChild(btn);

    let currentBlockId: string | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const show = (block: HTMLElement) => {
      const id = block.dataset.id;
      if (!id) return;
      currentBlockId = id;
      const rect = block.getBoundingClientRect();
      // Sit just outside the block on the right; vertically aligned to
      // the block's first text line (BlockNote pads outers with a small
      // top margin, so 4px down looks balanced).
      btn.style.left = `${Math.round(rect.right + 8)}px`;
      btn.style.top = `${Math.round(rect.top - 2)}px`;
      btn.style.opacity = "0.92";
      btn.style.pointerEvents = "auto";
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const scheduleHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        btn.style.opacity = "0";
        btn.style.pointerEvents = "none";
        currentBlockId = null;
        hideTimer = null;
      }, 150);
    };

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Hovering the button itself keeps it visible.
      if (target === btn) {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        return;
      }
      const outer = target.closest?.(
        ".bn-block-outer[data-id]"
      ) as HTMLElement | null;
      if (outer) show(outer);
      else scheduleHide();
    };
    // Use mouseover (bubbles) over the editor area; mouseleave on the
    // editor root hides the button when the cursor goes elsewhere.
    document.addEventListener("mouseover", onMouseOver);

    btn.addEventListener("mouseenter", () => {
      btn.style.opacity = "1";
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.opacity = "0.92";
      scheduleHide();
    });
    btn.addEventListener("mousedown", (e) => {
      // Block PM from interpreting this as a doc click and shifting
      // the cursor (or the link toolbar from popping for a nearby link).
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentBlockId) handleAddCommentForBlock(currentBlockId);
    });

    // When the page scrolls or resizes, the captured rect goes stale.
    // Re-show against the still-tracked block (if any) on the next frame.
    const onLayoutChange = () => {
      if (!currentBlockId) return;
      const live = document.querySelector(
        `.bn-block-outer[data-id="${CSS.escape(currentBlockId)}"]`
      ) as HTMLElement | null;
      if (live) show(live);
    };
    if (scrollEl) scrollEl.addEventListener("scroll", onLayoutChange, { passive: true });
    window.addEventListener("resize", onLayoutChange);

    return () => {
      document.removeEventListener("mouseover", onMouseOver);
      if (scrollEl) scrollEl.removeEventListener("scroll", onLayoutChange);
      window.removeEventListener("resize", onLayoutChange);
      if (hideTimer) clearTimeout(hideTimer);
      try { document.body.removeChild(btn); } catch { /* already gone */ }
    };
  }, [editorReady, readOnly, sessionUser, handleAddCommentForBlock, scrollEl]);

  // Click on a thread in the panel → switch tab if needed, then scroll.
  const handleJumpToCommentBlock = useCallback(
    (pageId: string, blockId: string) => {
      if (pageId !== activePageId) {
        setActivePageIdState(pageId);
      }
      // setTimeout 0 so the tab switch above commits before scrollToBlock
      // queries the DOM. scrollToBlock itself polls so this is just a
      // head-start, not a strict requirement.
      setTimeout(() => scrollToBlock(blockId), 0);
    },
    [activePageId, scrollToBlock]
  );

  // ── Link picker: build target list from all pages of the doc ──────
  //
  // Recompiled on demand (when the picker opens) rather than continuously,
  // because walking every fragment of every page on every keystroke would
  // burn cycles for nothing. Stale-by-up-to-the-time-the-modal-opens is
  // a fine tradeoff for this UX.
  const buildLinkTargets = useCallback((): LinkTarget[] => {
    const targets: LinkTarget[] = [];
    for (const p of pages) {
      targets.push({ kind: "page", pageId: p.id, pageTitle: p.title });
      const blocks = extractBlocks(ydoc, p.id);
      for (const b of blocks) {
        // Skip blocks with empty/whitespace text — they're not useful link
        // targets and would clutter the list. Headings and tables are
        // exceptions: a heading without text is rare but a table without
        // text is normal — keep tables, skip empty headings/paragraphs.
        if (b.type !== "table" && b.type !== "htmlViz" && !b.text.trim()) continue;
        targets.push({
          kind: "block",
          pageId: p.id,
          pageTitle: p.title,
          blockId: b.id,
          blockType: b.type,
          level: b.level,
          text: b.text,
        });
      }
    }
    return targets;
  }, [pages, ydoc]);

  const [linkTargets, setLinkTargets] = useState<LinkTarget[]>([]);

  const handleOpenLinkPicker = useCallback(() => {
    setLinkTargets(buildLinkTargets());
    setLinkPickerOpen(true);
  }, [buildLinkTargets]);

  const handlePickLink = useCallback(
    (target: LinkTarget) => {
      setLinkPickerOpen(false);
      const ed = editor as
        | {
            insertInlineContent: (content: unknown[]) => void;
            focus: () => void;
          }
        | null;
      if (!ed) return;
      const origin =
        typeof window !== "undefined" ? window.location.origin : "https://postpaper.co";
      const anchor =
        target.kind === "page"
          ? target.pageId
          : `${target.pageId}.${target.blockId}`;
      const url = `${origin}/doc/${id}#${anchor}`;
      const label =
        target.kind === "page"
          ? target.pageTitle
          : (target.text.trim() || target.pageTitle);
      // Insert as a styled link at the cursor. BlockNote's link inline
      // content type accepts {type: "link", href, content: [{type:"text"}]}.
      try {
        ed.insertInlineContent([
          { type: "link", href: url, content: [{ type: "text", text: label, styles: {} }] },
          { type: "text", text: " ", styles: {} },
        ]);
        ed.focus();
      } catch (err) {
        console.error("Failed to insert link:", err);
      }
    },
    [editor, id]
  );

  const handleCloseLinkPicker = useCallback(() => setLinkPickerOpen(false), []);

  if (!checked) return null;

  if (!user) {
    return <NamePrompt onSubmit={(name, color) => setUser({ name, color })} />;
  }

  return (
    <div className="flex flex-col h-screen">
      <Toolbar
        docId={id}
        sessionUser={sessionUser}
        onImportHtml={handleImportHtml}
        readOnly={readOnly}
        isOwner={isOwner}
        wsStatus={wsStatus}
      />

      {/* Read-only banner. Without this users land on /v/:token, see a normal-
          looking editor, try to type, see nothing happen, and conclude the
          service is broken. The banner makes the role explicit. Sits between
          Toolbar and tab bar so it's the first thing in the content band. */}
      {readOnly && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm font-medium"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4 flex-shrink-0"
            aria-hidden="true"
          >
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>Read-only access</span>
        </div>
      )}

      {/* Tab bar. Rendered whenever the editor is ready so users can discover
          multi-page via the "+" affordance even on single-page docs. Hidden in
          viewer mode when there's only one page (nothing to switch between). */}
      {editorReady && (pages.length > 1 || !readOnly) && (
        <PageTabs
          ydoc={ydoc}
          pages={pages}
          activeId={activePageId}
          onSwitch={setActivePageId}
          readOnly={readOnly}
        />
      )}

      <div className="flex-1 flex overflow-hidden">
        <OutlinePanel
          editor={(synced ? editor : null) as never}
          scrollContainer={scrollEl}
        />
        <div ref={handleScrollRef} className="flex-1 overflow-y-auto" data-pp-scroll>
          <div className="max-w-[800px] mx-auto py-8">
            {/* Server-rendered preview while Yjs is connecting. Only relevant
                for the main page; once synced, the editor takes over. */}
            {!synced && initialBlocks.length > 0 && (
              <div className="pointer-events-none select-none px-4 md:px-[54px]">
                {initialBlocks.map((block) => {
                  switch (block.type) {
                    case "heading": {
                      const level = (block.props?.level as number) || 1;
                      const sizes: Record<number, string> = {
                        1: "text-3xl font-bold",
                        2: "text-2xl font-bold",
                        3: "text-xl font-bold",
                      };
                      return (
                        <div key={block.id} className={`${sizes[level] || sizes[1]} mb-1 leading-relaxed`}>
                          {block.text}
                        </div>
                      );
                    }
                    case "bulletListItem":
                      return (
                        <div key={block.id} className="flex gap-2 leading-relaxed">
                          <span>•</span><span>{block.text}</span>
                        </div>
                      );
                    case "numberedListItem":
                      return (
                        <div key={block.id} className="flex gap-2 leading-relaxed">
                          <span>1.</span><span>{block.text}</span>
                        </div>
                      );
                    default:
                      return (
                        <p key={block.id} className="leading-relaxed min-h-[1.5em]">
                          {block.text || "\u00A0"}
                        </p>
                      );
                  }
                })}
              </div>
            )}
            {!synced && initialBlocks.length === 0 && (
              <DocPreview docId={id} visible={true} />
            )}

            {/* Editor — keyed by activePageId so tab switches remount BlockNote
                bound to the new fragment, while the Yjs doc + WS provider stay
                alive underneath. */}
            <div style={{ opacity: editorReady ? 1 : 0, position: editorReady ? "static" : "absolute", left: editorReady ? "auto" : "-9999px" }}>
              {editorReady && provider && (
                <Editor
                  key={activePageId}
                  ydoc={ydoc}
                  provider={provider}
                  fragmentName={activePageId}
                  userName={user.name}
                  userColor={user.color}
                  docId={id}
                  activePageId={activePageId}
                  registerImportHtml={registerImportHtml}
                  registerEditor={handleRegisterEditor}
                  onOpenLinkPicker={handleOpenLinkPicker}
                  onAddComment={handleAddCommentForBlock}
                  readOnly={readOnly}
                />
              )}
            </div>
          </div>
        </div>
        {editorReady && (
          <CommentsPanel
            ydoc={ydoc}
            scrollContainer={scrollEl}
            activePageId={activePageId}
            onJumpTo={handleJumpToCommentBlock}
            currentUser={
              sessionUser
                ? {
                    email: sessionUser.email,
                    name: sessionUser.name,
                    image: sessionUser.image,
                  }
                : null
            }
            readOnly={readOnly}
            isDocOwner={!!isOwner}
            composeTargetBlockId={composeTargetBlockId}
            onComposeTargetUsed={() => setComposeTargetBlockId(null)}
          />
        )}
      </div>
      <LinkPicker
        open={linkPickerOpen}
        targets={linkTargets}
        onSelect={handlePickLink}
        onClose={handleCloseLinkPicker}
      />
    </div>
  );
}
