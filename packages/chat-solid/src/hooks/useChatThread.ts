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
import { loadModelSelection } from "../lib/modelSelectionStore";
import { loadActiveProviderKind } from "../lib/activeProviderStore";
import { loadProviderOptions } from "../lib/providerOptionsStore";
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
  // WS connection lifecycle (Step 2: reconnect/resume). Surfaced to the
  // UI as a minimal indicator; rendering is never blocked on it — the
  // last server-materialized timeline stays on screen while we
  // reconnect, then resume replays the gap.
  const [connectionState, setConnectionState] = createSignal<
    "connecting" | "open" | "reconnecting" | "closed"
  >("connecting");
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

  // Apply a server-materialized timeline upsert. `serverOrder` is the
  // authoritative full ordered id list the daemon's message-pipe emits
  // alongside `rows` on every burst. Rebuild strictly from it: take the
  // changed row from the delta, reuse the prior row object for ids the
  // delta omits (referential stability → Solid's per-row memo skips
  // untouched subtrees). Pure mirror — replace/keep by id,
  // server-ordered, zero coalescing. A frame the renderer can't apply
  // is a daemon bug to fix at the source (Step 2 resume), never a
  // client-side reduction.
  function applyTimelineUpsert(deltaRows: MessagesTimelineRow[], serverOrder: string[]): void {
    const delta = new Map(deltaRows.map((row) => [row.id, row]));
    const prev = new Map(rowStore.rows.map((row) => [row.id, row]));
    const next: MessagesTimelineRow[] = [];
    for (const id of serverOrder) {
      const row = delta.get(id) ?? prev.get(id);
      if (row) next.push(row);
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

  // Reconnecting WS with sequence-replay resume (Step 2). The bare
  // close-only socket lost the in-flight turn permanently on any drop.
  // Now: a connection-state machine + bounded backoff; on every
  // (re)connect we send `chat.subscribe { threadId, lastSeq }` and the
  // daemon replays the materialized timeline frames we missed, in
  // order, through the SAME pure-renderer path. `lastSeq` is the last
  // applied per-thread timeline seq; replayed frames are deduped by it
  // so reconnect is gap-free and dupe-free.
  createEffect(() => {
    const opts = options();
    let lastSeq = 0;
    let intentionalClose = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;
    const MAX_BACKOFF_MS = 8_000;
    let socket: WebSocket | null = null;

    // Pure-renderer reconciliation: after applying a server-materialized
    // timeline frame, if nothing is streaming anymore but we still think
    // a turn is inflight (we may have missed `chat.thread.stop` across a
    // drop), clear the local UI flag. The transcript itself is already
    // correct from the row's own `streaming:false`.
    const reconcileInflight = (): void => {
      if (!inflight()) return;
      const streaming = rowStore.rows.some(
        (row) =>
          row.kind === "message" && row.message.role === "assistant" && row.message.streaming,
      );
      if (!streaming) setInflight(false);
    };

    const applyFrame = (frame: ChatBusEvent): void => {
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
        // Structural rewind / resume baseline: the daemon
        // re-materialized the whole thread. Replace wholesale —
        // idempotent, so always apply (even on replay) and advance the
        // resume cursor.
        setRowStore("rows", frame.rows);
        if (typeof frame.seq === "number") lastSeq = Math.max(lastSeq, frame.seq);
        reconcileInflight();
        return;
      }
      if (frame.type === "chat.timeline.upsert") {
        // Streaming hot path / replayed gap: the daemon already
        // materialized the chunk into whole-row form with the
        // authoritative order. Dedupe by seq (a resume never re-applies
        // a frame we already had), then pure-mirror by id.
        if (typeof frame.seq === "number" && frame.seq <= lastSeq) return;
        applyTimelineUpsert(frame.rows, frame.order);
        if (typeof frame.seq === "number") lastSeq = frame.seq;
        reconcileInflight();
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
        // `chat.thread.update` carries only control signals now
        // (commands / mode / tool-call status). The rendered
        // transcript AND the raw `chat.messages()` log are the
        // server-materialized truth — the client performs zero
        // reduction of streamed chunks.
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
    };

    const onMessage = (event: MessageEvent): void => {
      let frame: ChatBusEvent;
      try {
        frame = JSON.parse(String(event.data)) as ChatBusEvent;
      } catch {
        return;
      }
      applyFrame(frame);
    };

    const connect = (reconnect: boolean): void => {
      setConnectionState(reconnect ? "reconnecting" : "connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(withAuthQuery(opts.wsUrl, opts.bearerToken));
      } catch {
        // Construction failed (bad URL / offline) — back off and retry.
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.addEventListener("open", () => {
        backoffMs = 500;
        setConnectionState("open");
        try {
          // Resume: ask the daemon to replay everything past the last
          // timeline seq we applied. lastSeq 0 ⇒ full in-flight replay.
          ws.send(JSON.stringify({ type: "chat.subscribe", threadId: opts.threadId, lastSeq }));
        } catch {
          // The close handler will reconnect.
        }
      });
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", () => {
        if (intentionalClose) {
          setConnectionState("closed");
          return;
        }
        scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {
          /* close handler drives the reconnect */
        }
      });
    };

    function scheduleReconnect(): void {
      if (intentionalClose || reconnectTimer) return;
      setConnectionState("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(true);
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    connect(false);

    onCleanup(() => {
      intentionalClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      setConnectionState("closed");
    });
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
      // Per-turn provider + model selection (Step 3b — t3-mirror).
      // The CLIENT owns the visible provider and writes here
      // synchronously when the user picks; the daemon routes THIS
      // turn through that kind regardless of thread.provider.kind.
      // Persisted thread.provider is only the reload fallback.
      const overrideKind = loadActiveProviderKind(opts.threadId);
      const persistedKind = thread()?.provider.kind ?? null;
      const effectiveKind = overrideKind ?? persistedKind;
      const selectedModel = effectiveKind ? loadModelSelection(opts.threadId, effectiveKind) : null;
      // Per-turn provider options (CODEX-FULL) — Codex reasoning
      // effort + fast-mode. Read from the per-thread×kind×model
      // store; daemon falls back to its in-memory carry-over when
      // we send nothing.
      const providerOptions =
        effectiveKind && selectedModel
          ? loadProviderOptions(opts.threadId, effectiveKind, selectedModel)
          : [];
      const result = await chatSessionSend(runtime(), opts.threadId, fullContent, {
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(overrideKind ? { provider: { kind: overrideKind } } : {}),
        ...(providerOptions.length > 0 ? { providerOptions } : {}),
      });
      setPendingPromptId(result.promptId);
      setAttachments([]);
      const createdAt = new Date().toISOString();
      const userPrompt: Extract<ThreadMessage, { _tag: "UserPrompt" }> = {
        _tag: "UserPrompt",
        id: result.promptId,
        createdAt,
        content: fullContent,
      };
      // Raw-log contract (`chat.messages()`) — user-authored, not a
      // reduction; `revertFromMessage` reads it back. The rendered
      // transcript is NOT touched here: `chat.session.send`
      // re-materializes server-side and broadcasts `chat.timeline.reset`
      // (carrying this prompt id) which the renderer mirrors.
      setStore(produce((draft) => draft.messages.push(userPrompt)));
    } catch (err) {
      setPendingPromptId(null);
      setInflight(false);
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async function cancel(): Promise<void> {
    // Local UI signals clear immediately so the composer unlocks; the
    // rendered transcript is NOT touched here. The daemon owns the
    // materialized row: cancel → dispatch resolves → `chat.thread.stop`
    // + `pipe.finishTimeline` broadcasts the streaming-off
    // `chat.timeline.upsert` the renderer mirrors. No client-side row
    // mutation — that would be exactly the reduction Step 1 removes.
    setInflight(false);
    setStopReason("cancelled");
    setCompletedAt(new Date().toISOString());
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
      // this to find the prompt) — user-authored, not a reduction. The
      // rendered transcript is NOT rewound here: the daemon truncates
      // the log, re-materializes, and broadcasts `chat.timeline.reset`
      // which the renderer mirrors wholesale; the regenerated reply
      // then streams in via `chat.timeline.upsert`.
      setStore(
        produce((draft) => {
          const idx = draft.messages.findIndex(
            (m) => m._tag === "UserPrompt" && m.id === userMessageId,
          );
          if (idx >= 0) draft.messages.splice(idx);
          draft.messages.push(replacement);
        }),
      );
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
    connectionState,
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
