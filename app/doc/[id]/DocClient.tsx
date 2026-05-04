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

  // ── Resolve initial active page from URL hash ──────────────────────
  useEffect(() => {
    if (!synced || pages.length === 0) return;
    const hash = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    const requested = hash || FIRST_PAGE_ID;
    const exists = pages.some((p) => p.id === requested);
    const target = exists ? requested : pages[0]?.id || FIRST_PAGE_ID;
    if (target !== activePageId) {
      setActivePageIdState(target);
    }
    // Intentionally depends only on synced + pages count, not activePageId —
    // this effect is a one-shot resolver. Subsequent tab switches go through
    // setActivePageId().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, pages.length]);

  // ── React to browser back/forward changing the hash ────────────────
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      const next = hash || FIRST_PAGE_ID;
      if (pages.some((p) => p.id === next) && next !== activePageId) {
        setActivePageIdState(next);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [pages, activePageId]);

  // True once we have everything needed to mount the editor: user is set,
  // provider is open, we're synced, and we've resolved at least one page.
  const editorReady = useMemo(
    () => Boolean(user && provider && synced && pages.length > 0),
    [user, provider, synced, pages.length]
  );

  if (!checked) return null;

  if (!user) {
    return <NamePrompt onSubmit={(name, color) => setUser({ name, color })} />;
  }

  return (
    <div className="flex flex-col h-screen">
      <Toolbar docId={id} sessionUser={sessionUser} onImportHtml={handleImportHtml} readOnly={readOnly} isOwner={isOwner} wsStatus={wsStatus} />

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
        <div ref={handleScrollRef} className="flex-1 overflow-y-auto">
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
                  registerImportHtml={registerImportHtml}
                  registerEditor={handleRegisterEditor}
                  readOnly={readOnly}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
