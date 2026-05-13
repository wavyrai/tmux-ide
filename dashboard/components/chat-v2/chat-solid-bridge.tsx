"use client";

/**
 * React → Solid bridge that mounts the canonical chat-solid surface
 * (transcript + composer + header + banners) inside the v2 chat shell.
 *
 * Architectural intent (per the framework-silo memory): React Server
 * Components are the outer orchestrator; framework-specific feature
 * blocks are siloed. chat-solid IS the chat silo. The dashboard's
 * job here is to wire its host context (project name, mention
 * candidates, file-open callback) into chat-solid's mount and
 * otherwise stay out of the chat surface's way.
 *
 * Lifecycle:
 *   - Mount once on `useEffect([])`. Subsequent prop updates flow
 *     through `handle.setOptions({...})` and `handle.setThreadId(id)`
 *     without remounting the Solid runtime (preserves WS connections,
 *     composer drafts, scroll position).
 *   - lib/api.ts touches `window.location` at module load, so we
 *     resolve apiBaseUrl + wsUrl via dynamic import at mount-time
 *     rather than at module eval. Same SSR-dodge pattern the other
 *     bridges in this repo use (kanban-board-bridge, etc.).
 */

import { useEffect, useMemo, useRef } from "react";
import type {
  ChatHandle,
  ChatMountOptions,
  MarkdownFileLinkMeta,
  MentionCandidate,
} from "@tmux-ide/chat-solid";

interface ChatSolidBridgeProps {
  /** Active thread id. Null when no thread is selected. */
  threadId: string | null;
  /** tmux-ide session / project name. Threaded into chat-solid for
   *  any session-scoped daemon endpoints it consumes. */
  sessionName: string | null;
  /** Composer @-mention candidates. Optional. */
  mentionCandidates?: ReadonlyArray<MentionCandidate>;
  /** File-link click handler. Routes to the host preview view. */
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
}

export function ChatSolidBridge({
  threadId,
  sessionName,
  mentionCandidates,
  onOpenFile,
}: ChatSolidBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ChatHandle | null>(null);

  // Refs over the callable / value props so the mount-once effect can
  // always reach the freshest value without remounting. Avoids the
  // closure-trapped-stale problem.
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const mentionCandidatesMemo = useMemo<ReadonlyArray<MentionCandidate>>(
    () => mentionCandidates ?? [],
    [mentionCandidates],
  );

  // Mount once. lib/api.ts evaluates window.location at module load,
  // so it stays behind a dynamic import here (the host renders this
  // bridge as a "use client" leaf — module init lands during the
  // server render otherwise).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!threadId) return;
    let cancelled = false;

    void (async () => {
      const [api, chatSolid] = await Promise.all([
        import("@/lib/api"),
        import("@tmux-ide/chat-solid"),
      ]);
      if (cancelled) return;
      const apiBaseUrl = api.API_BASE;
      // chat-solid expects a fully-qualified ws:// URL it can hand
      // directly to `new WebSocket(...)`. Mirror api.ts' host resolver.
      const wsUrl = apiBaseUrl.replace(/^http/, "ws") + "/ws/chat";

      const opts: ChatMountOptions = {
        threadId,
        sessionName,
        apiBaseUrl,
        wsUrl,
        bearerToken: null,
        mentionCandidates: mentionCandidatesMemo,
        onOpenFile: (meta) => onOpenFileRef.current?.(meta),
      };
      handleRef.current = chatSolid.mount(el, opts);
    })();

    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // Mount-once: subsequent prop updates flow through setOptions /
    // setThreadId below. The initial mount needs `threadId` to be set
    // — the `if (!threadId)` guard above means the bridge waits to
    // mount until the host picks a thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(threadId)]);

  // Forward thread switches without remounting.
  useEffect(() => {
    if (!threadId) return;
    handleRef.current?.setThreadId(threadId);
  }, [threadId]);

  // Push fresh mention candidates as the host's @-source updates.
  useEffect(() => {
    handleRef.current?.setOptions({ mentionCandidates: mentionCandidatesMemo });
  }, [mentionCandidatesMemo]);

  // Empty-state when no thread is selected — chat-solid expects a
  // threadId so we don't mount until the host picks one. Render a
  // matching placeholder so the right pane isn't blank.
  if (!threadId) {
    return (
      <div
        data-testid="chat-solid-empty"
        className="flex h-full min-h-0 flex-1 items-center justify-center text-[12px] text-[var(--fg-muted,var(--dim))]"
      >
        Select a thread to start chatting.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="chat-solid-bridge"
      data-thread-id={threadId}
      data-session-name={sessionName ?? ""}
      className="flex h-full min-h-0 flex-1 flex-col"
    />
  );
}
