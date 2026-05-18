import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  chatContextCaptureTerminal,
  chatPermissionRespond,
  chatPlanApprove,
  chatPlanList,
  chatPlanReject,
  chatSessionCancel,
  chatSessionEditFromTurn,
  chatSessionSend,
  chatThreadGet,
  chatThreadRename,
  chatThreadUsage,
  fetchProjectPanes,
  withAuthQuery,
  type ApiRuntime,
} from "../api";
import { deriveRuntimeState } from "../lib/runtimeState";
import { notifyAssistantTurnComplete } from "../lib/chatNotify";
import { buildPlanImplementationPrompt, proposedPlanTitle } from "../lib/proposedPlan";
import {
  requestKindFromToolCall,
  resolveApprovalOptionId,
  toPendingApproval,
} from "../lib/pendingApproval";
import type { PendingApproval } from "../components/ComposerPendingApprovalPanel";
import type { ProviderApprovalDecision } from "../components/ComposerPendingApprovalActions";
import type {
  PendingUserInput,
  PendingUserInputDraftAnswer,
} from "../components/ComposerPendingUserInputPanel";
import type { RuntimeMode } from "../components/CompactComposerControlsMenu";
import type {
  AvailableCommand,
  ChatBusEvent,
  ChatThreadUsageSummary,
  ChatMountOptions,
  ComposerAttachment,
  ComposerTerminalPane,
  ContentBlock,
  MessagesTimelineRow,
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

/**
 * Runtime-mode → auto-accept policy. Returns the option id to silently
 * respond with, or null to surface the inline approval panel.
 *
 *   - approval-required (Supervised): always surface (null).
 *   - auto-accept-edits: silently allow file reads/changes; commands
 *     still prompt.
 *   - full-access: silently allow everything.
 *
 * This is the only lever chat-solid has to make the runtime-mode
 * selector "actually change agent behavior" without a daemon set-mode
 * transport — it gates the existing chat.permission.respond path.
 */
function autoApproveOptionId(request: PermissionRequest, mode: RuntimeMode): string | null {
  if (mode === "approval-required") return null;
  if (mode === "auto-accept-edits") {
    const kind = requestKindFromToolCall(request.toolCall.kind);
    if (kind === "command") return null;
  }
  return resolveApprovalOptionId(request, "accept");
}

interface ChatStore {
  messages: ThreadMessage[];
}

/**
 * Chunk-streaming session-update kinds that the daemon emits one
 * frame per token-burst for. The hook coalesces consecutive frames
 * of the same kind + messageId into a single `AgentUpdate` so the
 * store grows by O(1) per turn instead of O(N) per chunk.
 */
type ContentChunkKind = "agent" | "thought" | "user";

function chunkKindOf(update: SessionUpdate): ContentChunkKind | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return "agent";
    case "agent_thought_chunk":
      return "thought";
    case "user_message_chunk":
      return "user";
    default:
      return null;
  }
}

function chunkMessageId(update: SessionUpdate): string | null {
  return (update as { messageId?: string | null }).messageId ?? null;
}

function chunkText(update: SessionUpdate): string | null {
  const content = (update as { content?: ContentBlock | null }).content;
  if (!content || content.type !== "text") return null;
  return content.text;
}

export function useChatThread(options: Accessor<ChatMountOptions>) {
  const [thread, setThread] = createSignal<ThreadState | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  const [inflight, setInflight] = createSignal(false);
  const [stopReason, setStopReason] = createSignal<StopReason | null>(null);
  // Only the setter is used now — the old `rows` memo was the sole
  // reader; the reducer stamps completedAt onto the row itself.
  const [, setCompletedAt] = createSignal<string | null>(null);
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
  // Session-local runtime mode. Default "approval-required"
  // (Supervised) preserves the always-prompt behavior until the user
  // opts into auto-accept. The daemon has no set-mode transport, so
  // this gates client-side auto-accept of approvals via the existing
  // chat.permission.respond round-trip — see autoApproveOptionId.
  const [runtimeMode, setRuntimeMode] = createSignal<RuntimeMode>("approval-required");
  const [respondingToApproval, setRespondingToApproval] = createSignal(false);
  // Pending "pick one" prompt state. The questions themselves are
  // host-sourced (options().pendingUserInputs, mirroring the
  // mentionCandidates / bannerItems "host owns sourcing" pattern);
  // answer drafts + cursor + in-flight ids live here, and a completed
  // prompt submits as a normal user turn via the send path.
  const [pendingUserInputAnswers, setPendingUserInputAnswers] = createSignal<
    Record<string, PendingUserInputDraftAnswer>
  >({});
  const [pendingUserInputQuestionIndex, setPendingUserInputQuestionIndex] = createSignal(0);
  const [pendingUserInputRespondingIds, setPendingUserInputRespondingIds] = createSignal<string[]>(
    [],
  );
  const [store, setStore] = createStore<ChatStore>({ messages: [] });
  // Server-materialized render model. The daemon reduces ACP chunks
  // into the canonical `MessagesTimelineRow[]` and pushes whole-row
  // upsert deltas; this store is a pure mirror — no client-side
  // coalescing. `chat.thread.get` seeds it; `chat.timeline.upsert`
  // (incremental, per streamed burst) and `chat.timeline.reset`
  // (structural rewind) keep it current. Unchanged row objects are
  // reused across deltas so Solid's per-row memo skips untouched rows
  // and only the streaming row's text node re-renders per token.
  const [rowStore, setRowStore] = createStore<{ rows: MessagesTimelineRow[] }>({ rows: [] });

  // Upsert rows into the current array in place: replace existing rows
  // by id (so referential identity churns only for changed rows),
  // append genuinely-new ids in arrival order. Never drops a row — the
  // safe fallback when no authoritative `order` is available.
  function upsertRowsInPlace(
    current: ReadonlyArray<MessagesTimelineRow>,
    rows: ReadonlyArray<MessagesTimelineRow>,
  ): MessagesTimelineRow[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const next: MessagesTimelineRow[] = current.map((row) => byId.get(row.id) ?? row);
    const have = new Set(next.map((row) => row.id));
    for (const row of rows) {
      if (!have.has(row.id)) {
        next.push(row);
        have.add(row.id);
      }
    }
    return next;
  }

  // Merge an incremental timeline delta. `order` is authoritative when
  // present: rebuild in that order, reusing prior row objects for ids
  // absent from `deltaRows` (referential stability → the per-row memo
  // returns the same reference and that subtree skips re-derivation).
  //
  // Robustness: if `order` is missing/empty, or rebuilding from it
  // would blank a non-empty transcript (a malformed / out-of-context
  // frame), fall back to an in-place upsert so a bad delta can never
  // wipe the rendered thread.
  function applyTimelineDelta(deltaRows: MessagesTimelineRow[], order?: string[]): void {
    if (!order || order.length === 0) {
      setRowStore("rows", upsertRowsInPlace(rowStore.rows, deltaRows));
      return;
    }
    const prev = new Map(rowStore.rows.map((row) => [row.id, row]));
    const delta = new Map(deltaRows.map((row) => [row.id, row]));
    const next: MessagesTimelineRow[] = [];
    for (const id of order) {
      const row = delta.get(id) ?? prev.get(id);
      if (row) next.push(row);
    }
    if (next.length === 0 && (rowStore.rows.length > 0 || deltaRows.length > 0)) {
      setRowStore("rows", upsertRowsInPlace(rowStore.rows, deltaRows));
      return;
    }
    setRowStore("rows", next);
  }

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
      // History bootstrap is the server-materialized timeline. Live
      // `chat.timeline.*` deltas take over from here — no client-side
      // reduction. (`?? []` tolerates older fixtures / pre-migration
      // daemons that only return `thread`.)
      setRowStore("rows", result.timeline ?? []);
      setAvailableCommands(derived.availableCommands);
      setCurrentModeId(derived.currentModeId);
      setStopReason(null);
      setCompletedAt(null);
      setPendingPermission(null);
    } catch (err) {
      setThread(null);
      setUsage(null);
      setStore("messages", []);
      setRowStore("rows", []);
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

  // Raw-log writer. The daemon emits one `chat.thread.update` frame
  // per token-burst; this merges consecutive same-kind same-messageId
  // text chunks into the previous AgentUpdate's content in place so
  // `store.messages` (the public `chat.messages()` contract) grows
  // O(1) per turn. The render model is maintained separately by the
  // incremental row reducer — there is no RAF batch any more: with a
  // persistent rowStore, Solid's fine-grained tracking makes a
  // per-chunk append cheap, so each frame applies synchronously.
  function applyUpdateFrameToMessages(
    frame: Extract<ChatBusEvent, { type: "chat.thread.update" }>,
    draft: ChatStore,
  ): void {
    const update = frame.update;
    const kind = chunkKindOf(update);
    const text = chunkText(update);
    if (kind !== null && text !== null) {
      const last = draft.messages[draft.messages.length - 1];
      if (last && last._tag === "AgentUpdate") {
        const lastKind = chunkKindOf(last.update);
        const lastText = chunkText(last.update);
        if (
          lastKind === kind &&
          chunkMessageId(last.update) === chunkMessageId(update) &&
          lastText !== null
        ) {
          // Mutate the existing chunk's text in place. Solid's
          // `produce` records the fine-grained path so subscribers
          // observing `messages[i].update.content.text` re-run
          // without invalidating sibling rows.
          (last.update as { content: ContentBlock }).content = {
            type: "text",
            text: lastText + text,
          };
          return;
        }
      }
    }
    draft.messages.push({
      _tag: "AgentUpdate",
      id: `agent-update:${frame.seq}`,
      createdAt: new Date().toISOString(),
      update,
    });
  }

  createEffect(() => {
    const opts = options();
    const socket = new WebSocket(withAuthQuery(opts.wsUrl, opts.bearerToken));
    socket.addEventListener("message", (event) => {
      let frame: ChatBusEvent;
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
        const request: PermissionRequest = {
          threadId: frame.threadId,
          requestId: frame.requestId,
          toolCall: frame.toolCall,
          options: [...frame.options],
          receivedAt: Date.now(),
        };
        const autoOptionId = autoApproveOptionId(request, runtimeMode());
        if (autoOptionId) {
          // Runtime mode says don't bother the user — accept on their
          // behalf through the same respond endpoint, and only fall
          // back to surfacing the inline panel if that POST fails.
          void dispatchPermissionResponse(request, autoOptionId).catch((err) => {
            setPendingPermission(request);
            setError(err instanceof Error ? err : new Error(String(err)));
          });
          return;
        }
        setPendingPermission(request);
        return;
      }
      if (frame.type === "chat.timeline.reset") {
        // Structural rewind (history bootstrap / editFromTurn): the
        // daemon re-materialized the whole thread. Replace wholesale.
        setRowStore("rows", frame.rows);
        return;
      }
      if (frame.type === "chat.timeline.upsert") {
        // Streaming hot path: the daemon already reduced the chunk
        // into whole-row form. Merge by id; unchanged rows keep
        // identity so only the streaming row re-renders.
        applyTimelineDelta(frame.rows, frame.order);
        return;
      }
      if (frame.type === "chat.thread.update") {
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
        // Raw event log only (the pinned `chat.messages()` contract):
        // bounded O(1)-per-turn append. The rendered transcript is the
        // server-materialized `chat.timeline.*` stream — the client no
        // longer reduces chunks into rows.
        setStore(produce((draft) => applyUpdateFrameToMessages(frame, draft)));
        return;
      }
      if (frame.type === "chat.thread.stop") {
        const pending = pendingPromptId();
        if (!pending || pending === frame.promptId) {
          setPendingPromptId(null);
          setInflight(false);
          setStopReason(frame.stopReason);
          setCompletedAt(new Date().toISOString());
          // Only chime/banner for a turn the user actually triggered
          // (pending prompt matched), never on replay/reconnect.
          if (pending) notifyAssistantTurnComplete();
        }
        // The streaming row is closed server-side: dispatch emits
        // `chat.thread.stop` then `pipe.finishTimeline`, which
        // broadcasts a `chat.timeline.upsert` flipping the row's
        // `streaming` flag off. No client-side row mutation here.
      }
    });
    onCleanup(() => socket.close());
  });

  // Pure mirror of the server-materialized timeline. Streaming / stop
  // state lives on the rows themselves (set by the daemon), so this is
  // a plain store read — no recompute, no client reduction.
  const rows = (): MessagesTimelineRow[] => rowStore.rows;

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
      const createdAt = new Date().toISOString();
      const userPrompt: Extract<ThreadMessage, { _tag: "UserPrompt" }> = {
        _tag: "UserPrompt",
        id: result.promptId,
        createdAt,
        content: fullContent,
      };
      // Raw-log contract (`chat.messages()`), unchanged.
      setStore(produce((draft) => draft.messages.push(userPrompt)));
      // Optimistic user row so it shows instantly. Idempotent by id:
      // the daemon also broadcasts `chat.timeline.reset` from send
      // (carrying this same prompt id) and the two can race either way
      // — upsert-in-place so we never duplicate or drop the bubble.
      const optimisticUserRow: MessagesTimelineRow = {
        kind: "message",
        id: result.promptId,
        createdAt,
        message: { id: result.promptId, role: "user", createdAt, content: fullContent },
      };
      setRowStore("rows", (current) => upsertRowsInPlace(current, [optimisticUserRow]));
    } catch (err) {
      setPendingPromptId(null);
      setInflight(false);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async function cancel(): Promise<void> {
    // Optimistic: clear the caret immediately instead of waiting for
    // the provider to return, emit `chat.thread.stop`, and the daemon
    // to broadcast the streaming-off row upsert. A long turn otherwise
    // shows a stuck caret for the whole tail latency. The eventual
    // server upsert reconciles (it carries the same row id; finish is
    // idempotent server-side).
    const completedAtIso = new Date().toISOString();
    setRowStore(
      produce((state) => {
        for (const row of state.rows) {
          if (row.kind === "message" && row.message.role === "assistant" && row.message.streaming) {
            row.message.streaming = false;
            row.message.stopReason = "cancelled";
            row.message.completedAt = completedAtIso;
          }
        }
        // Drop any trailing working row (empty-turn placeholder).
        const working = state.rows.findIndex((row) => row.kind === "working");
        if (working !== -1) state.rows.splice(working, 1);
      }),
    );
    setInflight(false);
    setStopReason("cancelled");
    setCompletedAt(completedAtIso);
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

  // Single source of the permission round-trip. Both the manual
  // verdict path (respondToPermission / respondToApproval) and the
  // runtime-mode auto-accept path post through here.
  async function dispatchPermissionResponse(
    request: PermissionRequest,
    optionId: string,
  ): Promise<void> {
    await chatPermissionRespond(runtime(), {
      threadId: request.threadId,
      requestId: request.requestId,
      optionId,
    });
  }

  async function respondToPermission(optionId: string): Promise<void> {
    const pending = pendingPermission();
    if (!pending) return;
    setPendingPermission(null);
    try {
      await dispatchPermissionResponse(pending, optionId);
    } catch (err) {
      setPendingPermission(pending);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  const pendingApproval = createMemo<PendingApproval | null>(() => {
    const pending = pendingPermission();
    return pending ? toPendingApproval(pending) : null;
  });

  // Maps the composer's four-verb decision onto a concrete daemon
  // option id and reuses respondToPermission so the respond logic
  // isn't duplicated. No-ops when the request changed underneath
  // (stale click) or the daemon offered no matching option.
  async function respondToApproval(
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const pending = pendingPermission();
    if (!pending || pending.requestId !== requestId) return;
    const optionId = resolveApprovalOptionId(pending, decision);
    if (!optionId) return;
    setRespondingToApproval(true);
    try {
      await respondToPermission(optionId);
    } finally {
      setRespondingToApproval(false);
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

  const pendingUserInputs = (): ReadonlyArray<PendingUserInput> =>
    options().pendingUserInputs?.() ?? [];

  const activeUserInputPrompt = createMemo<PendingUserInput | null>(
    () => pendingUserInputs()[0] ?? null,
  );

  function togglePendingUserInputOption(questionId: string, optionLabel: string): void {
    const prompt = activeUserInputPrompt();
    if (!prompt) return;
    const question = prompt.questions.find((entry) => entry.id === questionId);
    if (!question) return;
    setPendingUserInputAnswers((current) => {
      const previous = current[questionId]?.selectedOptionLabels ?? [];
      let next: string[];
      if (question.multiSelect) {
        next = previous.includes(optionLabel)
          ? previous.filter((label) => label !== optionLabel)
          : [...previous, optionLabel];
      } else {
        next = [optionLabel];
      }
      return { ...current, [questionId]: { ...current[questionId], selectedOptionLabels: next } };
    });
  }

  function clearPendingUserInputDraft(): void {
    setPendingUserInputAnswers({});
    setPendingUserInputQuestionIndex(0);
  }

  function advancePendingUserInput(): void {
    const prompt = activeUserInputPrompt();
    if (!prompt) return;
    const index = pendingUserInputQuestionIndex();
    if (index < prompt.questions.length - 1) {
      setPendingUserInputQuestionIndex(index + 1);
      return;
    }
    // Last question answered — submit the picks as a normal user turn.
    // The agent dispatches the follow-up; the host's pendingUserInputs
    // source clears as that lands. We clear the local draft eagerly.
    const answers = pendingUserInputAnswers();
    const lines = prompt.questions
      .map((question) => {
        const picked = answers[question.id]?.selectedOptionLabels ?? [];
        if (picked.length === 0) return null;
        return `${question.header}: ${picked.join(", ")}`;
      })
      .filter((line): line is string => line !== null);
    if (lines.length === 0) return;
    setPendingUserInputRespondingIds((current) =>
      current.includes(prompt.requestId) ? current : [...current, prompt.requestId],
    );
    void send([{ type: "text", text: lines.join("\n") }]).finally(() => {
      setPendingUserInputRespondingIds((current) =>
        current.filter((id) => id !== prompt.requestId),
      );
      clearPendingUserInputDraft();
    });
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

  // Drives the plan follow-up split button in ComposerPrimaryActions.
  // True whenever a pending plan is staged for this thread.
  const showPlanFollowUpPrompt = createMemo<boolean>(() => pendingPlan() !== null);

  /**
   * Plan implementation prompt for the *current* thread. Used as the
   * content the composer submits when the user clicks the inline
   * "Implement" button with an empty draft (mirrors upstream's
   * empty-draft branch of resolvePlanFollowUpSubmission).
   */
  function planImplementationContent(): ContentBlock[] | null {
    const plan = pendingPlan();
    if (!plan) return null;
    return [{ type: "text", text: buildPlanImplementationPrompt(plan.planMarkdown) }];
  }

  /**
   * "Implement in a new thread" action. Hands the host a payload to
   * spin up a sibling thread + navigate to it. When the host doesn't
   * wire `onImplementPlanInNewThread`, we degrade to implementing the
   * plan in the current thread so the menu item is never a dead
   * no-op.
   */
  function implementPlanInNewThread(): void {
    const plan = pendingPlan();
    if (!plan) return;
    const handler = options().onImplementPlanInNewThread;
    if (handler) {
      handler({
        planMarkdown: plan.planMarkdown,
        planTitle: proposedPlanTitle(plan.planMarkdown),
        implementationPrompt: buildPlanImplementationPrompt(plan.planMarkdown),
      });
      return;
    }
    const content = planImplementationContent();
    if (content) void send(content);
  }

  /**
   * In-place edit + regenerate. Truncates the thread back through the
   * targeted user message on the daemon, then dispatches `content` as
   * a fresh turn. We mirror the truncation locally (drop the edited
   * prompt and everything after, push the replacement) so the
   * timeline rewinds immediately; the WS stream fills in the new
   * assistant reply, and `chat.thread.stop` matches `promptId`.
   */
  async function editFromTurn(userMessageId: string, content: ContentBlock[]): Promise<void> {
    const opts = options();
    setInflight(true);
    setStopReason(null);
    setCompletedAt(null);
    try {
      const result = await chatSessionEditFromTurn(
        runtime(),
        opts.threadId,
        userMessageId,
        content,
      );
      setPendingPromptId(result.promptId);
      const createdAt = new Date().toISOString();
      const replacement: Extract<ThreadMessage, { _tag: "UserPrompt" }> = {
        _tag: "UserPrompt",
        id: result.promptId,
        createdAt,
        content,
      };
      // Raw-log contract (`chat.messages()` + revertFromMessage reads
      // this to find the prompt), unchanged.
      setStore(
        produce((draft) => {
          const idx = draft.messages.findIndex(
            (m) => m._tag === "UserPrompt" && m.id === userMessageId,
          );
          if (idx >= 0) draft.messages.splice(idx);
          draft.messages.push(replacement);
        }),
      );
      // Optimistic rewind: drop the edited user row and everything
      // after, append the replacement. The daemon truncates the log,
      // re-materializes, and broadcasts `chat.timeline.reset` which
      // reconciles this; the regenerated reply then streams in.
      setRowStore("rows", (current) => {
        const idx = current.findIndex(
          (row) =>
            row.kind === "message" && row.message.role === "user" && row.id === userMessageId,
        );
        const kept = idx >= 0 ? current.slice(0, idx) : [...current];
        kept.push({
          kind: "message",
          id: result.promptId,
          createdAt,
          message: { id: result.promptId, role: "user", createdAt, content },
        });
        return kept;
      });
    } catch (err) {
      setInflight(false);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * Revert-to-user-message: rewind the thread to an earlier user
   * turn and resume from it unchanged. Re-uses `editFromTurn` with
   * the message's *original* content (pulled from the local store)
   * so the daemon truncates everything after and re-dispatches the
   * same prompt — the agent simply re-runs from that point.
   */
  async function revertFromMessage(userMessageId: string): Promise<void> {
    const target = store.messages.find((m) => m._tag === "UserPrompt" && m.id === userMessageId);
    if (!target || target._tag !== "UserPrompt") return;
    await editFromTurn(userMessageId, [...target.content]);
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
    pendingApproval,
    respondToApproval,
    isRespondingToApproval: respondingToApproval,
    runtimeMode,
    setRuntimeMode,
    pendingUserInputs,
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    pendingUserInputRespondingIds,
    togglePendingUserInputOption,
    advancePendingUserInput,
    pendingPlan,
    planResponding,
    approvePendingPlan,
    rejectPendingPlan,
    modifyPendingPlan,
    showPlanFollowUpPrompt,
    planImplementationContent,
    implementPlanInNewThread,
    editFromTurn,
    revertFromMessage,
    refetch,
  };
}
