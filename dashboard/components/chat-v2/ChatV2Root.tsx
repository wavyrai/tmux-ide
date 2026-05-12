/**
 * T077 — Chat v2 surface. Vertical split: ThreadListRail (left, ~240px)
 * + ThreadView (right, flex). State lives in the chat-v2 zustand store;
 * WS frames flow in through `useChatV2WsBridge`.
 *
 * Inputs come from V2ChatView (the legacy chat surface that owns thread
 * CRUD via @/lib/api). Send / revert callbacks are passed through so
 * this file stays free of network code — easier to unit-test, easier to
 * port to other transports.
 */

"use client";

import { useEffect, useState } from "react";
import type { ThreadIndexEntry } from "../chat/types";
import { fetchThreadTurnDiffs, type TurnDiffEntry } from "@/lib/api";
import { ThreadListRail } from "./ThreadListRail";
import { ThreadView } from "./ThreadView";
import { useChatStore } from "./useChatStore";
import { useChatV2WsBridge } from "./useWsBridge";

export interface ChatV2RootProps {
  projectName: string;
  threads: ThreadIndexEntry[];
  activeThreadId: string | null;
  onPickThread(id: string): void;
  onNewThread(): void;
  onDeleteThread?(id: string): void;
  /** Submit a user message in the active thread. Wired in V2ChatView. */
  onSend(threadId: string, text: string): void;
  /** Revert the active thread to a checkpoint. Wired by T076/T075. */
  onRevert?(threadId: string, checkpointRef: string): void;
}

// Stable empty references so selectors don't return new literals each render —
// zustand v5's getSnapshot check throws "infinite loop" otherwise.
const EMPTY_ACTIVITIES: ReadonlyArray<unknown> = [];
const EMPTY_MAP: Readonly<Record<string, unknown>> = {};

export function ChatV2Root(props: ChatV2RootProps) {
  useChatV2WsBridge(props.projectName);

  const setThreads = useChatStore((s) => s.setThreads);
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const activities = useChatStore((s) =>
    props.activeThreadId
      ? (s.activitiesByThread[props.activeThreadId] ?? (EMPTY_ACTIVITIES as never))
      : (EMPTY_ACTIVITIES as never),
  );
  const turns = useChatStore((s) =>
    props.activeThreadId
      ? (s.turnsByThread[props.activeThreadId] ?? (EMPTY_MAP as never))
      : (EMPTY_MAP as never),
  );
  const checkpoints = useChatStore((s) =>
    props.activeThreadId
      ? (s.checkpointsByThread[props.activeThreadId] ?? (EMPTY_MAP as never))
      : (EMPTY_MAP as never),
  );
  const plans = useChatStore((s) =>
    props.activeThreadId
      ? (s.plansByThread[props.activeThreadId] ?? (EMPTY_MAP as never))
      : (EMPTY_MAP as never),
  );
  const unreadByThread = useChatStore((s) => s.unreadByThread);

  // Sync the parent-managed thread list + active thread into the store.
  useEffect(() => setThreads(props.threads), [props.threads, setThreads]);
  useEffect(() => setActiveThread(props.activeThreadId), [props.activeThreadId, setActiveThread]);

  // T101a — per-turn file diffs for the active thread. Reactor-driven
  // updates would normally flow through WS, but the projection is
  // checkpoint-event-shaped (only updates when a turn completes with a
  // checkpoint) so a pull-on-thread-change is plenty for now. The
  // `checkpoints` count changing is the canonical trigger to refresh.
  const [diffsByTurn, setDiffsByTurn] = useState<Record<string, ReadonlyArray<TurnDiffEntry>>>({});
  const checkpointCount = Object.keys(checkpoints as Record<string, unknown>).length;
  useEffect(() => {
    if (!props.activeThreadId) {
      setDiffsByTurn({});
      return;
    }
    const threadId = props.activeThreadId;
    let cancelled = false;
    void fetchThreadTurnDiffs(props.projectName, threadId).then((next) => {
      if (!cancelled) setDiffsByTurn(next);
    });
    return () => {
      cancelled = true;
    };
  }, [props.projectName, props.activeThreadId, checkpointCount]);

  const activeThread =
    props.activeThreadId !== null
      ? (props.threads.find((t) => t.id === props.activeThreadId) ?? null)
      : null;

  return (
    <div
      data-testid="chat-v2-root"
      data-project={props.projectName}
      className="flex h-full min-h-0 flex-row text-[12px]"
    >
      <ThreadListRail
        threads={props.threads}
        activeId={props.activeThreadId}
        unreadByThread={unreadByThread}
        onPick={props.onPickThread}
        onNew={props.onNewThread}
        onDelete={props.onDeleteThread}
      />
      <ThreadView
        thread={activeThread}
        activities={activities}
        turns={turns}
        checkpointsByTurn={checkpoints}
        plansById={plans}
        diffsByTurn={diffsByTurn}
        onSubmit={(text) => {
          if (props.activeThreadId) props.onSend(props.activeThreadId, text);
        }}
        onRevert={(ref) => {
          if (props.activeThreadId) props.onRevert?.(props.activeThreadId, ref);
        }}
      />
    </div>
  );
}
