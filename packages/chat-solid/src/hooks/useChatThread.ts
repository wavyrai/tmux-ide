import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  chatContextCaptureTerminal,
  chatPermissionRespond,
  chatPlanApprove,
  chatPlanList,
  chatPlanReject,
  chatSessionCancel,
  chatSessionSend,
  chatThreadGet,
  chatThreadRename,
  chatThreadUsage,
  fetchProjectPanes,
  withAuthQuery,
  type ApiRuntime,
} from "../api";
import { coalesceMessages, deriveRuntimeState } from "../coalesce";
import type {
  AvailableCommand,
  ChatBusEvent,
  ChatThreadUsageSummary,
  ChatMountOptions,
  ComposerAttachment,
  ComposerTerminalPane,
  ContentBlock,
  PermissionRequest,
  ProposedPlanSummary,
  SessionUpdate,
  StopReason,
  ThreadMessage,
  ThreadState,
} from "../types";

function isPlanPending(plan: ProposedPlanSummary): boolean {
  return plan.implementedAt === null && !plan.rejected;
}

function latestPending(plans: ProposedPlanSummary[]): ProposedPlanSummary | null {
  // Stable order from the daemon is by createdAt asc; the *latest*
  // pending plan is what we want to surface (the user has acted on
  // older ones already if they're resolved). Walk the array in
  // reverse so we pick up the freshest pending entry.
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    const plan = plans[i];
    if (plan && isPlanPending(plan)) return plan;
  }
  return null;
}

interface ChatStore {
  messages: ThreadMessage[];
}

export function useChatThread(options: Accessor<ChatMountOptions>) {
  const [thread, setThread] = createSignal<ThreadState | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  const [inflight, setInflight] = createSignal(false);
  const [stopReason, setStopReason] = createSignal<StopReason | null>(null);
  const [completedAt, setCompletedAt] = createSignal<string | null>(null);
  const [availableCommands, setAvailableCommands] = createSignal<AvailableCommand[]>([]);
  const [currentModeId, setCurrentModeId] = createSignal<string | null>(null);
  const [pendingPromptId, setPendingPromptId] = createSignal<string | null>(null);
  const [pendingPermission, setPendingPermission] = createSignal<PermissionRequest | null>(null);
  const [usage, setUsage] = createSignal<ChatThreadUsageSummary | null>(null);
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [terminalPanes, setTerminalPanes] = createSignal<ComposerTerminalPane[]>([]);
  const [prefillPromptText, setPrefillPromptText] = createSignal<string | null>(null);
  const [plans, setPlans] = createSignal<ProposedPlanSummary[]>([]);
  const [planResponding, setPlanResponding] = createSignal(false);
  const [store, setStore] = createStore<ChatStore>({ messages: [] });

  const runtime = createMemo<ApiRuntime>(() => ({
    apiBaseUrl: options().apiBaseUrl,
    bearerToken: options().bearerToken,
  }));

  async function refetch(): Promise<void> {
    const opts = options();
    setLoading(true);
    setError(null);
    try {
      const result = await chatThreadGet(runtime(), opts.threadId);
      const next = result.thread;
      const derived = deriveRuntimeState(next.messages ?? []);
      setThread(next);
      setUsage(next.usage ?? null);
      setStore("messages", [...(next.messages ?? [])]);
      setAvailableCommands(derived.availableCommands);
      setCurrentModeId(derived.currentModeId);
      setStopReason(null);
      setCompletedAt(null);
      setPendingPermission(null);
    } catch (err) {
      setThread(null);
      setUsage(null);
      setStore("messages", []);
      setAvailableCommands([]);
      setCurrentModeId(null);
      setPendingPermission(null);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    setInflight(false);
    setStopReason(null);
    setCompletedAt(null);
    setPendingPromptId(null);
    setPendingPermission(null);
    setUsage(null);
    setPlans([]);
    setPlanResponding(false);
    void refetch();
  });

  createEffect(() => {
    const opts = options();
    let active = true;
    void chatThreadUsage(runtime(), opts.threadId)
      .then((result) => {
        if (active) setUsage(result.usage ?? null);
      })
      .catch(() => {
        if (active) setUsage(null);
      });
    onCleanup(() => {
      active = false;
    });
  });

  // Seed the per-thread plan list so the follow-up banner shows the
  // freshest pending plan immediately after a thread switch. WS frames
  // (chat.plan.upserted) keep the list current after that.
  createEffect(() => {
    const opts = options();
    let active = true;
    void chatPlanList(runtime(), opts.threadId)
      .then(({ plans: list }) => {
        if (active) setPlans(list);
      })
      .catch(() => {
        if (active) setPlans([]);
      });
    onCleanup(() => {
      active = false;
    });
  });

  createEffect(() => {
    const opts = options();
    const sessionName = opts.sessionName;
    if (!sessionName) {
      setTerminalPanes([]);
      return;
    }

    let active = true;
    void fetchProjectPanes(runtime(), sessionName)
      .then((panes) => {
        if (active) setTerminalPanes(panes);
      })
      .catch(() => {
        if (active) setTerminalPanes([]);
      });
    onCleanup(() => {
      active = false;
    });
  });

  createEffect(() => {
    const opts = options();
    const socket = new WebSocket(withAuthQuery(opts.wsUrl, opts.bearerToken));
    socket.addEventListener("message", (event) => {
      let frame: ChatBusEvent | null = null;
      try {
        frame = JSON.parse(String(event.data)) as ChatBusEvent;
      } catch {
        return;
      }
      if (!frame || !frame.type.startsWith("chat.") || frame.threadId !== opts.threadId) return;
      if (frame.type === "chat.thread.usage") {
        setUsage(frame.usage);
        return;
      }
      if (frame.type === "chat.plan.upserted") {
        const incoming = frame.plan;
        setPlans((current) => {
          const next = current.filter((plan) => plan.id !== incoming.id);
          next.push(incoming);
          next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          return next;
        });
        return;
      }
      if (frame.type === "chat.permission.request") {
        setPendingPermission({
          threadId: frame.threadId,
          requestId: frame.requestId,
          toolCall: frame.toolCall,
          options: [...frame.options],
          receivedAt: Date.now(),
        });
        return;
      }
      if (frame.type === "chat.thread.update") {
        const now = new Date().toISOString();
        if (frame.update.sessionUpdate === "available_commands_update") {
          const update = frame.update as Extract<
            SessionUpdate,
            { sessionUpdate: "available_commands_update" }
          >;
          setAvailableCommands([...update.availableCommands]);
        }
        if (frame.update.sessionUpdate === "current_mode_update") {
          const update = frame.update as Extract<
            SessionUpdate,
            { sessionUpdate: "current_mode_update" }
          >;
          setCurrentModeId(update.currentModeId);
        }
        if (frame.update.sessionUpdate === "tool_call_update") {
          const update = frame.update as Extract<
            SessionUpdate,
            { sessionUpdate: "tool_call_update" }
          >;
          if (
            update.toolCallId === pendingPermission()?.toolCall.toolCallId &&
            (update.status === "completed" || update.status === "failed")
          ) {
            setPendingPermission(null);
          }
        }
        setStore(
          produce((draft) => {
            draft.messages.push({
              _tag: "AgentUpdate",
              id: `agent-update:${frame.seq}`,
              createdAt: now,
              update: frame.update,
            });
          }),
        );
        return;
      }
      if (frame.type === "chat.thread.stop") {
        const pending = pendingPromptId();
        if (!pending || pending === frame.promptId) {
          setPendingPromptId(null);
          setInflight(false);
          setStopReason(frame.stopReason);
          setCompletedAt(new Date().toISOString());
        }
      }
    });
    onCleanup(() => socket.close());
  });

  const rows = createMemo(() =>
    coalesceMessages(store.messages, {
      inflight: inflight(),
      stopReason: stopReason(),
      completedAt: completedAt(),
    }),
  );

  async function blocksForAttachments(items: ComposerAttachment[]): Promise<ContentBlock[]> {
    const terminalBlocks: ContentBlock[] = [];
    const fileBlocks: ContentBlock[] = [];

    for (const attachment of items) {
      if (attachment.kind !== "terminal") continue;
      const captured = await chatContextCaptureTerminal(runtime(), {
        sessionName: attachment.sessionName,
        paneId: attachment.paneId,
      });
      terminalBlocks.push({
        type: "resource",
        resource: {
          uri: `tmux-pane://${attachment.sessionName}/${attachment.paneId}`,
          text: captured.content,
          mimeType: "text/plain",
        },
      });
    }

    for (const attachment of items) {
      if (attachment.kind !== "file") continue;
      fileBlocks.push({
        type: "resource_link",
        uri: `file://${attachment.path}`,
        name: attachment.label,
        mimeType: "text/plain",
      });
    }

    return [...terminalBlocks, ...fileBlocks];
  }

  async function send(content: ContentBlock[]): Promise<void> {
    const opts = options();
    const pendingAttachments = attachments();
    setInflight(true);
    setStopReason(null);
    setCompletedAt(null);
    try {
      const fullContent = [...(await blocksForAttachments(pendingAttachments)), ...content];
      const result = await chatSessionSend(runtime(), opts.threadId, fullContent);
      setPendingPromptId(result.promptId);
      setAttachments([]);
      setStore(
        produce((draft) => {
          draft.messages.push({
            _tag: "UserPrompt",
            id: result.promptId,
            createdAt: new Date().toISOString(),
            content: fullContent,
          });
        }),
      );
    } catch (err) {
      setPendingPromptId(null);
      setInflight(false);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async function cancel(): Promise<void> {
    await chatSessionCancel(runtime(), options().threadId);
  }

  async function rename(title: string): Promise<void> {
    const result = await chatThreadRename(runtime(), options().threadId, title);
    setThread((current) =>
      current
        ? { ...current, title: result.thread.title, updatedAt: result.thread.updatedAt }
        : current,
    );
  }

  async function respondToPermission(optionId: string): Promise<void> {
    const pending = pendingPermission();
    if (!pending) return;
    setPendingPermission(null);
    try {
      await chatPermissionRespond(runtime(), {
        threadId: pending.threadId,
        requestId: pending.requestId,
        optionId,
      });
    } catch (err) {
      setPendingPermission(pending);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  function addAttachment(attachment: ComposerAttachment): void {
    setAttachments((current) => [...current, attachment]);
  }

  function removeAttachment(index: number): void {
    setAttachments((current) => current.filter((_, candidate) => candidate !== index));
  }

  function prefillPrompt(text: string | null): void {
    setPrefillPromptText(text);
  }

  const pendingPlan = createMemo<ProposedPlanSummary | null>(() => latestPending(plans()));

  async function approvePendingPlan(planId: string): Promise<void> {
    if (planResponding()) return;
    setPlanResponding(true);
    try {
      const result = await chatPlanApprove(runtime(), options().threadId, planId);
      // The daemon broadcasts a fresh chat.plan.upserted with
      // implementedAt set, which the WS effect above flips into the
      // store. Patch optimistically in case the socket is slow.
      setPlans((current) => current.map((plan) => (plan.id === planId ? result.plan : plan)));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setPlanResponding(false);
    }
  }

  async function rejectPendingPlan(planId: string, reason?: string): Promise<void> {
    if (planResponding()) return;
    setPlanResponding(true);
    try {
      const result = await chatPlanReject(runtime(), options().threadId, planId, reason);
      setPlans((current) => current.map((plan) => (plan.id === planId ? result.plan : plan)));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setPlanResponding(false);
    }
  }

  /**
   * "Modify" path. The daemon doesn't expose a modify route yet (see
   * audit §4 D3); the chat-solid surface bridges that gap by prefilling
   * the composer with the plan markdown so the user can edit + send a
   * fresh turn manually. The plan stays pending — choosing to send is
   * a separate user action, and approve / reject still close out the
   * follow-up banner.
   */
  function modifyPendingPlan(planId: string): void {
    const plan = plans().find((candidate) => candidate.id === planId);
    if (!plan) return;
    setPrefillPromptText(plan.planMarkdown);
  }

  return {
    thread,
    loading,
    error,
    inflight,
    stopReason,
    rows,
    messages: () => store.messages,
    availableCommands,
    currentModeId,
    pendingPermission,
    usage,
    attachments,
    terminalPanes,
    prefillPromptText,
    prefillPrompt,
    addAttachment,
    removeAttachment,
    send,
    cancel,
    rename,
    respondToPermission,
    pendingPlan,
    planResponding,
    approvePendingPlan,
    rejectPendingPlan,
    modifyPendingPlan,
    refetch,
  };
}
