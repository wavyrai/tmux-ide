/**
 * SessionChannel — one control-mode channel serving every pane subscription
 * of one tmux session (m43 card 1).
 *
 * Responsibilities, in the order the bytes see them:
 *
 *  - ROUTING: `%output`/`%extended-output` bytes are keyed by runtime `%N`
 *    and fanned out to that pane's subscribers through their {@link PaneFeed}
 *    gates. Runtime ids never leave this module — the public surface
 *    (subscribe, describe, layout events) speaks semantic ids only.
 *  - IDENTITY: the descriptor discovery ({@link SessionDescriptorDiscovery})
 *    feeds the workspace-tmux-adapter reconciliation; stamps are untrusted
 *    until verified, generated ids become real only after their pane-local
 *    stamp-back succeeds, and duplicate stamps are ALL restamped.
 *  - SEED/RESEED: the atomic recipe (capture + cursor probe back-to-back on
 *    the control channel, discard-until-reply) via `commandInline`, whose
 *    callbacks fire synchronously in channel read order.
 *  - FLOW: `%pause` bookkeeping in the {@link FlowLedger}; sticky-pause
 *    recovery continues+reseeds EVERY backpressure-paused pane that still has
 *    an unfrozen subscriber; explicit freeze/thaw parks one pane without
 *    touching siblings.
 *  - LAYOUT: `%layout-change`/`%window-pane-changed`/`%session-window-changed`
 *    are applied synchronously in notification order (ahead of any output the
 *    server emitted after the layout), joined to semantic window/pane ids.
 *  - INPUT: literals coalesce per pane (measured 256-byte chunks) and named
 *    keys flush pending literals first — the shared {@link InputCoalescer}
 *    discipline — leaving fire-and-forget via the channel.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  WORKSPACE_SEMANTIC_PANE_OPTION,
  WORKSPACE_SEMANTIC_WINDOW_OPTION,
  WorkspaceIdSchemaZ,
  type WorkspacePaneRect,
} from "@tmux-ide/contracts";
import { textToHexKeys } from "../protocol/control.ts";
import { InputCoalescer } from "../protocol/input-coalescer.ts";
import type { InputAction } from "../protocol/input-coalescer.ts";
import {
  parseLayout,
  parseLayoutChange,
  parseSessionWindowChanged,
  parseWindowPaneChanged,
  type ParsedLayout,
} from "../protocol/layout-parse.ts";
import {
  SESSION_PANE_DESCRIPTOR_FORMAT,
  SessionDescriptorDiscovery,
  decodeControlReplyUtf8,
  decodeTmuxArgument,
  parseSessionPaneDescriptorReply,
  type SessionPaneDescriptor,
} from "../protocol/session-descriptor-discovery.ts";
import { resolvePaneDisplayName } from "../protocol/pane-display-name.ts";
import {
  finalizeWorkspaceTmuxReconciliation,
  planWorkspaceTmuxReconciliation,
  type WorkspaceTmuxPaneSnapshot,
  type WorkspaceTmuxStampOutcome,
} from "../protocol/workspace-tmux-adapter.ts";
import type {
  AtomicPaneSnapshotFailureReason,
  AtomicPaneSnapshotProgress,
  AtomicPaneSnapshotResult,
  MirrorChannelHandlers,
  MirrorChannelIo,
  MirrorOutputTiming,
} from "./control-channel.ts";
import type {
  MirrorDiagnostic,
  MirrorLayoutAuthoritySnapshot,
  MirrorLayoutEvent,
  MirrorPaneEvent,
  MirrorSessionDescription,
} from "./events.ts";
import { FlowLedger } from "./flow-ledger.ts";
import { PaneFeed } from "./pane-feed.ts";
import type {
  TrustedMirrorPaneInventory,
  TrustedMirrorSessionInventory,
} from "./trusted-inventory.ts";
import {
  INTERNAL_READ_OPERATION_OPTION,
  registerInternalReadOperation,
  retireInternalReadOperation,
} from "../../lib/tmux-interaction-options.ts";

/** Notifications whose payload cannot be applied directly — fall back to the
 *  debounced truth sync (shared by all semantic terminal clients). */
const STRUCTURAL_NOTIFICATIONS = new Set([
  "window-add",
  "window-close",
  "window-renamed",
  "unlinked-window-close",
]);
const NATIVE_CLIENT_NOTIFICATIONS = new Set([
  "client-attached",
  "client-detached",
  "client-resized",
  "client-session-changed",
  "subscription-changed",
]);
const NATIVE_CLIENT_SUBSCRIPTION = "tmux-ide-native-clients";

const DEFAULT_HISTORY_LINES = 2000;
const SYNC_DEBOUNCE_MS = 40;
/** Foreground-command labels follow output, but never turn a busy pane into a probe loop. */
const DISPLAY_NAME_SYNC_INTERVAL_MS = 750;
const RECOVERY_QUIET_MS = 40;
const RECOVERY_COMMAND_DEADLINE_MS = 500;
const RECOVERY_NO_PROGRESS_DEADLINE_MS = 3_000;
const RECOVERY_ABSOLUTE_DEADLINE_MS = 5_000;
const RECOVERY_MAX_ATTEMPTS = 4;
const RECOVERY_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
const RECOVERY_CAPTURE_MAX_LINES = 8_192;
const RECOVERY_CURSOR_MAX_BYTES = 1_024;
const MAX_CONTINUE_NOTIFICATION_QUEUE = 32;
const MAX_CONTINUE_NOTIFICATION_DEBT = 65_536;
const RECOVERY_CURSOR_PROBE_FORMAT = [
  "#{cursor_x}",
  "#{cursor_y}",
  "#{pane_width}",
  "#{pane_height}",
  "#{alternate_on}",
  "#{cursor_flag}",
  "#{insert_flag}",
  "#{keypad_cursor_flag}",
  "#{keypad_flag}",
  "#{mouse_any_flag}",
  "#{mouse_button_flag}",
  "#{mouse_standard_flag}",
  "#{origin_flag}",
  "#{wrap_flag}",
].join(" ");

export type MirrorFlowRecoveryPhase =
  | "pause"
  | "continue-request"
  | "continue-reply"
  | "continue-notify"
  | "provisional-reseed"
  | "final-continue-request"
  | "final-continue-reply"
  | "final-reseed"
  | "confirmation-reseed"
  | "converged"
  | "nonconverged";

export type MirrorFlowRecoveryFailureReason =
  | "command-error"
  | "command-timeout"
  | "notification-queue-overflow"
  | "no-progress"
  | "absolute-deadline"
  | "attempts-exhausted";

export interface MirrorFlowRecoveryObservation {
  readonly semanticPaneId: string;
  readonly phase: MirrorFlowRecoveryPhase;
  readonly recoveryOrdinal: number;
  readonly paneIncarnation: number;
  readonly outputOrdinal: number;
  readonly failureReason: MirrorFlowRecoveryFailureReason | null;
  /** Monotonic time from this recovery's start, bounded by its absolute lease. */
  readonly elapsedMicros: number;
  /** Private full-snapshot fingerprints never leave this module. */
  readonly fingerprintExact: boolean | null;
  readonly confirmationOrdinal: number;
  readonly collectorStarted: boolean;
  readonly collectorLastCompletedOrdinal: number;
  readonly collectorCaptureLineCount: number;
  readonly collectorCaptureByteCount: number;
  readonly collectorContinueObserved: boolean;
  readonly collectorStatusObserved: boolean;
  readonly collectorObserverEmissionObserved: boolean;
  readonly collectorFailureReason: AtomicPaneSnapshotFailureReason | null;
}

export interface SessionChannelOptions {
  session: string;
  createIo: (handlers: MirrorChannelHandlers) => MirrorChannelIo;
  historyLines?: number;
  generatePaneId?: () => string;
  generateWindowId?: () => string;
  /** Debounce scheduler for the truth sync — injectable for tests. Returns a
   *  cancel function. */
  scheduleSync?: (callback: () => void, delayMs: number) => () => void;
  scheduleRecovery?: (callback: () => void, delayMs: number) => () => void;
  recoveryNowMs?: () => number;
  generateAtomicHookNonce?: () => string;
  internalReadHookEmission?: (
    runtimePaneId: string,
    marker: string,
  ) => { readonly bufferName: string; readonly signalChannel: string; readonly record: string };
  /** The channel died underneath us (tmux exited or detached the client). */
  onExit?: () => void;
  /** Event-driven proof that a non-control tmux client is actively attached. */
  onNativeClientActivity?: () => void;
  onInputWrite?: (
    action: InputAction,
    startedAtMicros: number,
    endedAtMicros: number,
    pendingBeforeSend: number,
  ) => void;
  onInputAccepted?: (action: InputAction, acceptedAtMicros: number, ok: boolean) => void;
  onOutputObserved?: (
    semanticPaneId: string,
    ageMs: number | null,
    timing?: MirrorOutputTiming,
  ) => void;
  onFlowRecoveryObserved?: (observation: MirrorFlowRecoveryObservation) => void;
}

export interface PaneSubscriptionHandle {
  readonly semanticPaneId: string;
  freeze(): void;
  thaw(): void;
  reseed(): void;
  sendText(text: string): void;
  sendKey(key: string): void;
  close(): void;
}

export interface LayoutSubscriptionHandle {
  close(): void;
}

interface SubRecord {
  readonly feed: PaneFeed;
  readonly onEvent: (event: MirrorPaneEvent) => void;
  readonly onLayout: ((event: MirrorLayoutEvent) => void) | null;
  pane: PaneRecord;
  frozen: boolean;
  closed: boolean;
}

interface PaneRecord {
  runtimeId: string;
  semanticId: string;
  descriptor: SessionPaneDescriptor | null;
  active: boolean;
  windowRuntimeId: string | null;
  readonly subs: Set<SubRecord>;
  incarnation: number;
}

interface RecoveryRecord {
  readonly ordinal: number;
  readonly runtimeId: string;
  readonly paneIncarnation: number;
  readonly reason: "backpressure" | "requested";
  readonly startedAtMs: number;
  retired: boolean;
  continueReply: boolean;
  continueNotify: boolean;
  stage: "continue" | "provisional" | "final-continue" | "quiet" | "final" | "confirm";
  attempts: number;
  reseedOrdinal: number;
  outputOrdinal: number;
  candidateFingerprint: string | null;
  confirmationFingerprint: string | null;
  confirmationOrdinal: number;
  atomicCollectorNonce: string | null;
  collectorStarted: boolean;
  collectorLastCompletedOrdinal: number;
  collectorCaptureLineCount: number;
  collectorCaptureByteCount: number;
  collectorContinueObserved: boolean;
  collectorStatusObserved: boolean;
  collectorObserverEmissionObserved: boolean;
  collectorFailureReason: AtomicPaneSnapshotFailureReason | null;
  cancelQuiet: (() => void) | null;
  cancelCommandDeadline: (() => void) | null;
  cancelNoProgressDeadline: (() => void) | null;
  cancelAbsoluteDeadline: (() => void) | null;
}

interface ReseedResult {
  readonly ok: boolean;
  readonly fingerprint: string | null;
  readonly publish: () => boolean;
  readonly hold: () => void;
}

const FAILED_RESEED_RESULT: ReseedResult = Object.freeze({
  ok: false,
  fingerprint: null,
  publish: () => false,
  hold: () => {},
});

function snapshotFingerprint(
  captureLines: readonly string[],
  cursorLine: string,
  fallbackSize: { cols: number; rows: number } | null,
): string {
  const hash = createHash("sha256");
  const append = (bytes: Uint8Array): void => {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  };
  hash.update("tmux-ide/recovery-snapshot/v1\0");
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(captureLines.length);
  hash.update(count);
  for (const line of captureLines) append(Buffer.from(line, "latin1"));
  append(Buffer.from(cursorLine, "utf8"));
  append(
    Buffer.from(
      fallbackSize ? `${fallbackSize.cols}x${fallbackSize.rows}` : "no-layout-fallback",
      "ascii",
    ),
  );
  return hash.digest("hex");
}

function tmuxSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface ContinueNotificationOwner {
  readonly kind: "owner";
  readonly recovery: RecoveryRecord;
}

interface ContinueNotificationDebt {
  readonly kind: "debt";
  count: number;
  saturated: boolean;
}

type ContinueNotificationEntry = ContinueNotificationOwner | ContinueNotificationDebt;

interface WindowRecord {
  runtimeId: string;
  semanticId: string | null;
  name: string | null;
  paneBorderStatus: "top" | "bottom" | "off";
}

interface WindowSyncStage {
  readonly windows: Map<string, WindowRecord>;
  readonly layouts: Map<string, ParsedLayout & { zoomed: boolean }>;
  readonly currentWindow: string;
  readonly repairedIdentity: boolean;
}

export function defaultMirrorPaneId(): string {
  return `pane.mirror.${randomBytes(8).toString("hex")}`;
}

export function defaultMirrorWindowId(): string {
  return `window.mirror.${randomBytes(8).toString("hex")}`;
}

export class SessionChannel {
  private readonly opts: SessionChannelOptions;
  private readonly io: MirrorChannelIo;
  private readonly ledger = new FlowLedger();
  private readonly discovery: SessionDescriptorDiscovery;
  private readonly panesByRuntime = new Map<string, PaneRecord>();
  private readonly panesBySemantic = new Map<string, PaneRecord>();
  private readonly windowsByRuntime = new Map<string, WindowRecord>();
  private readonly layoutByWindow = new Map<string, ParsedLayout & { zoomed: boolean }>();
  private readonly activePaneByWindow = new Map<string, string>();
  private readonly layoutSubscribers = new Set<(event: MirrorLayoutEvent) => void>();
  private readonly layoutAuthoritySubscribers = new Set<
    (snapshot: MirrorLayoutAuthoritySnapshot) => void
  >();
  private layoutTopologyEpoch = 0;
  private readonly truthActive = new Map<string, boolean>();
  private readonly truthWindow = new Map<string, string>();
  private currentWindow = "";
  private diagnostics: MirrorDiagnostic[] = [];
  private degraded = false;
  private readonly ageByRuntime = new Map<string, number>();
  private maxAgeMs = 0;
  private geometryParticipating = false;
  private cancelSync: (() => void) | null = null;
  private lastDisplayNameSyncAtMs = 0;
  private disposed = false;
  private nativeClientProbePending = false;
  private windowAuthorityOrdinal = 0;
  private paneIncarnation = 0;
  private recoveryOrdinal = 0;
  private readonly outputOrdinals = new Map<string, number>();
  private readonly recoveries = new Map<string, RecoveryRecord>();
  private readonly continueNotificationQueues = new Map<string, ContinueNotificationEntry[]>();
  private trustedInventoryFlight: Promise<TrustedMirrorSessionInventory> | null = null;
  private trustedInventoryFlightSessionId: string | null = null;
  private attachedIdentity: { sessionName: string; runtimeSessionId: string } | null = null;
  /** Settles once the FIRST identity join lands (or is proven impossible), so
   *  `start()` returns a channel whose semantic ids are subscribable. */
  private resolveFirstJoin: (() => void) | null = null;
  private readonly firstJoin = new Promise<void>((resolve) => {
    this.resolveFirstJoin = resolve;
  });
  private readonly input = new InputCoalescer(
    (action) => {
      const startedAtMicros = action.traceIds?.length ? Math.floor(performance.now() * 1_000) : 0;
      const pendingBeforeSend = action.traceIds?.length ? (this.io.pendingCount ?? 0) : 0;
      const onReply = action.traceIds?.length
        ? (reply: { ok: boolean }) =>
            this.opts.onInputAccepted?.(action, Math.floor(performance.now() * 1_000), reply.ok)
        : undefined;
      if (action.kind === "literal") {
        this.io.send(
          `send-keys -t ${action.pane} -H ${textToHexKeys(action.text).join(" ")}`,
          onReply,
        );
      } else {
        this.io.send(`send-keys -t ${action.pane} ${action.key}`, onReply);
      }
      if (action.traceIds?.length)
        this.opts.onInputWrite?.(
          action,
          startedAtMicros,
          Math.floor(performance.now() * 1_000),
          pendingBeforeSend,
        );
    },
    (flush) => queueMicrotask(flush),
  );

  constructor(opts: SessionChannelOptions) {
    this.opts = opts;
    this.io = opts.createIo({
      onOutput: (pane, data, ageMs, timing) => this.onOutput(pane, data, ageMs, timing),
      onNotify: (name, rest) => this.onNotify(name, rest),
      onExit: () => this.onChannelExit(),
    });
    this.discovery = new SessionDescriptorDiscovery({
      query: () =>
        this.io.request(
          `list-panes -s -t "${this.opts.session}" -F "${SESSION_PANE_DESCRIPTOR_FORMAT}"`,
        ),
      onDescriptors: (descriptors, listed) => {
        void this.reconcileIdentity(descriptors, listed).catch(() => {});
      },
      onStatus: (status) => {
        if (status) {
          this.pushDiagnostic({
            code: `DESCRIPTOR_${status.status.toUpperCase()}`,
            message: status.message,
            degraded: status.degraded,
          });
          // Discovery gave up: identity will not improve on its own — let
          // start() return the (degraded) channel rather than hang.
          if (status.status === "failed") this.settleFirstJoin();
        }
      },
    });
  }

  async start(): Promise<void> {
    await this.io.start();
    await this.captureAttachedSessionIdentity();
    if (this.opts.onNativeClientActivity) {
      // tmux does not guarantee `%client-attached` is broadcast to an
      // existing control client. A format subscription is the documented,
      // event-driven observation seam; its notification only schedules the
      // coalesced list-clients proof below.
      this.io.send(`refresh-client -B '${NATIVE_CLIENT_SUBSCRIPTION}::#{session_attached}'`);
    }
    await this.syncNow();
    await this.firstJoin;
  }

  // ── Public surface (semantic ids only) ──────────────────────────────────

  describe(): MirrorSessionDescription {
    const panes = [...this.panesBySemantic.values()].map((pane) => {
      const display = resolvePaneDisplayName({
        semanticPaneId: pane.semanticId,
        configuredName: pane.descriptor?.name,
        configuredNameSource: pane.descriptor?.nameSource,
        currentCommand: pane.descriptor?.currentCommand,
        title: pane.descriptor?.title,
        paneType: pane.descriptor?.type,
      });
      return {
        semanticPaneId: pane.semanticId,
        semanticWindowId: pane.windowRuntimeId
          ? (this.windowsByRuntime.get(pane.windowRuntimeId)?.semanticId ?? null)
          : null,
        role: pane.descriptor?.role ?? null,
        paneType: pane.descriptor?.type ?? null,
        currentCommand: pane.descriptor?.currentCommand ?? null,
        cwd: pane.descriptor?.cwd ?? null,
        title: pane.descriptor?.title ?? null,
        displayName: display.name,
        displayNameSource: display.source,
        windowName: pane.descriptor?.windowName ?? null,
        active: pane.active,
      };
    });
    return {
      session: this.opts.session,
      panes,
      diagnostics: [...this.diagnostics],
      degraded: this.degraded,
    };
  }

  /**
   * Strict daemon-internal inventory from this channel's current tmux truth.
   * Unlike the background discovery path, this query awaits descriptor
   * reconciliation before projecting and rejects incomplete identity rather
   * than returning the previous descriptor snapshot.
   */
  describeTrustedInventory(
    expectedRuntimeSessionId: string,
  ): Promise<TrustedMirrorSessionInventory> {
    if (this.disposed) {
      return Promise.reject(new Error(`mirror session ${this.opts.session} is disposed`));
    }
    if (this.trustedInventoryFlight) {
      return this.trustedInventoryFlightSessionId === expectedRuntimeSessionId
        ? this.trustedInventoryFlight
        : Promise.reject(new Error(`trusted inventory identity changed for ${this.opts.session}`));
    }
    const flight = this.refreshTrustedInventory(expectedRuntimeSessionId).finally(() => {
      if (this.trustedInventoryFlight === flight) {
        this.trustedInventoryFlight = null;
        this.trustedInventoryFlightSessionId = null;
      }
    });
    this.trustedInventoryFlight = flight;
    this.trustedInventoryFlightSessionId = expectedRuntimeSessionId;
    return flight;
  }

  /** Read-only proof of the session this control client is actually attached to. */
  async attachedSessionIdentity(): Promise<{ sessionName: string; runtimeSessionId: string }> {
    if (this.disposed) throw new Error(`mirror session ${this.opts.session} is disposed`);
    if (!this.attachedIdentity)
      throw new Error(`mirror session ${this.opts.session} identity is absent`);
    return this.attachedIdentity;
  }

  private async captureAttachedSessionIdentity(): Promise<void> {
    const lines = await this.io.request(`display-message -p "#{qa:session_name}\t#{session_id}"`);
    if (lines.length !== 1)
      throw new Error(`mirror session ${this.opts.session} identity is absent`);
    const decodedLine = decodeControlReplyUtf8(lines[0]!);
    if (decodedLine === null)
      throw new Error(`mirror session ${this.opts.session} identity is malformed`);
    const [encodedName = "", runtimeSessionId = ""] = decodedLine.split("\t");
    const sessionName = decodeTmuxArgument(encodedName);
    if (
      sessionName.length === 0 ||
      sessionName.length > 160 ||
      !/^\$(?:0|[1-9][0-9]*)$/u.test(runtimeSessionId) ||
      runtimeSessionId.length > 32
    ) {
      throw new Error(`mirror session ${this.opts.session} identity is malformed`);
    }
    this.attachedIdentity = Object.freeze({ sessionName, runtimeSessionId });
  }

  subscribePane(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): PaneSubscriptionHandle {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane) {
      throw new Error(`unknown semantic pane ${semanticPaneId} in session ${this.opts.session}`);
    }
    const sub: SubRecord = {
      feed: new PaneFeed(),
      onEvent,
      onLayout: onLayout ?? null,
      pane,
      frozen: false,
      closed: false,
    };
    pane.subs.add(sub);
    // A paused pane gains an unfrozen watcher: release the park before the
    // seed so the capture reflects a flowing pane.
    const recoveryReason = this.ledger.isRequested(pane.runtimeId)
      ? "requested"
      : this.ledger.isBackpressured(pane.runtimeId)
        ? "backpressure"
        : null;
    if (recoveryReason) this.beginRecovery(pane, recoveryReason);
    else this.reseedPlain(sub);
    this.emitLayoutSnapshot(sub);
    return {
      semanticPaneId,
      freeze: () => this.freeze(sub),
      thaw: () => this.thaw(sub),
      reseed: () => this.reseedPlain(sub),
      sendText: (text) => {
        if (!sub.closed) this.input.literal(sub.pane.runtimeId, text);
      },
      sendKey: (key) => {
        if (!sub.closed) this.input.key(sub.pane.runtimeId, key);
      },
      close: () => this.closeSub(sub),
    };
  }

  /** Session geometry without a dummy pane feed or terminal-content seed. */
  subscribeLayout(onLayout: (event: MirrorLayoutEvent) => void): LayoutSubscriptionHandle {
    if (this.disposed) throw new Error(`mirror session ${this.opts.session} is disposed`);
    this.layoutSubscribers.add(onLayout);
    for (const windowRuntimeId of this.layoutByWindow.keys()) {
      const event = this.layoutEventFor(windowRuntimeId);
      if (event) onLayout(event);
    }
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.layoutSubscribers.delete(onLayout);
      },
    };
  }

  /**
   * Refresh all session/window authority before exposing a global layout
   * subscription. A cached control-mode channel may have been retained while
   * only the current window had emitted geometry; replaying that cache would
   * strand a multi-window renderer behind its exact inventory-coverage gate.
   */
  async subscribeAuthoritativeLayout(
    onLayout: (event: MirrorLayoutEvent) => void,
    expectedSemanticPaneIds?: readonly string[],
    onAuthority?: (snapshot: MirrorLayoutAuthoritySnapshot) => void,
  ): Promise<LayoutSubscriptionHandle> {
    if (this.disposed) throw new Error(`mirror session ${this.opts.session} is disposed`);
    const identity = await this.attachedSessionIdentity();
    const inventory = await this.describeTrustedInventory(identity.runtimeSessionId);
    if (this.disposed) throw new Error(`mirror session ${this.opts.session} is disposed`);

    const expectedByWindow = new Map<string, Set<string>>();
    for (const pane of inventory.panes) {
      const expected = expectedByWindow.get(pane.runtimeWindowId) ?? new Set<string>();
      expected.add(pane.semanticPaneId);
      expectedByWindow.set(pane.runtimeWindowId, expected);
    }
    if (expectedSemanticPaneIds) {
      const requested = [...expectedSemanticPaneIds].sort();
      const authoritative = inventory.panes.map(({ semanticPaneId }) => semanticPaneId).sort();
      if (
        requested.length === 0 ||
        new Set(requested).size !== requested.length ||
        requested.length !== authoritative.length ||
        requested.some((pane, index) => pane !== authoritative[index])
      ) {
        const error = new Error(`authoritative layout for ${this.opts.session} changed topology`);
        error.name = "MirrorTopologyChangedError";
        throw error;
      }
    }
    if (
      expectedByWindow.size !== inventory.panes[0]!.sessionWindowCount ||
      expectedByWindow.size !== this.windowsByRuntime.size
    ) {
      throw new Error(`authoritative layout for ${this.opts.session} has incomplete windows`);
    }
    for (const [runtimeWindowId, expectedPanes] of expectedByWindow) {
      const event = this.layoutEventFor(runtimeWindowId);
      if (!event)
        throw new Error(`authoritative layout for ${this.opts.session} has incomplete panes`);
      const observed = event.panes.flatMap(({ semanticPaneId }) =>
        typeof semanticPaneId === "string" ? [semanticPaneId] : [],
      );
      if (
        observed.length !== event.panes.length ||
        observed.length !== expectedPanes.size ||
        new Set(observed).size !== observed.length ||
        observed.some((pane) => !expectedPanes.has(pane))
      ) {
        throw new Error(`authoritative layout for ${this.opts.session} has incomplete panes`);
      }
    }
    const handle = this.subscribeLayout(onLayout);
    if (onAuthority) {
      this.layoutAuthoritySubscribers.add(onAuthority);
      this.emitLayoutAuthorityTo(onAuthority, identity.runtimeSessionId);
    }
    return {
      close: () => {
        handle.close();
        if (onAuthority) this.layoutAuthoritySubscribers.delete(onAuthority);
      },
    };
  }

  /** Controller-authorized input fast path. It deliberately reuses the one
   * session InputCoalescer, so literal/key ordering and tmux application-mode
   * named-key semantics are identical for GUI, TUI and direct subscribers. */
  sendText(
    semanticPaneId: string,
    text: string,
    performanceTraceId?: string,
    isolated = false,
  ): void {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane)
      throw new Error(`unknown semantic pane ${semanticPaneId} in session ${this.opts.session}`);
    if (isolated) this.input.flush();
    this.input.literal(pane.runtimeId, text, performanceTraceId);
    if (isolated) this.input.flush();
  }

  sendKey(semanticPaneId: string, key: string, performanceTraceId?: string): void {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane)
      throw new Error(`unknown semantic pane ${semanticPaneId} in session ${this.opts.session}`);
    this.input.key(pane.runtimeId, key, performanceTraceId);
  }

  fitViewport(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || rows < 2) {
      throw new RangeError("viewport must contain positive bounded terminal cells");
    }
    this.input.flush();
    this.io.send(`refresh-client -C ${cols}x${rows}`);
  }

  /** Toggle whether the retained control client participates in tmux sizing. */
  setGeometryParticipation(active: boolean): void {
    if (this.geometryParticipating === active) return;
    this.geometryParticipating = active;
    this.input.flush();
    this.io.send(`refresh-client -f ${active ? "!ignore-size" : "ignore-size"}`);
  }

  subscriberCount(): number {
    let count = 0;
    for (const pane of this.panesByRuntime.values()) count += pane.subs.size;
    return count;
  }

  /** Fall-behind telemetry from the `%extended-output` age field. */
  ageTelemetry(): { maxAgeMs: number; byPane: Record<string, number> } {
    const byPane: Record<string, number> = {};
    for (const [runtime, age] of this.ageByRuntime) {
      const semantic = this.panesByRuntime.get(runtime)?.semanticId;
      if (semantic) byPane[semantic] = age;
    }
    return { maxAgeMs: this.maxAgeMs, byPane };
  }

  flowSnapshot(): { backpressured: string[]; requested: string[] } {
    const toSemantic = (runtime: string): string =>
      this.panesByRuntime.get(runtime)?.semanticId ?? "(unidentified)";
    const snapshot = this.ledger.snapshot();
    return {
      backpressured: snapshot.backpressured.map(toSemantic),
      requested: snapshot.requested.map(toSemantic),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.settleFirstJoin();
    this.cancelSync?.();
    this.cancelSync = null;
    for (const runtime of [...this.recoveries.keys()]) this.cancelRecovery(runtime);
    this.continueNotificationQueues.clear();
    this.discovery.dispose();
    this.input.flush();
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.onEvent({ type: "closed" });
        }
      }
      pane.subs.clear();
    }
    this.layoutSubscribers.clear();
    this.layoutAuthoritySubscribers.clear();
    await this.io.dispose();
  }

  // ── Byte routing ─────────────────────────────────────────────────────────

  private onOutput(
    runtimePane: string,
    data: Uint8Array,
    ageMs: number | null,
    timing?: MirrorOutputTiming,
  ): void {
    const now = Date.now();
    if (now - this.lastDisplayNameSyncAtMs >= DISPLAY_NAME_SYNC_INTERVAL_MS) {
      this.lastDisplayNameSyncAtMs = now;
      this.scheduleSync();
    }
    if (ageMs !== null) {
      this.ageByRuntime.set(runtimePane, ageMs);
      if (ageMs > this.maxAgeMs) this.maxAgeMs = ageMs;
    }
    const pane = this.panesByRuntime.get(runtimePane);
    if (!pane) return;
    const outputOrdinal = (this.outputOrdinals.get(runtimePane) ?? 0) + 1;
    this.outputOrdinals.set(runtimePane, outputOrdinal);
    this.opts.onOutputObserved?.(pane.semanticId, ageMs, timing);
    let overflowed = false;
    for (const sub of pane.subs) {
      if (sub.frozen || sub.closed) continue;
      for (const event of sub.feed.delta(data)) sub.onEvent(event);
      if (sub.feed.takeOverflowed()) overflowed = true;
    }
    if (overflowed) this.restartRecoveryAfterOutputOverflow(pane);
    this.noteRecoveryOutput(pane, outputOrdinal);
  }

  // ── Seed / reseed (the atomic recipe) ────────────────────────────────────

  private reseed(
    sub: SubRecord,
    onSettled?: (result: ReseedResult) => void,
    deferPublish = false,
  ): void {
    if (sub.closed || sub.frozen || this.disposed) {
      onSettled?.(FAILED_RESEED_RESULT);
      return;
    }
    const runtime = sub.pane.runtimeId;
    const epoch = sub.feed.beginReseed();
    let settled = false;
    let captureSucceeded = false;
    let markerRetired = false;
    let captureLines: readonly string[] | null = null;
    const settle = (result: ReseedResult) => {
      if (settled) return;
      settled = true;
      onSettled?.(result);
    };
    // Keystroke ordering: pending coalesced input leaves before the probes.
    this.input.flush();
    const history = this.opts.historyLines ?? DEFAULT_HISTORY_LINES;
    const internalReadMarker = registerInternalReadOperation(runtime);
    const retireMarker = (): void => {
      if (markerRetired) return;
      markerRetired = true;
      this.retireInternalReadMarker(runtime, internalReadMarker);
    };
    // Both probes ride one write burst; the FIFO reply order is the seam.
    this.io.commandListInline(
      `set-option -p -t ${runtime} ${INTERNAL_READ_OPERATION_OPTION} ${internalReadMarker} ; capture-pane -p -e -J -S -${history} -t ${runtime}`,
      2,
      1,
      (reply) => {
        if (!reply.ok) {
          // Successful captures consume the marker atomically inside the tmux
          // after-capture-pane hook. The command-list also prevents a concurrent
          // mirror from stealing the marker. Only failures need cleanup.
          retireMarker();
          sub.feed.abort(epoch);
          settle(FAILED_RESEED_RESULT);
          return;
        }
        captureSucceeded = true;
        if (sub.closed || sub.frozen || this.disposed) {
          sub.feed.abort(epoch);
          settle(FAILED_RESEED_RESULT);
          return;
        }
        captureLines = [...reply.lines];
        sub.feed.captureReply(epoch, reply.lines);
      },
    );
    this.io.commandInline(
      `display-message -p -t ${runtime} "${RECOVERY_CURSOR_PROBE_FORMAT}"`,
      (reply) => {
        if (sub.closed || sub.frozen || this.disposed) {
          sub.feed.abort(epoch);
          settle(FAILED_RESEED_RESULT);
          return;
        }
        if (!reply.ok) {
          if (!captureSucceeded) retireMarker();
          sub.feed.abort(epoch);
          settle(FAILED_RESEED_RESULT);
          return;
        }
        const cursorLine = reply.lines[0] ?? "";
        const fallbackSize = this.layoutSizeFor(runtime);
        const events = sub.feed.cursorReply(epoch, cursorLine, fallbackSize);
        let published = false;
        const publish = (): boolean => {
          if (published) return true;
          if (sub.closed || sub.frozen || this.disposed) return false;
          published = true;
          for (const event of events) sub.onEvent(event);
          return true;
        };
        const ok = events.length > 0 && !sub.closed && captureLines !== null;
        const result = {
          ok,
          fingerprint: ok ? snapshotFingerprint(captureLines!, cursorLine, fallbackSize) : null,
          publish,
          hold: () => sub.feed.quarantine(epoch),
        } satisfies ReseedResult;
        if (!deferPublish) publish();
        settle(result);
      },
    );
  }

  private reseedPlain(sub: SubRecord, resumeReason: "requested" | null = null): void {
    this.reseed(sub, ({ ok }) => {
      if (ok) {
        if (resumeReason && !sub.closed && !sub.frozen)
          sub.onEvent({ type: "flow", state: "resumed", reason: resumeReason });
        return;
      }
      if (
        sub.closed ||
        sub.frozen ||
        this.disposed ||
        this.recoveries.has(sub.pane.runtimeId) ||
        this.panesByRuntime.get(sub.pane.runtimeId) !== sub.pane
      )
        return;
      this.beginLocalOverflowRecovery(sub.pane);
    });
  }

  private retireInternalReadMarker(runtime: string, marker: string): void {
    if (!/^%(?:0|[1-9][0-9]*)$/u.test(runtime))
      throw new TypeError("internal read cleanup requires a runtime pane id");
    retireInternalReadOperation(marker, runtime);
    // Pane capture phases overlap under cancellation. Clear only the exact
    // failed marker so a late A callback cannot erase the newer B authority.
    this.io.send(
      `if-shell -t ${runtime} -F "#{==:#{${INTERNAL_READ_OPERATION_OPTION}},${marker}}" ` +
        `"set-option -pu -t ${runtime} ${INTERNAL_READ_OPERATION_OPTION}" ""`,
    );
  }

  private layoutSizeFor(runtime: string): { cols: number; rows: number } | null {
    for (const layout of this.layoutByWindow.values()) {
      const leaf = layout.leaves.find((candidate) => candidate.id === runtime);
      if (leaf) return { cols: leaf.width, rows: leaf.height };
    }
    return null;
  }

  // ── Flow control ─────────────────────────────────────────────────────────

  private freeze(sub: SubRecord): void {
    if (sub.frozen || sub.closed) return;
    sub.frozen = true;
    sub.onEvent({ type: "flow", state: "paused", reason: "requested" });
    const pane = sub.pane;
    const allFrozen = [...pane.subs].every((candidate) => candidate.frozen || candidate.closed);
    if (allFrozen) {
      this.cancelRecovery(pane.runtimeId);
      this.ledger.requestPause(pane.runtimeId);
      this.io.send(`refresh-client -A '${pane.runtimeId}:pause'`);
    }
  }

  private thaw(sub: SubRecord): void {
    if (!sub.frozen || sub.closed) return;
    sub.frozen = false;
    const runtime = sub.pane.runtimeId;
    if (this.ledger.isRequested(runtime) || this.ledger.isBackpressured(runtime))
      this.beginRecovery(sub.pane, "requested");
    else this.reseedPlain(sub, "requested");
    this.recoverSticky();
  }

  private continuePane(runtime: string): void {
    this.io.send(`refresh-client -A '${runtime}:continue'`);
    this.ledger.noteContinued(runtime);
  }

  private scheduleRecovery(callback: () => void, delayMs: number): () => void {
    if (this.opts.scheduleRecovery) return this.opts.scheduleRecovery(callback, delayMs);
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }

  private observeRecovery(
    pane: PaneRecord,
    recovery: RecoveryRecord,
    phase: MirrorFlowRecoveryPhase,
    failureReason: MirrorFlowRecoveryFailureReason | null = null,
    fingerprintExact: boolean | null = null,
  ): void {
    const elapsedMicros = Math.min(
      RECOVERY_ABSOLUTE_DEADLINE_MS * 1_000,
      Math.max(0, Math.floor((this.recoveryNowMs() - recovery.startedAtMs) * 1_000)),
    );
    this.opts.onFlowRecoveryObserved?.(
      Object.freeze({
        semanticPaneId: pane.semanticId,
        phase,
        recoveryOrdinal: recovery.ordinal,
        paneIncarnation: recovery.paneIncarnation,
        outputOrdinal: this.outputOrdinals.get(recovery.runtimeId) ?? 0,
        failureReason,
        elapsedMicros,
        fingerprintExact,
        confirmationOrdinal: recovery.confirmationOrdinal,
        collectorStarted: recovery.collectorStarted,
        collectorLastCompletedOrdinal: recovery.collectorLastCompletedOrdinal,
        collectorCaptureLineCount: recovery.collectorCaptureLineCount,
        collectorCaptureByteCount: recovery.collectorCaptureByteCount,
        collectorContinueObserved: recovery.collectorContinueObserved,
        collectorStatusObserved: recovery.collectorStatusObserved,
        collectorObserverEmissionObserved: recovery.collectorObserverEmissionObserved,
        collectorFailureReason: recovery.collectorFailureReason,
      }),
    );
  }

  private recoveryNowMs(): number {
    return this.opts.recoveryNowMs?.() ?? performance.now();
  }

  private recoveryPane(recovery: RecoveryRecord): PaneRecord | null {
    const pane = this.panesByRuntime.get(recovery.runtimeId);
    return !this.disposed &&
      this.recoveries.get(recovery.runtimeId) === recovery &&
      pane?.incarnation === recovery.paneIncarnation
      ? !recovery.retired
        ? pane
        : null
      : null;
  }

  private cancelRecovery(runtime: string): void {
    const recovery = this.recoveries.get(runtime);
    if (!recovery) return;
    recovery.retired = true;
    recovery.cancelQuiet?.();
    recovery.cancelCommandDeadline?.();
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelAbsoluteDeadline?.();
    if (recovery.atomicCollectorNonce)
      this.io.retireAtomicPaneSnapshotCollector?.(recovery.atomicCollectorNonce, "retired");
    recovery.atomicCollectorNonce = null;
    this.recoveries.delete(runtime);
    this.retireContinueNotificationOwner(recovery);
    const pane = this.panesByRuntime.get(runtime);
    if (pane?.incarnation === recovery.paneIncarnation)
      for (const sub of pane.subs) sub.feed.abortCurrent();
  }

  private beginRecovery(pane: PaneRecord, reason: "backpressure" | "requested"): void {
    const runtime = pane.runtimeId;
    this.cancelRecovery(runtime);
    const recovery: RecoveryRecord = {
      ordinal: ++this.recoveryOrdinal,
      runtimeId: runtime,
      paneIncarnation: pane.incarnation,
      reason,
      startedAtMs: this.recoveryNowMs(),
      retired: false,
      continueReply: false,
      continueNotify: false,
      stage: "continue",
      attempts: 0,
      reseedOrdinal: 0,
      outputOrdinal: this.outputOrdinals.get(runtime) ?? 0,
      candidateFingerprint: null,
      confirmationFingerprint: null,
      confirmationOrdinal: 0,
      atomicCollectorNonce: null,
      collectorStarted: false,
      collectorLastCompletedOrdinal: -1,
      collectorCaptureLineCount: 0,
      collectorCaptureByteCount: 0,
      collectorContinueObserved: false,
      collectorStatusObserved: false,
      collectorObserverEmissionObserved: false,
      collectorFailureReason: null,
      cancelQuiet: null,
      cancelCommandDeadline: null,
      cancelNoProgressDeadline: null,
      cancelAbsoluteDeadline: null,
    };
    this.recoveries.set(runtime, recovery);
    for (const sub of pane.subs) {
      if (!sub.frozen && !sub.closed) sub.feed.abortCurrent();
    }
    this.observeRecovery(pane, recovery, "pause");
    this.observeRecovery(pane, recovery, "continue-request");
    recovery.cancelCommandDeadline = this.scheduleRecovery(() => {
      if (this.recoveryPane(recovery) && !recovery.continueReply)
        this.failRecovery(recovery, "command-timeout");
    }, RECOVERY_COMMAND_DEADLINE_MS);
    const queue = this.continueNotificationQueues.get(runtime) ?? [];
    if (queue.length >= MAX_CONTINUE_NOTIFICATION_QUEUE) {
      this.failRecovery(recovery, "notification-queue-overflow");
      return;
    }
    queue.push({ kind: "owner", recovery });
    this.continueNotificationQueues.set(runtime, queue);
    this.io.send(`refresh-client -A '${runtime}:continue'`, (reply) => {
      const current = this.recoveryPane(recovery);
      if (!reply.ok) {
        this.removeContinueNotificationOwner(recovery);
        if (current) this.failRecovery(recovery, "command-error");
        return;
      }
      recovery.continueReply = true;
      if (!current) {
        this.retireContinueNotificationOwner(recovery);
        return;
      }
      recovery.cancelCommandDeadline?.();
      recovery.cancelCommandDeadline = null;
      this.beginRecoveryConvergence(recovery);
      this.observeRecovery(current, recovery, "continue-reply");
      this.noteRecoveryProgress(recovery);
      this.beginFinalRecovery(recovery);
    });
  }

  private beginLocalOverflowRecovery(pane: PaneRecord): void {
    const runtime = pane.runtimeId;
    this.cancelRecovery(runtime);
    const recovery: RecoveryRecord = {
      ordinal: ++this.recoveryOrdinal,
      runtimeId: runtime,
      paneIncarnation: pane.incarnation,
      reason: "backpressure",
      startedAtMs: this.recoveryNowMs(),
      retired: false,
      continueReply: true,
      continueNotify: true,
      stage: "continue",
      attempts: 0,
      reseedOrdinal: 0,
      outputOrdinal: this.outputOrdinals.get(runtime) ?? 0,
      candidateFingerprint: null,
      confirmationFingerprint: null,
      confirmationOrdinal: 0,
      atomicCollectorNonce: null,
      collectorStarted: false,
      collectorLastCompletedOrdinal: -1,
      collectorCaptureLineCount: 0,
      collectorCaptureByteCount: 0,
      collectorContinueObserved: false,
      collectorStatusObserved: false,
      collectorObserverEmissionObserved: false,
      collectorFailureReason: null,
      cancelQuiet: null,
      cancelCommandDeadline: null,
      cancelNoProgressDeadline: null,
      cancelAbsoluteDeadline: null,
    };
    this.recoveries.set(runtime, recovery);
    for (const sub of pane.subs) {
      if (!sub.frozen && !sub.closed)
        sub.onEvent({ type: "flow", state: "paused", reason: "backpressure" });
    }
    this.observeRecovery(pane, recovery, "pause");
    this.beginRecoveryConvergence(recovery);
    this.beginFinalRecovery(recovery);
  }

  private beginRecoveryConvergence(recovery: RecoveryRecord): void {
    if (recovery.cancelAbsoluteDeadline) return;
    recovery.cancelAbsoluteDeadline = this.scheduleRecovery(() => {
      if (this.recoveryPane(recovery)) this.failRecovery(recovery, "absolute-deadline");
    }, RECOVERY_ABSOLUTE_DEADLINE_MS);
    this.noteRecoveryProgress(recovery);
  }

  private noteRecoveryProgress(recovery: RecoveryRecord): void {
    if (!this.recoveryPane(recovery) || !recovery.cancelAbsoluteDeadline) return;
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelNoProgressDeadline = this.scheduleRecovery(() => {
      if (this.recoveryPane(recovery)) this.failRecovery(recovery, "no-progress");
    }, RECOVERY_NO_PROGRESS_DEADLINE_MS);
  }

  private noteAtomicCollectorProgress(
    recovery: RecoveryRecord,
    nonce: string,
    progress: AtomicPaneSnapshotProgress,
  ): void {
    if (
      this.recoveryPane(recovery) === null ||
      recovery.atomicCollectorNonce !== nonce ||
      !progress.started
    )
      return;
    recovery.collectorStarted = true;
    recovery.collectorLastCompletedOrdinal = Math.max(
      recovery.collectorLastCompletedOrdinal,
      progress.lastCompletedOrdinal,
    );
    recovery.collectorCaptureLineCount = Math.max(
      recovery.collectorCaptureLineCount,
      progress.captureLineCount,
    );
    recovery.collectorCaptureByteCount = Math.max(
      recovery.collectorCaptureByteCount,
      progress.captureByteCount,
    );
    recovery.collectorContinueObserved ||= progress.continueObserved;
    recovery.collectorStatusObserved ||= progress.statusObserved;
    recovery.collectorObserverEmissionObserved ||= progress.observerEmissionObserved;
    this.noteRecoveryProgress(recovery);
  }

  private reseedRecoverySubscribers(
    pane: PaneRecord,
    recovery: RecoveryRecord,
    done: (result: ReseedResult) => void,
    deferPublish = false,
  ): void {
    if (this.io.armAtomicPaneSnapshotCollector && this.io.retireAtomicPaneSnapshotCollector) {
      this.reseedRecoverySubscribersAtomic(pane, recovery, done, deferPublish);
      return;
    }
    const live = [...pane.subs].filter((sub) => !sub.frozen && !sub.closed);
    if (live.length === 0) {
      done(FAILED_RESEED_RESULT);
      return;
    }
    const participants = live.map((sub) => Object.freeze({ sub, epoch: sub.feed.beginReseed() }));
    const reseedOrdinal = ++recovery.reseedOrdinal;
    let settled = false;
    let captureSucceeded = false;
    let markerRetired = false;
    let captureLines: readonly string[] | null = null;
    // One pane authority capture is enough for every subscriber. Per-feed
    // epochs still independently fence delivery, while membership is frozen
    // across both FIFO replies so no subscriber can join half a snapshot.
    this.input.flush();
    const history = this.opts.historyLines ?? DEFAULT_HISTORY_LINES;
    const internalReadMarker = registerInternalReadOperation(pane.runtimeId);
    const participantsExact = (): boolean => {
      if (
        this.recoveryPane(recovery) !== pane ||
        recovery.reseedOrdinal !== reseedOrdinal ||
        participants.some(
          ({ sub }) => sub.closed || sub.frozen || sub.pane !== pane || !pane.subs.has(sub),
        )
      )
        return false;
      const current = [...pane.subs].filter((sub) => !sub.frozen && !sub.closed);
      return (
        current.length === participants.length &&
        current.every((sub) => participants.some((participant) => participant.sub === sub))
      );
    };
    const retireMarker = (): void => {
      if (markerRetired) return;
      markerRetired = true;
      this.retireInternalReadMarker(pane.runtimeId, internalReadMarker);
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      if (!captureSucceeded) retireMarker();
      for (const { sub } of participants) sub.feed.abortCurrent();
      done(FAILED_RESEED_RESULT);
    };
    this.io.commandListInline(
      `set-option -p -t ${pane.runtimeId} ${INTERNAL_READ_OPERATION_OPTION} ${internalReadMarker} ; capture-pane -p -e -J -S -${history} -t ${pane.runtimeId}`,
      2,
      1,
      (reply) => {
        if (!reply.ok) {
          fail();
          return;
        }
        captureSucceeded = true;
        if (!participantsExact()) {
          fail();
          return;
        }
        captureLines = Object.freeze([...reply.lines]);
        for (const { sub, epoch } of participants) sub.feed.captureReply(epoch, captureLines);
      },
    );
    this.io.commandInline(
      `display-message -p -t ${pane.runtimeId} "${RECOVERY_CURSOR_PROBE_FORMAT}"`,
      (reply) => {
        if (settled) return;
        if (!participantsExact() || captureLines === null || !reply.ok) {
          fail();
          return;
        }
        const cursorLine = reply.lines[0] ?? "";
        const fallbackSize = this.layoutSizeFor(pane.runtimeId);
        const deliveries = participants.map(({ sub, epoch }) => ({
          sub,
          epoch,
          events: sub.feed.cursorReply(epoch, cursorLine, fallbackSize),
        }));
        if (!participantsExact() || deliveries.some(({ events }) => events.length === 0)) {
          fail();
          return;
        }
        let published = false;
        const publish = (): boolean => {
          if (published) return true;
          if (!participantsExact()) return false;
          published = true;
          for (const { sub, events } of deliveries) for (const event of events) sub.onEvent(event);
          return participantsExact();
        };
        if (!deferPublish && !publish()) {
          fail();
          return;
        }
        for (const { sub, epoch } of deliveries) sub.feed.quarantine(epoch);
        settled = true;
        done({
          ok: true,
          fingerprint: snapshotFingerprint(captureLines, cursorLine, fallbackSize),
          publish,
          hold: () => {},
        });
      },
    );
  }

  private reseedRecoverySubscribersAtomic(
    pane: PaneRecord,
    recovery: RecoveryRecord,
    done: (result: ReseedResult) => void,
    deferPublish: boolean,
  ): void {
    const live = [...pane.subs].filter((sub) => !sub.frozen && !sub.closed);
    if (live.length === 0) {
      done(FAILED_RESEED_RESULT);
      return;
    }
    const participants = live.map((sub) => Object.freeze({ sub, epoch: sub.feed.beginReseed() }));
    const reseedOrdinal = ++recovery.reseedOrdinal;
    const nonce = this.opts.generateAtomicHookNonce?.() ?? randomBytes(24).toString("hex");
    if (!/^[0-9a-f]{32,128}$/u.test(nonce)) {
      for (const { sub } of participants) sub.feed.abortCurrent();
      done(FAILED_RESEED_RESULT);
      return;
    }
    const hookName = `@tmux_ide_atomic_${nonce}`;
    const expectedName = `@tmux_ide_atomic_expected_${nonce}`;
    const ownerName = `@tmux_ide_atomic_owner_${nonce}`;
    const internalReadMarker = registerInternalReadOperation(pane.runtimeId);
    recovery.atomicCollectorNonce = nonce;
    recovery.collectorStarted = false;
    recovery.collectorLastCompletedOrdinal = -1;
    recovery.collectorCaptureLineCount = 0;
    recovery.collectorCaptureByteCount = 0;
    recovery.collectorContinueObserved = false;
    recovery.collectorStatusObserved = false;
    recovery.collectorObserverEmissionObserved = false;
    recovery.collectorFailureReason = null;
    const participantsExact = (): boolean => {
      if (
        this.recoveryPane(recovery) !== pane ||
        recovery.reseedOrdinal !== reseedOrdinal ||
        participants.some(
          ({ sub }) => sub.closed || sub.frozen || sub.pane !== pane || !pane.subs.has(sub),
        )
      )
        return false;
      const current = [...pane.subs].filter((sub) => !sub.frozen && !sub.closed);
      return (
        current.length === participants.length &&
        current.every((sub) => participants.some((participant) => participant.sub === sub))
      );
    };
    let settled = false;
    let observerEmitted = false;
    const hookOwned = `#{==:#{${ownerName}},${nonce}}`;
    const hookUnchanged = `#{==:#{${hookName}},#{${expectedName}}}`;
    const cleanupHook = (): void => {
      this.io.commandListInline(
        `if-shell -t ${pane.runtimeId} -F "#{&&:${hookOwned},${hookUnchanged}}" ` +
          `${tmuxSingleQuote(`set-option -pu -t ${pane.runtimeId} ${hookName}`)} ` +
          tmuxSingleQuote(
            `display-message -p -t ${pane.runtimeId} tmux-ide-atomic-cleanup-hook-skip-v1:${nonce}`,
          ),
        2,
        1,
        () => {},
      );
      this.io.commandListInline(
        `if-shell -t ${pane.runtimeId} -F "${hookOwned}" ` +
          tmuxSingleQuote(`set-option -pu -t ${pane.runtimeId} ${expectedName}`) +
          ` ${tmuxSingleQuote(
            `display-message -p -t ${pane.runtimeId} tmux-ide-atomic-cleanup-expected-skip-v1:${nonce}`,
          )}`,
        2,
        1,
        () => {},
      );
      this.io.commandListInline(
        `if-shell -t ${pane.runtimeId} -F "${hookOwned}" ` +
          tmuxSingleQuote(`set-option -pu -t ${pane.runtimeId} ${ownerName}`) +
          ` ${tmuxSingleQuote(
            `display-message -p -t ${pane.runtimeId} tmux-ide-atomic-cleanup-owner-skip-v1:${nonce}`,
          )}`,
        2,
        1,
        () => {},
      );
    };
    const fail = (statusObserved = false): void => {
      if (settled) return;
      settled = true;
      if (recovery.atomicCollectorNonce === nonce) recovery.atomicCollectorNonce = null;
      cleanupHook();
      if (!statusObserved && !observerEmitted)
        this.retireInternalReadMarker(pane.runtimeId, internalReadMarker);
      for (const { sub } of participants) sub.feed.abortCurrent();
      done(FAILED_RESEED_RESULT);
    };
    let observer: {
      readonly bufferName: string;
      readonly signalChannel: string;
      readonly record: string;
    } | null;
    try {
      observer = this.opts.internalReadHookEmission?.(pane.runtimeId, internalReadMarker) ?? null;
    } catch {
      fail();
      return;
    }
    const safeObserver =
      observer !== null &&
      /^[A-Za-z0-9._-]{1,256}$/u.test(observer.bufferName) &&
      /^[A-Za-z0-9._-]{1,256}$/u.test(observer.signalChannel) &&
      /^[A-Za-z0-9%:._|-]{1,1024}$/u.test(observer.record);
    if (!safeObserver) {
      fail();
      return;
    }
    const sentinel = (kind: string): string =>
      `display-message -p -t ${pane.runtimeId} ` + `"%tmux-ide-atomic-v1 ${nonce} ${kind}"`;
    const observerCommands =
      ` ; set-buffer -a -b ${observer!.bufferName} ${observer!.record}` +
      ` ; wait-for -S ${observer!.signalChannel}`;
    const body =
      `set-option -po -t ${pane.runtimeId} ${INTERNAL_READ_OPERATION_OPTION} ${internalReadMarker}` +
      ` ; ${sentinel("start")}` +
      ` ; capture-pane -p -e -J -S -${this.opts.historyLines ?? DEFAULT_HISTORY_LINES} -t ${pane.runtimeId}` +
      ` ; ${sentinel("capture-end")}` +
      ` ; display-message -p -t ${pane.runtimeId} "${RECOVERY_CURSOR_PROBE_FORMAT}"` +
      ` ; ${sentinel("cursor-end")}` +
      ` ; refresh-client -A ${pane.runtimeId}:continue` +
      observerCommands +
      ` ; if-shell -t ${pane.runtimeId} -F ` +
      `"#{==:#{${INTERNAL_READ_OPERATION_OPTION}},${internalReadMarker}}" ` +
      tmuxSingleQuote(`set-option -pu -t ${pane.runtimeId} ${INTERNAL_READ_OPERATION_OPTION}`) +
      ` ${tmuxSingleQuote(`${sentinel("marker-rejected")}`)}` +
      ` ; ${sentinel("status-ok")}` +
      ` ; set-option -pu -t ${pane.runtimeId} ${hookName}` +
      ` ; ${sentinel("complete")}`;
    this.input.flush();
    const invoke = (reply: { ok: boolean }): void => {
      if (!reply.ok || !participantsExact()) {
        fail();
        return;
      }
      const remaining = Math.floor(
        RECOVERY_ABSOLUTE_DEADLINE_MS - (this.recoveryNowMs() - recovery.startedAtMs),
      );
      if (remaining <= 0) {
        fail();
        return;
      }
      const armed = this.io.armAtomicPaneSnapshotCollector!(
        {
          nonce,
          runtimePaneId: pane.runtimeId,
          maxCaptureBytes: RECOVERY_CAPTURE_MAX_BYTES,
          maxCaptureLines: RECOVERY_CAPTURE_MAX_LINES,
          maxCursorBytes: RECOVERY_CURSOR_MAX_BYTES,
          observerCommandCount: 2,
          onProgress: (progress) => this.noteAtomicCollectorProgress(recovery, nonce, progress),
          onSettled: (result: AtomicPaneSnapshotResult) => {
            if (recovery.atomicCollectorNonce === nonce) recovery.atomicCollectorNonce = null;
            recovery.collectorStarted ||= result.started;
            recovery.collectorLastCompletedOrdinal = Math.max(
              recovery.collectorLastCompletedOrdinal,
              result.lastCompletedOrdinal,
            );
            recovery.collectorCaptureLineCount = Math.max(
              recovery.collectorCaptureLineCount,
              result.captureLineCount,
            );
            recovery.collectorCaptureByteCount = Math.max(
              recovery.collectorCaptureByteCount,
              result.captureByteCount,
            );
            recovery.collectorContinueObserved ||= result.continueObserved;
            recovery.collectorStatusObserved ||= result.statusObserved;
            recovery.collectorObserverEmissionObserved ||= result.observerEmissionObserved;
            recovery.collectorFailureReason = result.failureReason;
            observerEmitted = result.observerEmissionObserved && safeObserver;
            cleanupHook();
            if (settled) return;
            if (!result.ok || !participantsExact() || result.cursorLine === null) {
              fail(result.statusObserved);
              return;
            }
            const captureLines = Object.freeze([...result.captureLines]);
            for (const { sub, epoch } of participants) sub.feed.captureReply(epoch, captureLines);
            const fallbackSize = this.layoutSizeFor(pane.runtimeId);
            const deliveries = participants.map(({ sub, epoch }) => ({
              sub,
              epoch,
              events: sub.feed.cursorReply(epoch, result.cursorLine!, fallbackSize),
            }));
            if (!participantsExact() || deliveries.some(({ events }) => events.length === 0)) {
              fail(true);
              return;
            }
            let published = false;
            const publish = (): boolean => {
              if (published) return true;
              if (!participantsExact()) return false;
              published = true;
              for (const { sub, events } of deliveries)
                for (const event of events) sub.onEvent(event);
              return participantsExact();
            };
            if (!deferPublish && !publish()) {
              fail(true);
              return;
            }
            for (const { sub, epoch } of deliveries) sub.feed.quarantine(epoch);
            settled = true;
            done({
              ok: true,
              fingerprint: snapshotFingerprint(captureLines, result.cursorLine, fallbackSize),
              publish,
              hold: () => {},
            });
          },
        },
        remaining,
      );
      if (!armed) {
        fail();
        return;
      }
      const rejected = `tmux-ide-atomic-invoke-rejected-v1:${nonce}`;
      this.io.commandListInline(
        `if-shell -t ${pane.runtimeId} -F "#{&&:${hookOwned},${hookUnchanged}}" ` +
          `${tmuxSingleQuote(`set-hook -Rp -t ${pane.runtimeId} ${hookName}`)} ` +
          tmuxSingleQuote(`display-message -p -t ${pane.runtimeId} ${rejected}`),
        2,
        1,
        (hookReply) => {
          if (!hookReply.ok || hookReply.lines.length > 0) {
            this.io.retireAtomicPaneSnapshotCollector?.(nonce, "retired");
            fail();
          }
        },
      );
    };
    // Three owner-local create-only writes avoid a command-group partial-error
    // ambiguity: every accepted step has its own ordered reply and any later
    // failure can conditionally retire exactly the already-created prefix.
    this.io.commandInline(
      `set-option -po -t ${pane.runtimeId} ${ownerName} ${nonce}`,
      (ownerReply) => {
        if (!ownerReply.ok || !participantsExact()) {
          fail();
          return;
        }
        this.io.commandInline(
          `set-option -po -t ${pane.runtimeId} ${expectedName} ${tmuxSingleQuote(body)}`,
          (expectedReply) => {
            if (!expectedReply.ok || !participantsExact()) {
              fail();
              return;
            }
            this.io.commandInline(
              `set-option -po -t ${pane.runtimeId} ${hookName} ${tmuxSingleQuote(body)}`,
              invoke,
            );
          },
        );
      },
    );
  }

  private armRecoveryQuiet(recovery: RecoveryRecord, callback: () => void): void {
    recovery.cancelQuiet?.();
    recovery.cancelQuiet = this.scheduleRecovery(() => {
      recovery.cancelQuiet = null;
      if (this.recoveryPane(recovery)) callback();
    }, RECOVERY_QUIET_MS);
  }

  private beginFinalRecovery(recovery: RecoveryRecord): void {
    const pane = this.recoveryPane(recovery);
    if (!pane) return;
    if (recovery.attempts >= RECOVERY_MAX_ATTEMPTS) {
      this.failRecovery(recovery, "attempts-exhausted");
      return;
    }
    recovery.attempts += 1;
    recovery.stage = "final";
    this.noteRecoveryProgress(recovery);
    // The final read is only a private candidate. Publishing it here can put
    // expensive replica projection ahead of the confirmation timers and, more
    // importantly, exposes a snapshot that has not yet survived the two-read
    // authority proof.
    this.reseedRecoverySubscribers(
      pane,
      recovery,
      ({ ok, fingerprint }) => {
        const current = this.recoveryPane(recovery);
        if (!current) return;
        if (!ok || fingerprint === null) {
          this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
          return;
        }
        recovery.outputOrdinal = this.outputOrdinals.get(recovery.runtimeId) ?? 0;
        recovery.candidateFingerprint = fingerprint;
        recovery.confirmationFingerprint = null;
        recovery.confirmationOrdinal = 0;
        recovery.stage = "confirm";
        this.observeRecovery(current, recovery, "final-reseed");
        this.noteRecoveryProgress(recovery);
        this.armRecoveryQuiet(recovery, () => this.confirmRecovery(recovery));
      },
      true,
    );
  }

  private confirmRecovery(recovery: RecoveryRecord): void {
    const pane = this.recoveryPane(recovery);
    if (!pane) return;
    if ((this.outputOrdinals.get(recovery.runtimeId) ?? 0) !== recovery.outputOrdinal) {
      this.beginFinalRecovery(recovery);
      return;
    }
    recovery.stage = "final";
    this.noteRecoveryProgress(recovery);
    this.reseedRecoverySubscribers(
      pane,
      recovery,
      ({ ok, fingerprint, publish }) => {
        const current = this.recoveryPane(recovery);
        if (!current) return;
        if (!ok || fingerprint === null) {
          this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
          return;
        }
        const outputOrdinal = this.outputOrdinals.get(recovery.runtimeId) ?? 0;
        const ordinalExact = outputOrdinal === recovery.outputOrdinal;
        const candidateExact = ordinalExact && fingerprint === recovery.candidateFingerprint;
        const consecutiveExact =
          candidateExact &&
          recovery.confirmationFingerprint !== null &&
          fingerprint === recovery.confirmationFingerprint;
        recovery.confirmationOrdinal += 1;
        this.observeRecovery(current, recovery, "confirmation-reseed", null, consecutiveExact);
        this.noteRecoveryProgress(recovery);
        if (!ordinalExact) {
          recovery.stage = "confirm";
          this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
          return;
        }
        if (!candidateExact) {
          if (recovery.attempts >= RECOVERY_MAX_ATTEMPTS) {
            this.failRecovery(recovery, "attempts-exhausted");
            return;
          }
          // A changed confirmation replaces the private candidate without
          // becoming observable. Two subsequent reads must confirm this truth.
          recovery.attempts += 1;
          recovery.candidateFingerprint = fingerprint;
          recovery.confirmationFingerprint = null;
          recovery.outputOrdinal = outputOrdinal;
          recovery.stage = "confirm";
          this.armRecoveryQuiet(recovery, () => this.confirmRecovery(recovery));
          return;
        }
        if (!consecutiveExact) {
          recovery.confirmationFingerprint = fingerprint;
          recovery.outputOrdinal = outputOrdinal;
          recovery.stage = "confirm";
          this.armRecoveryQuiet(recovery, () => this.confirmRecovery(recovery));
          return;
        }
        // This publisher belongs to the current second matching read, not the
        // older candidate. Publish exactly once while every participant is
        // still fenced, then synchronously retire recovery before downstream
        // projection work can run.
        if (!publish()) {
          recovery.stage = "confirm";
          this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
          return;
        }
        this.convergeRecovery(current, recovery);
      },
      true,
    );
  }

  private convergeRecovery(pane: PaneRecord, recovery: RecoveryRecord): void {
    recovery.cancelCommandDeadline?.();
    recovery.cancelCommandDeadline = null;
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelNoProgressDeadline = null;
    recovery.cancelAbsoluteDeadline?.();
    recovery.cancelAbsoluteDeadline = null;
    this.recoveries.delete(recovery.runtimeId);
    recovery.retired = true;
    this.retireContinueNotificationOwner(recovery);
    this.ledger.noteContinued(recovery.runtimeId);
    if (recovery.reason === "requested") this.ledger.clearRequest(recovery.runtimeId);
    for (const sub of pane.subs) {
      if (!sub.frozen && !sub.closed) {
        sub.feed.releaseQuarantine();
        sub.onEvent({ type: "flow", state: "resumed", reason: recovery.reason });
      }
    }
    this.observeRecovery(pane, recovery, "converged", null, true);
  }

  private noteRecoveryOutput(pane: PaneRecord, outputOrdinal: number): void {
    const recovery = this.recoveries.get(pane.runtimeId);
    if (!recovery || recovery.paneIncarnation !== pane.incarnation) return;
    recovery.outputOrdinal = outputOrdinal;
    if (recovery.continueReply) this.noteRecoveryProgress(recovery);
    if (recovery.stage === "quiet")
      this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
    else if (recovery.stage === "confirm")
      this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
  }

  private restartRecoveryAfterOutputOverflow(pane: PaneRecord): void {
    const recovery = this.recoveries.get(pane.runtimeId);
    if (recovery?.paneIncarnation === pane.incarnation) {
      if (recovery.stage === "quiet" || recovery.stage === "confirm")
        this.armRecoveryQuiet(recovery, () => this.beginFinalRecovery(recovery));
      return;
    }
    this.beginLocalOverflowRecovery(pane);
  }

  private failRecovery(
    recovery: RecoveryRecord,
    failureReason: MirrorFlowRecoveryFailureReason,
  ): void {
    const pane = this.recoveryPane(recovery);
    if (!pane) return;
    recovery.cancelQuiet?.();
    recovery.cancelQuiet = null;
    recovery.cancelCommandDeadline?.();
    recovery.cancelCommandDeadline = null;
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelNoProgressDeadline = null;
    recovery.cancelAbsoluteDeadline?.();
    recovery.cancelAbsoluteDeadline = null;
    recovery.retired = true;
    const collectorNonce = recovery.atomicCollectorNonce;
    recovery.atomicCollectorNonce = null;
    if (collectorNonce) this.io.retireAtomicPaneSnapshotCollector?.(collectorNonce, "retired");
    this.recoveries.delete(recovery.runtimeId);
    this.retireContinueNotificationOwner(recovery);
    for (const sub of pane.subs) sub.feed.abortCurrent();
    this.observeRecovery(pane, recovery, "nonconverged", failureReason);
  }

  private removeContinueNotificationOwner(recovery: RecoveryRecord): void {
    const queue = this.continueNotificationQueues.get(recovery.runtimeId);
    if (!queue) return;
    const index = queue.findIndex((entry) => entry.kind === "owner" && entry.recovery === recovery);
    if (index < 0) return;
    queue.splice(index, 1);
    this.compactContinueNotificationQueue(recovery.runtimeId, queue);
  }

  private retireContinueNotificationOwner(recovery: RecoveryRecord): void {
    if (!recovery.continueReply) return;
    const queue = this.continueNotificationQueues.get(recovery.runtimeId);
    if (!queue) return;
    const index = queue.findIndex((entry) => entry.kind === "owner" && entry.recovery === recovery);
    if (index < 0) return;
    queue.splice(index, 1, { kind: "debt", count: 1, saturated: false });
    this.compactContinueNotificationQueue(recovery.runtimeId, queue);
  }

  private compactContinueNotificationQueue(
    runtime: string,
    queue: ContinueNotificationEntry[],
  ): void {
    for (let index = 1; index < queue.length; ) {
      const previous = queue[index - 1];
      const current = queue[index];
      if (previous?.kind !== "debt" || current?.kind !== "debt") {
        index += 1;
        continue;
      }
      const total = previous.count + current.count;
      previous.count = Math.min(total, MAX_CONTINUE_NOTIFICATION_DEBT);
      previous.saturated =
        previous.saturated || current.saturated || total > MAX_CONTINUE_NOTIFICATION_DEBT;
      queue.splice(index, 1);
    }
    if (queue.length === 0) this.continueNotificationQueues.delete(runtime);
    else this.continueNotificationQueues.set(runtime, queue);
  }

  /** Continue + reseed EVERY backpressure-paused pane that still has an
   *  unfrozen subscriber. %pause is sticky and hits quiet panes after any
   *  stall — recovering only the noisy pane leaves siblings dark. */
  private recoverSticky(): void {
    for (const runtime of this.ledger.stickyRecoverySet()) {
      if (this.recoveries.has(runtime)) continue;
      const pane = this.panesByRuntime.get(runtime);
      const live = pane ? [...pane.subs].filter((sub) => !sub.frozen && !sub.closed) : [];
      if (live.length === 0) continue; // nobody watching: staying paused is free
      this.beginRecovery(pane!, "backpressure");
    }
  }

  private closeSub(sub: SubRecord): void {
    if (sub.closed) return;
    sub.closed = true;
    const pane = sub.pane;
    pane.subs.delete(sub);
    if ([...pane.subs].every((candidate) => candidate.closed || candidate.frozen))
      this.cancelRecovery(pane.runtimeId);
    // Ticket return on departure: a pane parked by a now-gone subscriber must
    // not stay paused forever.
    if (pane.subs.size === 0 && this.ledger.isRequested(pane.runtimeId)) {
      this.ledger.clearRequest(pane.runtimeId);
      this.continuePane(pane.runtimeId);
    }
  }

  // ── Notifications (channel order is the invariant) ──────────────────────

  private onNotify(name: string, rest: string): void {
    if (
      name === "layout-change" ||
      name === "window-pane-changed" ||
      name === "session-window-changed" ||
      STRUCTURAL_NOTIFICATIONS.has(name)
    ) {
      this.windowAuthorityOrdinal += 1;
    }
    // Layout changes remain a second honest wake-up: a native resize can arrive
    // before the once-per-second subscription notification. The inventory
    // (not either notification) remains the proof.
    if (
      this.opts.onNativeClientActivity &&
      (NATIVE_CLIENT_NOTIFICATIONS.has(name) || name === "layout-change")
    ) {
      this.probeNativeClientActivity();
    }
    if (name === "pause") {
      const runtime = rest.trim().split(/\s+/)[0] ?? "";
      if (!runtime.startsWith("%")) return;
      this.cancelRecovery(runtime);
      this.ledger.notePause(runtime);
      const pane = this.panesByRuntime.get(runtime);
      if (pane) {
        for (const sub of pane.subs) {
          if (!sub.frozen && !sub.closed) {
            sub.onEvent({ type: "flow", state: "paused", reason: "backpressure" });
          }
        }
      }
      this.recoverSticky();
      return;
    }
    if (name === "continue") {
      const runtime = rest.trim().split(/\s+/)[0] ?? "";
      if (runtime.startsWith("%")) {
        const queue = this.continueNotificationQueues.get(runtime);
        const entry = queue?.[0] ?? null;
        if (entry?.kind === "debt") {
          if (!entry.saturated) {
            entry.count -= 1;
            if (entry.count === 0) queue!.shift();
          }
          this.compactContinueNotificationQueue(runtime, queue!);
        } else if (entry?.kind === "owner") {
          queue!.shift();
          this.compactContinueNotificationQueue(runtime, queue!);
          const owner = entry.recovery;
          const pane = this.recoveryPane(owner);
          owner.continueNotify = true;
          if (pane) {
            this.observeRecovery(pane, owner, "continue-notify");
          }
        }
      }
      return;
    }
    if (name === "layout-change") {
      const change = parseLayoutChange(rest);
      if (!change) return;
      const parsed = parseLayout(change.visible);
      if (!parsed) {
        this.scheduleSync(); // never guess from a failed parse
        return;
      }
      this.layoutByWindow.set(change.windowId, { ...parsed, zoomed: change.zoomed });
      // Resync on BOTH structural deltas: an unknown leaf (new pane) and a
      // known pane of this window missing from the leaves (a killed pane in a
      // surviving window emits only %layout-change — without this, its
      // subscribers never receive `closed`). Closure itself still comes only
      // from the truth reply; a probe failure never reads as absence.
      const leafIds = new Set(parsed.leaves.map((leaf) => leaf.id));
      const knownPaneVanished = [...this.panesByRuntime.values()].some(
        (pane) => pane.windowRuntimeId === change.windowId && !leafIds.has(pane.runtimeId),
      );
      if (parsed.leaves.some((leaf) => !this.panesByRuntime.has(leaf.id)) || knownPaneVanished) {
        this.scheduleSync();
      }
      this.emitLayout(change.windowId);
      this.emitLayoutAuthority();
      return;
    }
    if (name === "window-pane-changed") {
      const change = parseWindowPaneChanged(rest);
      if (!change) return;
      this.activePaneByWindow.set(change.windowId, change.paneId);
      for (const pane of this.panesByRuntime.values()) {
        if (pane.windowRuntimeId === change.windowId)
          pane.active = pane.runtimeId === change.paneId;
      }
      this.emitLayout(change.windowId);
      this.emitLayoutAuthority();
      return;
    }
    if (name === "session-window-changed") {
      const change = parseSessionWindowChanged(rest);
      if (!change) return;
      const previous = this.currentWindow;
      this.currentWindow = change.windowId;
      if (previous === change.windowId) return;
      /*
       * Re-emit BOTH windows.
       *
       * `currentWindow` is carried on the layout frame, and this notification is
       * the only thing that changes it. Without a re-emit the flag stays as it
       * was until something else about a layout happens to move — so a view
       * whose window tabs come from these frames (m50) would keep marking the
       * window the user just left as the one they are in, indefinitely.
       */
      if (previous) this.emitLayout(previous);
      this.emitLayout(change.windowId);
      this.emitLayoutAuthority();
      return;
    }
    if (STRUCTURAL_NOTIFICATIONS.has(name)) this.scheduleSync();
  }

  private probeNativeClientActivity(): void {
    if (this.nativeClientProbePending || this.disposed) return;
    this.nativeClientProbePending = true;
    void this.io
      .request(
        `list-clients -t "${this.opts.session}" -F "#{client_control_mode}\t#{client_activity}"`,
      )
      .then((lines) => {
        // The daemon's own mirror is a control-mode client. Only a tmux-owned
        // attached client (control mode = 0) is honest evidence for yielding
        // geometry; notification names alone can include our own lifecycle.
        if (lines.some((line) => /^0\t\d+$/u.test(line.trim()))) {
          this.opts.onNativeClientActivity?.();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.nativeClientProbePending = false;
      });
  }

  private emitLayout(windowRuntimeId: string): void {
    const event = this.layoutEventFor(windowRuntimeId);
    if (!event) return;
    for (const subscriber of this.layoutSubscribers) subscriber(event);
    for (const pane of this.panesByRuntime.values()) {
      if (pane.windowRuntimeId !== windowRuntimeId) continue;
      for (const sub of pane.subs) {
        if (!sub.closed && sub.onLayout) sub.onLayout(event);
      }
    }
  }

  private emitLayoutAuthority(): void {
    const runtimeSessionId = this.attachedIdentity?.runtimeSessionId;
    if (!runtimeSessionId || this.layoutAuthoritySubscribers.size === 0) return;
    this.layoutTopologyEpoch += 1;
    for (const subscriber of this.layoutAuthoritySubscribers)
      this.emitLayoutAuthorityTo(subscriber, runtimeSessionId);
  }

  private emitLayoutAuthorityTo(
    subscriber: (snapshot: MirrorLayoutAuthoritySnapshot) => void,
    runtimeSessionId: string,
  ): void {
    const layouts = [...this.layoutByWindow.keys()]
      .map((runtimeId) => this.layoutEventFor(runtimeId))
      .filter((event): event is MirrorLayoutEvent => event !== null);
    subscriber({
      session: this.opts.session,
      runtimeSessionId,
      topologyEpoch: this.layoutTopologyEpoch,
      layouts,
    });
  }

  /**
   * Hand ONE new subscriber the geometry of its owning window.
   *
   * Without it a subscriber's first layout frame arrives only when a layout
   * happens to change, so a view built from these frames opens empty and stays
   * empty until the user moves something — which reads as the app failing to
   * find the session's windows at all.
   */
  private emitLayoutSnapshot(sub: SubRecord): void {
    if (!sub.onLayout) return;
    const windowRuntimeId = sub.pane.windowRuntimeId;
    if (windowRuntimeId === null) return;
    const event = this.layoutEventFor(windowRuntimeId);
    if (!sub.closed && event) sub.onLayout(event);
  }

  private layoutEventFor(windowRuntimeId: string): MirrorLayoutEvent | null {
    const layout = this.layoutByWindow.get(windowRuntimeId);
    if (!layout) return null;
    const windowRecord = this.windowsByRuntime.get(windowRuntimeId) ?? null;
    const activePane = this.activePaneByWindow.get(windowRuntimeId) ?? "";
    const event: MirrorLayoutEvent = {
      type: "layout",
      session: this.opts.session,
      semanticWindowId: windowRecord?.semanticId ?? null,
      windowName: windowRecord?.name ?? null,
      currentWindow: windowRuntimeId === this.currentWindow,
      cols: layout.width,
      rows: layout.height,
      zoomed: layout.zoomed,
      paneBorderStatus: windowRecord?.paneBorderStatus ?? "off",
      panes: layout.leaves.map((leaf) => {
        const pane = this.panesByRuntime.get(leaf.id) ?? null;
        const display = pane
          ? resolvePaneDisplayName({
              semanticPaneId: pane.semanticId,
              configuredName: pane.descriptor?.name,
              configuredNameSource: pane.descriptor?.nameSource,
              currentCommand: pane.descriptor?.currentCommand,
              title: pane.descriptor?.title,
              paneType: pane.descriptor?.type,
            })
          : null;
        return {
          semanticPaneId: pane?.semanticId ?? null,
          displayName: display?.name ?? null,
          displayNameSource: display?.source ?? null,
          left: leaf.left,
          top: leaf.top,
          width: leaf.width,
          height: leaf.height,
          active: leaf.id === activePane,
        };
      }),
    };
    return event;
  }

  // ── Truth sync + identity join ───────────────────────────────────────────

  private scheduleSync(): void {
    if (this.cancelSync || this.disposed) return;
    const schedule =
      this.opts.scheduleSync ??
      ((callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.cancelSync = schedule(() => {
      this.cancelSync = null;
      void this.syncNow().catch(() => {});
    }, SYNC_DEBOUNCE_MS);
  }

  private async syncNow(): Promise<void> {
    if (this.disposed) return;
    const lines = await this.io.request(
      `list-panes -s -t "${this.opts.session}" -F "#{pane_id}\t#{pane_active}\t#{window_id}\t#{?window_active,1,0}"`,
    );
    const truth: Array<{
      runtimePaneId: string;
      active: boolean;
      runtimeWindowId: string;
      windowActive: boolean;
    }> = [];
    for (const line of lines) {
      const [runtime = "", active = "", windowId = "", windowActive = ""] = line.split("\t");
      if (!/^%[0-9]+$/u.test(runtime)) continue;
      truth.push({
        runtimePaneId: runtime,
        active: active === "1",
        runtimeWindowId: windowId,
        windowActive: windowActive === "1",
      });
    }
    const { listed, movedWindowRuntimeIds } = this.applyPaneTruth(truth);
    await this.syncWindows(this.opts.session, movedWindowRuntimeIds);
    this.discovery.discover(listed);
  }

  private applyPaneTruth(
    truth: readonly {
      runtimePaneId: string;
      active: boolean;
      runtimeWindowId: string;
      windowActive: boolean;
    }[],
  ): { listed: Set<string>; movedWindowRuntimeIds: Set<string> } {
    const listed = new Set<string>();
    const movedWindowRuntimeIds = new Set<string>();
    this.truthActive.clear();
    this.truthWindow.clear();
    this.activePaneByWindow.clear();
    for (const row of truth) {
      listed.add(row.runtimePaneId);
      this.truthActive.set(row.runtimePaneId, row.active);
      this.truthWindow.set(row.runtimePaneId, row.runtimeWindowId);
      if (row.active) this.activePaneByWindow.set(row.runtimeWindowId, row.runtimePaneId);
      if (row.windowActive) this.currentWindow = row.runtimeWindowId;
    }
    // Closure is decided ONLY by a successful truth reply that omits the pane
    // (probe failure never reads as absence — a thrown request skips all this).
    for (const [runtime, pane] of [...this.panesByRuntime]) {
      if (listed.has(runtime)) {
        pane.active = this.truthActive.get(runtime) ?? pane.active;
        const nextWindowRuntimeId = this.truthWindow.get(runtime) ?? pane.windowRuntimeId;
        if (nextWindowRuntimeId !== pane.windowRuntimeId && nextWindowRuntimeId !== null)
          movedWindowRuntimeIds.add(nextWindowRuntimeId);
        pane.windowRuntimeId = nextWindowRuntimeId;
        continue;
      }
      this.cancelRecovery(runtime);
      this.continueNotificationQueues.delete(runtime);
      this.panesByRuntime.delete(runtime);
      this.outputOrdinals.delete(runtime);
      this.panesBySemantic.delete(pane.semanticId);
      this.ledger.forget(runtime);
      this.ageByRuntime.delete(runtime);
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.onEvent({ type: "closed" });
        }
      }
      pane.subs.clear();
    }
    return { listed, movedWindowRuntimeIds };
  }

  private async refreshTrustedInventory(
    expectedRuntimeSessionId: string,
    attempt = 0,
  ): Promise<TrustedMirrorSessionInventory> {
    const authorityOrdinal = this.windowAuthorityOrdinal;
    const beforeLines = await this.io.request(
      `list-panes -s -t "${expectedRuntimeSessionId}" -F "${SESSION_PANE_DESCRIPTOR_FORMAT}"`,
    );
    if (this.disposed) throw new Error(`mirror session ${this.opts.session} is disposed`);
    const parsed = parseSessionPaneDescriptorReply(beforeLines);
    if (
      parsed.malformedUtf8Records !== 0 ||
      parsed.descriptors.length === 0 ||
      parsed.descriptors.length !== beforeLines.length
    ) {
      throw new Error(`trusted inventory for ${this.opts.session} is malformed`);
    }
    const descriptors = parsed.descriptors;
    const runtimePaneIds = new Set(descriptors.map((pane) => pane.runtimePaneId));
    const runtimeSessionIds = new Set(descriptors.map((pane) => pane.runtimeSessionId));
    const activeWindowIds = new Set(
      descriptors.filter((pane) => pane.windowActive).map((pane) => pane.windowId),
    );
    const globallyActivePanes = descriptors.filter((pane) => pane.paneActive && pane.windowActive);
    if (
      runtimePaneIds.size !== descriptors.length ||
      runtimeSessionIds.size !== 1 ||
      runtimeSessionIds.values().next().value !== expectedRuntimeSessionId ||
      descriptors.some((pane) => pane.sessionName !== this.opts.session) ||
      descriptors.some((pane) => pane.windowId === null) ||
      activeWindowIds.size !== 1 ||
      globallyActivePanes.length !== 1
    ) {
      throw new Error(`trusted inventory for ${this.opts.session} is inconsistent`);
    }
    const computedWindowCounts = new Map<string, number>();
    for (const descriptor of descriptors) {
      const runtimeWindowId = descriptor.windowId!;
      computedWindowCounts.set(
        runtimeWindowId,
        (computedWindowCounts.get(runtimeWindowId) ?? 0) + 1,
      );
    }
    if (
      descriptors.some(
        (pane) =>
          pane.windowPaneCount !== computedWindowCounts.get(pane.windowId!) ||
          pane.sessionWindowCount !== computedWindowCounts.size,
      )
    ) {
      throw new Error(`trusted inventory for ${this.opts.session} has incomplete counts`);
    }
    const windowStage = await this.stageWindows(expectedRuntimeSessionId);
    const repairedPanes = await this.repairTrustedPaneIdentity(descriptors, windowStage.layouts);
    const afterLines = await this.io.request(
      `list-panes -s -t "${expectedRuntimeSessionId}" -F "${SESSION_PANE_DESCRIPTOR_FORMAT}"`,
    );
    const confirmedWindowStage = await this.stageWindows(expectedRuntimeSessionId);
    const coherent =
      beforeLines.length === afterLines.length &&
      beforeLines.every((line, index) => line === afterLines[index]);
    if (
      windowStage.repairedIdentity ||
      confirmedWindowStage.repairedIdentity ||
      repairedPanes ||
      !coherent ||
      !this.windowStagesEqual(windowStage, confirmedWindowStage) ||
      authorityOrdinal !== this.windowAuthorityOrdinal
    ) {
      if (attempt >= 1)
        throw new Error(`trusted inventory for ${this.opts.session} did not settle`);
      return await this.refreshTrustedInventory(expectedRuntimeSessionId, attempt + 1);
    }
    if (this.disposed) throw new Error(`mirror session ${this.opts.session} is disposed`);
    const activeWindowId = activeWindowIds.values().next().value;
    const descriptorWindowByPane = new Map(
      descriptors.map((descriptor) => [descriptor.runtimePaneId, descriptor.windowId!]),
    );
    const stagedPaneIds = new Set<string>();
    let stagedPaneCount = 0;
    let stagedPaneMembershipExact = true;
    for (const [runtimeWindowId, layout] of confirmedWindowStage.layouts) {
      if (layout.leaves.length !== computedWindowCounts.get(runtimeWindowId)) {
        stagedPaneMembershipExact = false;
        break;
      }
      for (const leaf of layout.leaves) {
        stagedPaneCount += 1;
        if (stagedPaneIds.has(leaf.id) || descriptorWindowByPane.get(leaf.id) !== runtimeWindowId) {
          stagedPaneMembershipExact = false;
          break;
        }
        stagedPaneIds.add(leaf.id);
      }
      if (!stagedPaneMembershipExact) break;
    }
    if (
      confirmedWindowStage.currentWindow !== activeWindowId ||
      confirmedWindowStage.windows.size !== computedWindowCounts.size ||
      !stagedPaneMembershipExact ||
      stagedPaneCount !== descriptors.length ||
      stagedPaneIds.size !== descriptors.length ||
      [...computedWindowCounts.keys()].some(
        (runtimeWindowId) => !confirmedWindowStage.windows.has(runtimeWindowId),
      ) ||
      descriptors.some((descriptor) => {
        const pane = this.panesByRuntime.get(descriptor.runtimePaneId);
        const window = confirmedWindowStage.windows.get(descriptor.windowId!);
        return (
          !pane ||
          !window?.semanticId ||
          descriptor.semanticPaneId !== pane.semanticId ||
          descriptor.semanticWindowId !== window.semanticId ||
          !WorkspaceIdSchemaZ.safeParse(pane.semanticId).success ||
          !WorkspaceIdSchemaZ.safeParse(window.semanticId).success
        );
      })
    ) {
      throw new Error(`trusted inventory for ${this.opts.session} lacks verified identity`);
    }
    const previousCurrentWindow = this.currentWindow;
    const { movedWindowRuntimeIds } = this.applyPaneTruth(
      descriptors.map((pane) => ({
        runtimePaneId: pane.runtimePaneId,
        active: pane.paneActive,
        runtimeWindowId: pane.windowId!,
        windowActive: pane.windowActive,
      })),
    );
    for (const descriptor of descriptors) {
      const pane = this.panesByRuntime.get(descriptor.runtimePaneId)!;
      pane.descriptor = descriptor;
      pane.active = descriptor.paneActive;
    }
    this.commitWindowStage(confirmedWindowStage, movedWindowRuntimeIds, previousCurrentWindow);
    if (
      this.degraded ||
      this.panesByRuntime.size !== descriptors.length ||
      this.windowsByRuntime.size !== computedWindowCounts.size ||
      [...computedWindowCounts.keys()].some(
        (runtimeWindowId) => !this.windowsByRuntime.has(runtimeWindowId),
      )
    ) {
      throw new Error(`trusted inventory for ${this.opts.session} is degraded`);
    }
    const windowCounts = computedWindowCounts;
    const sessionWindowCount = computedWindowCounts.size;
    const panes: TrustedMirrorPaneInventory[] = descriptors.map((descriptor) => {
      const record = this.panesByRuntime.get(descriptor.runtimePaneId);
      const runtimeWindowId = descriptor.windowId!;
      const window = this.windowsByRuntime.get(runtimeWindowId);
      if (
        !record ||
        record.windowRuntimeId !== descriptor.windowId ||
        !window?.semanticId ||
        descriptor.semanticPaneId !== record.semanticId ||
        descriptor.semanticWindowId !== window.semanticId ||
        !WorkspaceIdSchemaZ.safeParse(record.semanticId).success ||
        !WorkspaceIdSchemaZ.safeParse(window.semanticId).success
      ) {
        throw new Error(`trusted inventory for ${this.opts.session} lacks verified identity`);
      }
      return Object.freeze({
        runtimeSessionId: descriptor.runtimeSessionId,
        runtimeWindowId,
        runtimePaneId: descriptor.runtimePaneId,
        semanticWindowId: window.semanticId,
        semanticPaneId: record.semanticId,
        windowPaneCount: windowCounts.get(runtimeWindowId)!,
        sessionWindowCount,
        paneIndex: descriptor.paneIndex,
        title: descriptor.title ?? "",
        currentCommand: descriptor.currentCommand ?? "",
        active: descriptor.paneActive && descriptor.windowActive,
        role: descriptor.role,
        name: descriptor.name,
        type: descriptor.type,
        missionStamp: descriptor.missionStamp,
        dir: descriptor.cwd ?? "",
      });
    });
    return Object.freeze({
      sessionName: this.opts.session,
      runtimeSessionId: descriptors[0]!.runtimeSessionId,
      panes: Object.freeze(panes),
    });
  }

  private async syncWindows(
    target = this.opts.session,
    requiredLayoutEmits: ReadonlySet<string> = new Set(),
  ): Promise<boolean> {
    const stage = await this.stageWindows(target);
    this.commitWindowStage(stage, requiredLayoutEmits);
    return stage.repairedIdentity;
  }

  private commitWindowStage(
    stage: WindowSyncStage,
    requiredLayoutEmits: ReadonlySet<string> = new Set(),
    previousCurrentWindow = this.currentWindow,
  ): void {
    const changedWindows = new Set<string>();
    for (const [runtimeId, record] of stage.windows) {
      const previous = this.windowsByRuntime.get(runtimeId);
      const previousLayout = this.layoutByWindow.get(runtimeId);
      const nextLayout = stage.layouts.get(runtimeId)!;
      if (
        !previous ||
        previous.name !== record.name ||
        previous.semanticId !== record.semanticId ||
        previous.paneBorderStatus !== record.paneBorderStatus ||
        !previousLayout ||
        previousLayout.zoomed !== nextLayout.zoomed ||
        previousLayout.width !== nextLayout.width ||
        previousLayout.height !== nextLayout.height ||
        previousLayout.leaves.length !== nextLayout.leaves.length ||
        previousLayout.leaves.some((leaf, index) => {
          const candidate = nextLayout.leaves[index];
          return (
            !candidate ||
            leaf.id !== candidate.id ||
            leaf.left !== candidate.left ||
            leaf.top !== candidate.top ||
            leaf.width !== candidate.width ||
            leaf.height !== candidate.height
          );
        })
      ) {
        changedWindows.add(runtimeId);
      }
    }
    const windowSetChanged = stage.windows.size !== this.windowsByRuntime.size;
    if (previousCurrentWindow !== stage.currentWindow) {
      if (stage.windows.has(previousCurrentWindow)) changedWindows.add(previousCurrentWindow);
      if (stage.windows.has(stage.currentWindow)) changedWindows.add(stage.currentWindow);
    }
    this.currentWindow = stage.currentWindow;
    this.windowsByRuntime.clear();
    for (const [key, value] of stage.windows) this.windowsByRuntime.set(key, value);
    this.layoutByWindow.clear();
    for (const [key, value] of stage.layouts) this.layoutByWindow.set(key, value);
    const layoutEmits = windowSetChanged
      ? new Set(stage.windows.keys())
      : new Set(
          [...changedWindows, ...requiredLayoutEmits].filter((runtimeId) =>
            stage.windows.has(runtimeId),
          ),
        );
    for (const runtimeId of layoutEmits) this.emitLayout(runtimeId);
    this.emitLayoutAuthority();
  }

  private windowStagesEqual(left: WindowSyncStage, right: WindowSyncStage): boolean {
    if (
      left.currentWindow !== right.currentWindow ||
      left.windows.size !== right.windows.size ||
      left.layouts.size !== right.layouts.size
    ) {
      return false;
    }
    for (const [runtimeId, leftWindow] of left.windows) {
      const rightWindow = right.windows.get(runtimeId);
      const leftLayout = left.layouts.get(runtimeId);
      const rightLayout = right.layouts.get(runtimeId);
      if (
        !rightWindow ||
        !leftLayout ||
        !rightLayout ||
        leftWindow.semanticId !== rightWindow.semanticId ||
        leftWindow.name !== rightWindow.name ||
        leftWindow.paneBorderStatus !== rightWindow.paneBorderStatus ||
        leftLayout.zoomed !== rightLayout.zoomed ||
        leftLayout.width !== rightLayout.width ||
        leftLayout.height !== rightLayout.height ||
        leftLayout.leaves.length !== rightLayout.leaves.length ||
        leftLayout.leaves.some((leaf, index) => {
          const candidate = rightLayout.leaves[index];
          return (
            !candidate ||
            leaf.id !== candidate.id ||
            leaf.left !== candidate.left ||
            leaf.top !== candidate.top ||
            leaf.width !== candidate.width ||
            leaf.height !== candidate.height
          );
        })
      ) {
        return false;
      }
    }
    return true;
  }

  private async stageWindows(target = this.opts.session): Promise<WindowSyncStage> {
    const lines = await this.io.request(
      `list-windows -t "${target}" -F "#{window_id}\t#{qa:@tmux_ide_window_id}\t#{qa:window_name}\t#{window_active}\t#{window_visible_layout}\t#{?window_zoomed_flag,1,0}\t#{pane-border-status}"`,
    );
    interface Row {
      runtimeId: string;
      stamp: string | null;
      name: string | null;
      active: boolean;
      visible: string;
      zoomed: boolean;
      paneBorderStatus: "top" | "bottom" | "off";
    }
    const rows: Row[] = [];
    const seenRuntimeIds = new Set<string>();
    for (const raw of lines) {
      // Replies are latin1 byte strings; recover UTF-8 window names first.
      const line = Buffer.from(raw, "latin1").toString("utf8");
      const parts = line.split("\t");
      if (parts.length !== 7) {
        throw new Error(`window layout truth for ${this.opts.session} is malformed`);
      }
      const [
        runtimeId = "",
        stampRaw = "",
        nameRaw = "",
        active = "",
        visible = "",
        zoomed = "",
        borderStatus = "off",
      ] = parts;
      if (
        !/^@[0-9]+$/u.test(runtimeId) ||
        seenRuntimeIds.has(runtimeId) ||
        (active !== "0" && active !== "1") ||
        (zoomed !== "0" && zoomed !== "1") ||
        (borderStatus !== "top" && borderStatus !== "bottom" && borderStatus !== "off")
      ) {
        throw new Error(`window layout truth for ${this.opts.session} is malformed`);
      }
      seenRuntimeIds.add(runtimeId);
      const stamp = decodeTmuxArgument(stampRaw);
      const name = decodeTmuxArgument(nameRaw);
      rows.push({
        runtimeId,
        stamp: stamp.length > 0 ? stamp : null,
        name: name.length > 0 ? name : null,
        active: active === "1",
        visible,
        zoomed: zoomed === "1",
        paneBorderStatus: borderStatus,
      });
    }
    if (rows.length === 0) {
      throw new Error(`window layout truth for ${this.opts.session} is missing`);
    }
    const activeRows = rows.filter(({ active }) => active);
    if (activeRows.length !== 1) {
      throw new Error(
        `window layout truth for ${this.opts.session} has inconsistent active window`,
      );
    }
    const nextLayoutByWindow = new Map<string, ParsedLayout & { zoomed: boolean }>();
    for (const row of rows) {
      const parsed = parseLayout(row.visible);
      if (!parsed) {
        throw new Error(`window layout truth for ${this.opts.session} is malformed`);
      }
      nextLayoutByWindow.set(row.runtimeId, { ...parsed, zoomed: row.zoomed });
    }
    // Valid unique stamps are identity; missing/invalid/duplicated stamps are
    // ALL regenerated and stamped back (the pane policy, applied to windows).
    const stampCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.stamp && WorkspaceIdSchemaZ.safeParse(row.stamp).success) {
        stampCounts.set(row.stamp, (stampCounts.get(row.stamp) ?? 0) + 1);
      }
    }
    const claimed = new Set(stampCounts.keys());
    const generateWindowId = this.opts.generateWindowId ?? defaultMirrorWindowId;
    let repairedIdentity = false;
    const next = new Map<string, WindowRecord>();
    let nextCurrentWindow = "";
    for (const row of rows) {
      if (row.active) nextCurrentWindow = row.runtimeId;
      let semanticId: string | null = null;
      if (row.stamp && stampCounts.get(row.stamp) === 1) {
        semanticId = row.stamp;
      } else {
        repairedIdentity = true;
        let candidate: string | null = null;
        for (let attempt = 0; attempt < 32 && !candidate; attempt += 1) {
          const generated = generateWindowId();
          if (WorkspaceIdSchemaZ.safeParse(generated).success && !claimed.has(generated)) {
            candidate = generated;
          }
        }
        if (candidate) {
          claimed.add(candidate);
          const ok = await this.io
            .request(
              `set-option -w -t ${row.runtimeId} ${WORKSPACE_SEMANTIC_WINDOW_OPTION} "${candidate}"`,
            )
            .then(
              () => true,
              () => false,
            );
          if (ok) semanticId = candidate;
          else {
            this.pushDiagnostic({
              code: "WINDOW_STAMP_BACK_FAILED",
              message: `Could not stamp semantic window identity ${candidate}.`,
              degraded: true,
            });
          }
        }
      }
      next.set(row.runtimeId, {
        runtimeId: row.runtimeId,
        semanticId,
        name: row.name,
        paneBorderStatus: row.paneBorderStatus,
      });
    }
    return {
      windows: next,
      layouts: nextLayoutByWindow,
      currentWindow: nextCurrentWindow,
      repairedIdentity,
    };
  }

  private async reconcileIdentity(
    descriptors: readonly SessionPaneDescriptor[],
    listed: ReadonlySet<string>,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const snapshots: WorkspaceTmuxPaneSnapshot[] = descriptors
      .filter((descriptor) => listed.has(descriptor.runtimePaneId))
      .map((descriptor) => ({
        runtimePaneId: descriptor.runtimePaneId,
        semanticPaneId: descriptor.semanticPaneId,
        role: descriptor.role,
        type: descriptor.type,
        currentCommand: descriptor.currentCommand,
        cwd: descriptor.cwd,
        title: descriptor.title,
        rect: this.rectFor(descriptor.runtimePaneId),
        active: this.truthActive.get(descriptor.runtimePaneId) ?? false,
      }));
    const plan = planWorkspaceTmuxReconciliation({
      panes: snapshots,
      generateSemanticPaneId: this.opts.generatePaneId ?? defaultMirrorPaneId,
    });
    const outcomes: WorkspaceTmuxStampOutcome[] = await Promise.all(
      plan.stampEffects.map((effect) =>
        this.io
          .request(
            `set-option -p -t ${effect.runtimePaneId} ${WORKSPACE_SEMANTIC_PANE_OPTION} "${effect.value}"`,
          )
          .then(
            () => ({ runtimePaneId: effect.runtimePaneId, ok: true }),
            (cause: unknown) => ({
              runtimePaneId: effect.runtimePaneId,
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
      ),
    );
    if (this.disposed) return plan.stampEffects.length > 0;
    const reconciliation = finalizeWorkspaceTmuxReconciliation(plan, outcomes);
    const descriptorByRuntime = new Map(descriptors.map((d) => [d.runtimePaneId, d]));
    for (const verified of reconciliation.panes) {
      if (!listed.has(verified.runtimePaneId)) continue;
      const descriptor = descriptorByRuntime.get(verified.runtimePaneId) ?? null;
      const windowRuntimeId =
        this.truthWindow.get(verified.runtimePaneId) ?? descriptor?.windowId ?? null;
      const existingBySemantic = this.panesBySemantic.get(verified.semanticPaneId);
      const existingByRuntime = this.panesByRuntime.get(verified.runtimePaneId);
      if (existingBySemantic && existingBySemantic.runtimeId !== verified.runtimePaneId) {
        // The semantic identity moved to a different runtime address (respawn/
        // restore). Follow it and reseed every live subscriber — the old
        // address's bytes are a different pane's now.
        const retiredRuntime = existingBySemantic.runtimeId;
        this.cancelRecovery(retiredRuntime);
        this.continueNotificationQueues.delete(retiredRuntime);
        this.panesByRuntime.delete(retiredRuntime);
        this.outputOrdinals.delete(retiredRuntime);
        this.ledger.forget(retiredRuntime);
        existingBySemantic.runtimeId = verified.runtimePaneId;
        existingBySemantic.incarnation = ++this.paneIncarnation;
        existingBySemantic.descriptor = descriptor;
        existingBySemantic.active = verified.active;
        existingBySemantic.windowRuntimeId = windowRuntimeId;
        this.panesByRuntime.set(verified.runtimePaneId, existingBySemantic);
        for (const sub of existingBySemantic.subs) {
          if (!sub.closed && !sub.frozen) this.reseedPlain(sub);
        }
        continue;
      }
      if (existingByRuntime && existingByRuntime.semanticId === verified.semanticPaneId) {
        existingByRuntime.descriptor = descriptor;
        existingByRuntime.active = verified.active;
        existingByRuntime.windowRuntimeId = windowRuntimeId;
        continue;
      }
      if (existingByRuntime) {
        // The runtime address was restamped to a new identity (duplicate
        // resolution). The old semantic id is gone.
        this.panesBySemantic.delete(existingByRuntime.semanticId);
        this.cancelRecovery(existingByRuntime.runtimeId);
        this.continueNotificationQueues.delete(existingByRuntime.runtimeId);
        this.ledger.forget(existingByRuntime.runtimeId);
        this.outputOrdinals.delete(existingByRuntime.runtimeId);
        for (const sub of existingByRuntime.subs) {
          if (sub.closed) continue;
          sub.closed = true;
          sub.feed.abortCurrent();
          sub.onEvent({ type: "closed" });
        }
        existingByRuntime.subs.clear();
        existingByRuntime.incarnation = ++this.paneIncarnation;
        existingByRuntime.semanticId = verified.semanticPaneId;
        existingByRuntime.descriptor = descriptor;
        existingByRuntime.active = verified.active;
        existingByRuntime.windowRuntimeId = windowRuntimeId;
        this.panesBySemantic.set(verified.semanticPaneId, existingByRuntime);
        continue;
      }
      const record: PaneRecord = {
        runtimeId: verified.runtimePaneId,
        semanticId: verified.semanticPaneId,
        descriptor,
        active: verified.active,
        windowRuntimeId,
        subs: new Set(),
        incarnation: ++this.paneIncarnation,
      };
      this.panesByRuntime.set(record.runtimeId, record);
      this.panesBySemantic.set(record.semanticId, record);
    }
    // Diagnostics cross the semantic boundary too: rewrite runtime addresses
    // to the joined semantic id (or an honest placeholder for panes that never
    // verified) so `%N` never leaves the service.
    const semanticByRuntime = new Map(
      reconciliation.panes.map((pane) => [pane.runtimePaneId, pane.semanticPaneId]),
    );
    this.diagnostics = reconciliation.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message.replace(
        /%[0-9]+/gu,
        (runtime) => semanticByRuntime.get(runtime) ?? "(unidentified pane)",
      ),
      degraded: diagnostic.degraded,
    }));
    this.degraded = reconciliation.degraded;
    /*
     * Re-emit every window's layout now that panes carry semantic identity.
     *
     * A pane created by a split appears in the %layout-change frame BEFORE its
     * `@tmux_ide_pane_id` stamp exists, so the frame names it null — and a
     * consumer that renders semantic identities has nothing to draw for it. The
     * stamp-back lands here, in a sync, which emits no layout of its own; so
     * without this the new pane stays invisible until something else happens to
     * move a layout, and a split looks like it did not reach the view.
     */
    for (const runtimeId of this.layoutByWindow.keys()) this.emitLayout(runtimeId);
    this.emitLayoutAuthority();
    this.settleFirstJoin();
    return plan.stampEffects.length > 0;
  }

  private async repairTrustedPaneIdentity(
    descriptors: readonly SessionPaneDescriptor[],
    layouts: ReadonlyMap<string, ParsedLayout & { zoomed: boolean }>,
  ): Promise<boolean> {
    const rectForRuntime = (runtimePaneId: string): WorkspacePaneRect => {
      for (const layout of layouts.values()) {
        const leaf = layout.leaves.find(({ id }) => id === runtimePaneId);
        if (leaf) {
          return {
            left: leaf.left,
            top: leaf.top,
            width: leaf.width,
            height: leaf.height,
          };
        }
      }
      return { left: 0, top: 0, width: 1, height: 1 };
    };
    const plan = planWorkspaceTmuxReconciliation({
      panes: descriptors.map((descriptor) => ({
        runtimePaneId: descriptor.runtimePaneId,
        semanticPaneId: descriptor.semanticPaneId,
        role: descriptor.role,
        type: descriptor.type,
        currentCommand: descriptor.currentCommand,
        cwd: descriptor.cwd,
        title: descriptor.title,
        rect: rectForRuntime(descriptor.runtimePaneId),
        active: descriptor.paneActive && descriptor.windowActive,
      })),
      generateSemanticPaneId: this.opts.generatePaneId ?? defaultMirrorPaneId,
    });
    if (plan.stampEffects.length === 0) return false;
    const outcomes = await Promise.all(
      plan.stampEffects.map((effect) =>
        this.io
          .request(
            `set-option -p -t ${effect.runtimePaneId} ${WORKSPACE_SEMANTIC_PANE_OPTION} "${effect.value}"`,
          )
          .then(
            () => true,
            () => false,
          ),
      ),
    );
    if (outcomes.some((ok) => !ok)) {
      throw new Error(`trusted inventory for ${this.opts.session} could not repair identity`);
    }
    return true;
  }

  private settleFirstJoin(): void {
    this.resolveFirstJoin?.();
    this.resolveFirstJoin = null;
  }

  private rectFor(runtime: string): WorkspacePaneRect {
    for (const layout of this.layoutByWindow.values()) {
      const leaf = layout.leaves.find((candidate) => candidate.id === runtime);
      if (leaf) return { left: leaf.left, top: leaf.top, width: leaf.width, height: leaf.height };
    }
    return { left: 0, top: 0, width: 1, height: 1 };
  }

  private pushDiagnostic(diagnostic: MirrorDiagnostic): void {
    this.diagnostics = [...this.diagnostics.slice(-31), diagnostic];
    if (diagnostic.degraded) this.degraded = true;
  }

  private onChannelExit(): void {
    if (this.disposed) return;
    this.settleFirstJoin();
    for (const runtime of [...this.recoveries.keys()]) this.cancelRecovery(runtime);
    this.continueNotificationQueues.clear();
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.onEvent({ type: "closed" });
        }
      }
      pane.subs.clear();
    }
    this.opts.onExit?.();
  }
}
