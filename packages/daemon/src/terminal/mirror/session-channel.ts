import { layoutContentRows } from "./layout-content-rows.ts";
import {
  decodeNativeAtomicSnapshot,
  decodeNativeAtomicDualSnapshot,
  nativeAtomicDualSnapshotPlan,
  nativeAtomicSnapshotPlan,
  type NativeAtomicSnapshotTarget,
  type NativeAtomicSnapshotResult,
} from "./native-atomic-snapshot.ts";
import { boundedTmuxInteractionAppendCommand } from "../../lib/tmux-interaction-retention.ts";
import {
  decodeNativeGridCapture,
  isNativeBootstrapCapture,
  type NativeGridCapture,
} from "./native-grid-capture.ts";
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
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  WINDOW_LINK_MAX_LINKS,
  WORKSPACE_SEMANTIC_PANE_OPTION,
  WORKSPACE_SEMANTIC_WINDOW_OPTION,
  WorkspaceIdSchemaZ,
  type WorkspacePaneRect,
  type WindowLinkTarget,
  type WindowLinkTopology,
} from "@tmux-ide/contracts";
import { textToHexKeys } from "../protocol/control.ts";
import { InputCoalescer } from "../protocol/input-coalescer.ts";
import { NativeGridCaptureReader, type NativeGridReadResult } from "./native-grid-reader.ts";
import type { InputAction } from "../protocol/input-coalescer.ts";
import type { OwnedViewerAdapter } from "./owned-viewer-adapter.ts";
import {
  parseLayout,
  parseLayoutTree,
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
  ControlReply,
  ControlReplyLimits,
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
import { liveSessionIdForNativeIdentity } from "../protocol/live-session-identity.ts";
import { WindowLinkAuthority, WindowLinkResolutionError } from "./window-link-authority.ts";
import {
  buildNativeWindowLinkGuard,
  buildNativeWindowLinkPaneSelectGuard,
  classifyNativeWindowLinkGuardResult,
} from "../../lib/tmux-window-link-guard.ts";
import { FlowLedger } from "./flow-ledger.ts";
import { PaneFeed, captureLinesFromAnsiBytes, parseCursorProbe } from "./pane-feed.ts";
import { StockPaneSnapshot, type StockPaneSnapshotContext } from "./stock-pane-snapshot.ts";
import type {
  TrustedMirrorPaneInventory,
  TrustedMirrorSessionInventory,
} from "./trusted-inventory.ts";
import {
  INTERNAL_READ_OPERATION_OPTION,
  registerInternalReadOperation,
  retireInternalReadOperation,
} from "../../lib/tmux-interaction-options.ts";

const TMUX_SERVER_HOSTNAME = hostname();

/** Notifications whose payload cannot be applied directly — fall back to the
 *  debounced truth sync (shared by all semantic terminal clients). */
const STRUCTURAL_NOTIFICATIONS = new Set([
  "window-add",
  "window-close",
  "window-renamed",
  "unlinked-window-add",
  "unlinked-window-close",
  "session-renamed",
  "sessions-changed",
]);
const NATIVE_CLIENT_NOTIFICATIONS = new Set([
  "client-attached",
  "client-detached",
  "client-resized",
  "client-session-changed",
  "subscription-changed",
]);
const NATIVE_CLIENT_SUBSCRIPTION = "tmux-ide-native-clients";

const SYNC_DEBOUNCE_MS = 40;
/** Foreground-command labels follow output, but never turn a busy pane into a probe loop. */
const DISPLAY_NAME_SYNC_INTERVAL_MS = 750;
const RECOVERY_COMMAND_DEADLINE_MS = 500;
const RECOVERY_NO_PROGRESS_DEADLINE_MS = 3_000;
const RECOVERY_ABSOLUTE_DEADLINE_MS = 5_000;
const RECOVERY_MAX_ATTEMPTS = 4;
const MAX_QUEUED_SNAPSHOTS = 64;
const RECOVERY_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
// Budget row bookkeeping separately from wire bytes (64 bytes per retained
// line). A fixed 8192-row ceiling rejected small captures of ordinary history.
// Both the wire-byte cap and this finite allocation bound remain enforced.
const RECOVERY_CAPTURE_MAX_LINES = RECOVERY_CAPTURE_MAX_BYTES / 64;
const RECOVERY_CURSOR_MAX_BYTES = 1_024;
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
  "#{history_size}",
  "#{history_limit}",
  "#{bracket_paste_flag}",
  "#{mouse_all_flag}",
  "#{mouse_sgr_flag}",
  "#{mouse_utf8_flag}",
  "#{scroll_region_upper}",
  "#{scroll_region_lower}",
  "#{scroll-on-clear}",
]
  // Older tmux versions leave unsupported format fields empty (for example
  // bracket_paste_flag on 3.4). Preserve their slots without guessing a mode:
  // collapsing an empty field shifts every later observation to the wrong key.
  .map((field) => `#{?#{==:${field},},unknown,${field}}`)
  .join(" ");

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

/** Cache only proven server capability; malformed or failed reads can recover. */
function nativeBootstrapUnsupported(
  ok: boolean,
  lines: readonly string[],
  native: NativeGridCapture | null,
): boolean {
  if (ok)
    return native !== null && (native.version !== 2 || native.currentAttributes === undefined);
  return lines.some((line) =>
    /^(?:parse error: )?(?:command capture-pane: )?unknown flag -R$/.test(line.trim()),
  );
}

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
  onWindowMembership?: (windows: readonly string[]) => void;
  hasSharedWindowConflict?: () => boolean;
  beforeIdentityRepair?: () => Promise<void>;
  onWindowTopologyChanged?: () => void;
  ownedViewer?: Pick<OwnedViewerAdapter, "bindIo" | "tryDispatch" | "dispose"> &
    Partial<Pick<OwnedViewerAdapter, "atomicSnapshotEpoch">>;
  executeWindowLinkGuard?: (args: string[]) => Promise<{ status: number | null; stdout: string }>;
  session: string;
  createIo: (handlers: MirrorChannelHandlers) => MirrorChannelIo;
  /** Explicit capture tail override. Omitted captures all retained native history. */
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
  /** Optional diagnostic capture before dispatch; completion must not affect input. */
  captureInputWrite?: (
    action: InputAction,
    semanticPaneId: string | null,
  ) =>
    | ((
        startedAtMicros: number,
        endedAtMicros: number,
        pendingBeforeSend: number,
        paneCurrent: boolean,
      ) => void)
    | undefined;
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
  readHistorySize(): Promise<number | null>;
  captureNativeBacking(): Promise<NativeGridReadResult>;
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
  nativeBootstrap?: boolean;
  cancelCapture?: (() => void) | null;
  resumeLayoutCapture?: ((syncOrdinal?: number) => void) | null;
  readonly feed: PaneFeed;
  readonly onEvent: (event: MirrorPaneEvent) => void;
  readonly onLayout: ((event: MirrorLayoutEvent) => void) | null;
  pane: PaneRecord;
  frozen: boolean;
  closed: boolean;
}

interface PaneRecord {
  historySize?: number;
  scrollOnClear?: boolean;
  runtimeId: string;
  semanticId: string;
  descriptor: SessionPaneDescriptor | null;
  active: boolean;
  windowRuntimeId: string | null;
  readonly subs: Set<SubRecord>;
  incarnation: number;
  snapshotLayoutGeneration: number;
}

interface SnapshotLease {
  readonly recovery: RecoveryRecord;
  retired: boolean;
  retry: boolean;
  wireNonce: string | null;
  fencePending: boolean;
  cancelFence: (() => void) | null;
  cleanup?: () => void;
  ownsPause?: boolean;
}

interface RecoveryRecord {
  nativeProbeAttempts?: number;
  waitForSyncAfter?: number;
  nativeOwner?: NativeAtomicSnapshotTarget;
  lease?: SnapshotLease;
  stock?: StockPaneSnapshot;
  readonly ordinal: number;
  readonly runtimeId: string;
  readonly paneIncarnation: number;
  readonly reason: "backpressure" | "requested";
  startedAtMs: number;
  retired: boolean;
  stage:
    | "queued"
    | "stock-pause"
    | "stock-capture"
    | "native-pause"
    | "native-capture"
    | "continue"
    | "provisional"
    | "final-continue"
    | "quiet"
    | "final"
    | "confirm";
  attempts: number;
  reseedOrdinal: number;
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

// tmux concatenates adjacent quoted/unquoted fragments; doubled single quotes
// do not escape a quote. Preserve nested commands across both parser passes.
function tmuxSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface WindowRecord {
  runtimeId: string;
  semanticId: string | null;
  name: string | null;
  paneBorderStatus: "top" | "bottom" | "off";
  modeKeys?: "emacs" | "vi";
}

type WindowLayout = ParsedLayout & { zoomed: boolean; unzoomed?: ParsedLayout; rawLayout: string };

/** Daemon-internal captured observation; execution still needs native identity guards. */
export interface NativeSplitLayoutSnapshot {
  readonly sessionName: string;
  readonly sessionCreated: string;
  readonly runtimeSessionId: string;
  readonly runtimeWindowId: string;
  readonly semanticWindowId: string;
  readonly rawLayout: string;
  readonly panes: readonly {
    readonly runtimePaneId: string;
    readonly semanticPaneId: string;
    readonly nativePaneBirthId: string;
  }[];
}

function layoutIdentitiesEqual(left: WindowLayout, right: WindowLayout): boolean {
  const paneIds = (layout: ParsedLayout | undefined) => layout?.leaves.map((leaf) => leaf.id);
  return (
    left.zoomed === right.zoomed &&
    JSON.stringify(paneIds(left)) === JSON.stringify(paneIds(right)) &&
    JSON.stringify(paneIds(left.unzoomed)) === JSON.stringify(paneIds(right.unzoomed))
  );
}

interface WindowSyncStage {
  readonly observedAuthorityOrdinal: number;
  readonly windows: Map<string, WindowRecord>;
  readonly layouts: Map<string, WindowLayout>;
  readonly currentWindow: string;
  readonly repairedIdentity: boolean;
  readonly links: readonly {
    index: number;
    runtimeWindowId: string;
    semanticWindowId: string;
    active: boolean;
  }[];
}

export function defaultMirrorPaneId(): string {
  return `pane.mirror.${randomBytes(8).toString("hex")}`;
}

export function defaultMirrorWindowId(): string {
  return `window.mirror.${randomBytes(8).toString("hex")}`;
}

export class SessionChannel {
  private nativeBootstrapUnavailable = false;
  private nativeBootstrapConfirmed = false;
  private readonly opts: SessionChannelOptions;
  private readonly io: MirrorChannelIo;
  private readonly ledger = new FlowLedger();
  private readonly discovery: SessionDescriptorDiscovery;
  private readonly panesByRuntime = new Map<string, PaneRecord>();
  private readonly panesBySemantic = new Map<string, PaneRecord>();
  private readonly windowsByRuntime = new Map<string, WindowRecord>();
  private readonly layoutByWindow = new Map<string, WindowLayout>();
  private readonly activePaneByWindow = new Map<string, string>();
  private readonly layoutSubscribers = new Set<(event: MirrorLayoutEvent) => void>();
  private readonly layoutAuthoritySubscribers = new Set<
    (snapshot: MirrorLayoutAuthoritySnapshot) => void
  >();
  private layoutTopologyEpoch = 0;
  private readonly truthActive = new Map<string, boolean>();
  private readonly truthWindow = new Map<string, string>();
  private currentWindow = "";
  private windowLinkAuthority: WindowLinkAuthority | null = null;
  private latestWindowStage: WindowSyncStage | null = null;
  private attachedServerGeneration: { serverPid: string; sessionCreated: string } | null = null;
  private diagnostics: MirrorDiagnostic[] = [];
  private degraded = false;
  private readonly ageByRuntime = new Map<string, number>();
  private maxAgeMs = 0;
  private geometryParticipating = false;
  private readonly fittedWindows = new Map<string, { cols: number; rows: number }>();
  private cancelSync: (() => void) | null = null;
  private syncOrdinal = 0;
  private completedSyncOrdinal = 0;
  private lastDisplayNameSyncAtMs = 0;
  private disposed = false;
  private readonly nativeGrid: NativeGridCaptureReader;
  private nativeClientProbePending = false;
  // Native captures fence every geometry event; inventory fences identity only.
  private windowAuthorityOrdinal = 0;
  private readonly layoutNotificationOrdinals = new Map<string, number>();
  private windowIdentityOrdinal = 0;
  private paneIncarnation = 0;
  private recoveryOrdinal = 0;
  private readonly snapshotQueue = new Map<string, RecoveryRecord>();
  private snapshotActive: SnapshotLease | null = null;
  private readonly observedPaused = new Set<string>();
  private readonly outputOrdinals = new Map<string, number>();
  private readonly pendingLayoutOutput = new Map<
    string,
    {
      layout: WindowLayout;
      bytes: number;
      overflowed: boolean;
      records: Array<{
        pane: string;
        data: Uint8Array;
        ageMs: number | null;
        timing?: MirrorOutputTiming;
      }>;
    }
  >();
  private readonly recoveries = new Map<string, RecoveryRecord>();
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
      const pane = action.traceIds?.length ? this.panesByRuntime.get(action.pane) : undefined;
      const semanticPaneId = !this.disposed && pane?.descriptor ? pane.semanticId : null;
      const paneIncarnation = pane?.incarnation;
      const paneActive = pane?.active;
      const birth = pane?.descriptor?.nativePaneBirthId;
      let complete: ReturnType<NonNullable<SessionChannelOptions["captureInputWrite"]>>;
      try {
        if (action.traceIds?.length)
          complete = this.opts.captureInputWrite?.(action, semanticPaneId);
      } catch {
        // Optional diagnostics must never suppress a dispatch.
      }
      const onReply = action.traceIds?.length
        ? (reply: { ok: boolean }) =>
            this.opts.onInputAccepted?.(action, Math.floor(performance.now() * 1_000), reply.ok)
        : undefined;
      if (this.trySendOwnedInput(action, onReply)) {
        // The existing coalescer still owns ordering. Never replay an accepted
        // native dispatch even when its attribution metadata is unavailable.
      } else if (action.kind === "literal") {
        this.io.send(
          `send-keys -t ${action.pane} -H ${textToHexKeys(action.text).join(" ")}`,
          onReply,
        );
      } else if (action.kind === "bytes") {
        this.io.send(
          `send-keys -t ${action.pane} -H ${Array.from(action.data, (byte) => byte.toString(16).padStart(2, "0")).join(" ")}`,
          onReply,
        );
      } else {
        this.io.send(`send-keys -t ${action.pane} ${action.key}`, onReply);
      }
      try {
        complete?.(
          startedAtMicros,
          Math.floor(performance.now() * 1_000),
          pendingBeforeSend,
          !this.disposed &&
            pane !== undefined &&
            semanticPaneId !== null &&
            this.panesByRuntime.get(action.pane) === pane &&
            this.panesBySemantic.get(semanticPaneId) === pane &&
            pane.runtimeId === action.pane &&
            pane.semanticId === semanticPaneId &&
            pane.incarnation === paneIncarnation &&
            pane.active === paneActive &&
            pane.descriptor !== null &&
            pane.descriptor.nativePaneBirthId === birth,
        );
      } catch {
        // In particular, never replay an accepted owned-native dispatch.
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

  private trySendOwnedInput(
    action: InputAction,
    onReply?: (reply: { ok: boolean }) => void,
  ): boolean {
    const adapter = this.opts.ownedViewer;
    if (!adapter) return false;
    const birth = this.panesByRuntime.get(action.pane)?.descriptor?.nativePaneBirthId;
    if (!birth) return false;
    // Legacy callers may supply a tmux key expression. Only a single named key
    // can be moved into structured argv without changing its interpretation.
    if (action.kind === "key" && !/^[A-Za-z0-9_-]+$/.test(action.key)) return false;
    const keys =
      action.kind === "literal"
        ? ["-H", ...textToHexKeys(action.text)]
        : action.kind === "bytes"
          ? ["-H", ...Array.from(action.data, (byte) => byte.toString(16).padStart(2, "0"))]
          : [action.key];
    return adapter.tryDispatch(
      this.io,
      {
        paneId: action.pane,
        paneBirthId: birth,
        commands: [["send-keys", "-t", action.pane, ...keys]],
        resultIndex: 0,
        limits: { maxBytes: 65536, maxLines: 1024 },
      },
      onReply ?? (() => {}),
    );
  }

  private captureWithViewer(
    runtime: string,
    flags: readonly string[],
    onStockMarker: (marker: string) => void,
    onReply: (reply: ControlReply) => void,
    limits?: ControlReplyLimits,
  ): void {
    const command = ["capture-pane", "-p", ...flags, "-t", runtime];
    const birth = this.panesByRuntime.get(runtime)?.descriptor?.nativePaneBirthId;
    if (
      birth &&
      this.opts.ownedViewer?.tryDispatch(
        this.io,
        {
          paneId: runtime,
          paneBirthId: birth,
          commands: [command],
          resultIndex: 0,
          limits: limits ?? {
            maxBytes: RECOVERY_CAPTURE_MAX_BYTES,
            maxLines: RECOVERY_CAPTURE_MAX_LINES,
          },
        },
        onReply,
      )
    )
      return;
    // Install compatibility metadata only after native dispatch declined without
    // writing. Publish it to the caller before a synchronous error callback.
    const marker = registerInternalReadOperation(runtime);
    onStockMarker(marker);
    const stock = `set-option -p -t ${runtime} ${INTERNAL_READ_OPERATION_OPTION} ${marker} ; ${command.join(" ")}`;
    if (limits && this.io.commandListBoundedInline) {
      this.io.commandListBoundedInline(stock, 2, 1, limits, onReply);
    } else {
      this.io.commandListInline(stock, 2, 1, onReply);
    }
  }

  constructor(opts: SessionChannelOptions) {
    this.opts = opts;
    this.io = opts.createIo({
      onOutput: (pane, data, ageMs, timing) => this.onOutput(pane, data, ageMs, timing),
      onNotify: (name, rest) => this.onNotify(name, rest),
      onExit: () => this.onChannelExit(),
    });
    opts.ownedViewer?.bindIo(this.io);
    this.nativeGrid = new NativeGridCaptureReader({
      commandBoundedInline: this.io.commandListBoundedInline
        ? (command, limits, onReply) => {
            const runtime = /-t (%(?:0|[1-9][0-9]*))$/.exec(command)?.[1];
            if (!runtime) {
              onReply({ ok: false, lines: [] });
              return;
            }
            let marker: string | null = null;
            this.captureWithViewer(
              runtime,
              ["-R", "-S", "-"],
              (value) => {
                marker = value;
              },
              (reply) => {
                if (marker) {
                  if (reply.ok) this.clearInternalReadMarkerOption(runtime, marker);
                  else this.retireInternalReadMarker(runtime, marker);
                }
                onReply(reply);
              },
              limits,
            );
          }
        : undefined,
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
    // Changing border placement can resize PTYs without changing the layout
    // string, so tmux emits no layout-change. Subscribe to this window option.
    this.io.send("refresh-client -B 'tmux-ide-pane-borders:@*:#{pane-border-status}'");
    this.io.send("refresh-client -B 'tmux-ide-copy-keys:@*:#{mode-keys}'");
    this.io.send("refresh-client -B 'tmux-ide-pane-history:%*:#{history_size}'");
    this.io.send("refresh-client -B 'tmux-ide-scroll-on-clear:%*:#{scroll-on-clear}'");
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
        hostName: TMUX_SERVER_HOSTNAME,
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
    const flight = this.refreshTrustedInventory(expectedRuntimeSessionId)
      .catch((error) => {
        this.windowLinkAuthority?.invalidate();
        this.latestWindowStage = null;
        throw error;
      })
      .finally(() => {
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
    const lines = await this.io.request(
      `display-message -p "#{qa:session_name}\t#{session_id}\t#{pid}\t#{session_created}"`,
    );
    if (lines.length !== 1)
      throw new Error(`mirror session ${this.opts.session} identity is absent`);
    const decodedLine = decodeControlReplyUtf8(lines[0]!);
    if (decodedLine === null)
      throw new Error(`mirror session ${this.opts.session} identity is malformed`);
    const [encodedName = "", runtimeSessionId = "", serverPid = "", sessionCreated = ""] =
      decodedLine.split("\t");
    const sessionName = decodeTmuxArgument(encodedName);
    if (
      sessionName.length === 0 ||
      sessionName.length > 160 ||
      !/^\$(?:0|[1-9][0-9]*)$/u.test(runtimeSessionId) ||
      runtimeSessionId.length > 32 ||
      !/^[1-9][0-9]*$/u.test(serverPid) ||
      !/^[0-9]+$/u.test(sessionCreated)
    ) {
      throw new Error(`mirror session ${this.opts.session} identity is malformed`);
    }
    this.attachedIdentity = Object.freeze({ sessionName, runtimeSessionId });
    this.attachedServerGeneration = { serverPid, sessionCreated };
    if (this.disposed) return;
    this.bindWindowLinkAuthority(
      liveSessionIdForNativeIdentity(serverPid, runtimeSessionId, sessionCreated),
    );
  }

  private bindWindowLinkAuthority(liveSessionId: string): void {
    const identity = this.attachedIdentity;
    if (!identity || this.disposed) throw new WindowLinkResolutionError("window_link_stale");
    if (this.windowLinkAuthority?.liveSessionId === liveSessionId) return;
    this.windowLinkAuthority?.dispose();
    this.windowLinkAuthority = new WindowLinkAuthority(liveSessionId, identity.runtimeSessionId);
    if (this.latestWindowStage) this.windowLinkAuthority.reconcile(this.latestWindowStage.links);
  }

  /** Capture this attached connection once; never resolve a replacement mid-operation. */
  paneResizeTransport(): (args: readonly string[]) => Promise<string> {
    const identity = this.attachedIdentity;
    const generation = this.attachedServerGeneration;
    const assertCurrent = () => {
      if (
        this.disposed ||
        !identity ||
        !generation ||
        this.attachedIdentity !== identity ||
        this.attachedServerGeneration !== generation
      )
        throw new Error("Resize control connection retired");
    };
    assertCurrent();
    return async (args) => {
      assertCurrent();
      const listing =
        args.length === 6 &&
        args[0] === "list-panes" &&
        args[1] === "-s" &&
        args[2] === "-t" &&
        args[3] === `=${identity!.sessionName}` &&
        args[4] === "-F";
      const resize =
        args.length === 11 &&
        args[0] === "resize-pane" &&
        args[1] === "-t" &&
        /^%[0-9]+$/u.test(args[2]!) &&
        (args[3] === "-x" || args[3] === "-y") &&
        /^[1-9][0-9]*$/u.test(args[4]!) &&
        args[5] === ";" &&
        args[6] === "display-message" &&
        args[7] === "-p" &&
        args[8] === "-t" &&
        args[9] === args[2] &&
        args[10] === (args[3] === "-x" ? "#{pane_width}" : "#{pane_height}");
      if (!listing && !resize) throw new Error("Invalid resize control command");
      // A runtime session ID prevents a rename/replacement from redirecting the lookup.
      const pinned = listing
        ? [...args.slice(0, 3), identity!.runtimeSessionId, ...args.slice(4)]
        : args;
      const command = pinned
        .map((arg, index) => (resize && index === 5 ? ";" : tmuxSingleQuote(arg)))
        .join(" ");
      const lines = listing
        ? await this.io.request(command)
        : await new Promise<string[]>((resolve, reject) => {
            this.io.commandListInline(command, 2, 1, (reply) =>
              reply.ok ? resolve(reply.lines) : reject(new Error("Resize control command failed")),
            );
          });
      assertCurrent();
      return lines
        .map((line) => {
          const decoded = decodeControlReplyUtf8(line);
          if (decoded === null) throw new Error("Invalid resize control reply");
          return decoded;
        })
        .join("\n");
    };
  }

  /** Exact native ancestry, never reconstructed from published pane rectangles. */
  describeSplitLayout(target: WindowLinkTarget): NativeSplitLayoutSnapshot {
    const authority = this.windowLinkAuthority;
    const identity = this.attachedIdentity;
    const generation = this.attachedServerGeneration;
    if (this.disposed || this.degraded || !authority || !identity || !generation)
      throw new Error("Split layout unavailable");
    const resolved = authority.resolve(target);
    const window = this.windowsByRuntime.get(resolved.runtimeWindowId);
    const layout = this.layoutByWindow.get(resolved.runtimeWindowId);
    if (
      resolved.runtimeSessionId !== identity.runtimeSessionId ||
      !window?.semanticId ||
      window.semanticId !== target.expectedSemanticWindowId ||
      !layout ||
      layout.zoomed ||
      this.pendingLayoutOutput.has(resolved.runtimeWindowId) ||
      !parseLayoutTree(layout.rawLayout)
    )
      throw new Error("Split layout unavailable");
    const native = parseLayout(layout.rawLayout)!;
    const records = [...this.panesByRuntime.values()].filter(
      (pane) => pane.windowRuntimeId === resolved.runtimeWindowId,
    );
    if (records.length !== native.leaves.length || native.leaves.length !== layout.leaves.length)
      throw new Error("Split layout pane identity incomplete");
    const panes = native.leaves.map((leaf) => {
      const pane = this.panesByRuntime.get(leaf.id);
      const birth = pane?.descriptor?.nativePaneBirthId;
      if (
        !pane ||
        pane.windowRuntimeId !== resolved.runtimeWindowId ||
        pane.descriptor?.runtimeSessionId !== identity.runtimeSessionId ||
        pane.descriptor?.windowId !== resolved.runtimeWindowId ||
        this.panesBySemantic.get(pane.semanticId) !== pane ||
        !birth ||
        !/^[1-9]\d*$/u.test(birth) ||
        !layout.leaves.some(
          (visible) =>
            visible.id === leaf.id &&
            visible.left === leaf.left &&
            visible.top === leaf.top &&
            visible.width === leaf.width &&
            visible.height === leaf.height,
        )
      )
        throw new Error("Split layout pane identity incomplete");
      return Object.freeze({
        runtimePaneId: pane.runtimeId,
        semanticPaneId: pane.semanticId,
        nativePaneBirthId: birth,
      });
    });
    return Object.freeze({
      sessionName: identity.sessionName,
      sessionCreated: generation.sessionCreated,
      runtimeSessionId: resolved.runtimeSessionId,
      runtimeWindowId: resolved.runtimeWindowId,
      semanticWindowId: window.semanticId,
      rawLayout: layout.rawLayout,
      panes: Object.freeze(panes),
    });
  }

  async executeWindowLinkAction(request: {
    action: "select" | "unlink";
    target?: WindowLinkTarget;
    paneId?: string;
  }): Promise<{
    outcome: "applied" | "stale" | "native-refused" | "indeterminate";
    windowLinks: WindowLinkTopology | null;
  }> {
    const authority = this.windowLinkAuthority;
    if (!authority || this.disposed) throw new WindowLinkResolutionError("window_link_stale");
    const pane = request.paneId ? this.panesBySemantic.get(request.paneId) : undefined;
    if (request.paneId && !pane)
      throw new WindowLinkResolutionError("window_link_backing_mismatch");
    const semanticWindow = pane?.windowRuntimeId
      ? this.windowsByRuntime.get(pane.windowRuntimeId)?.semanticId
      : null;
    const target =
      request.target ?? (semanticWindow ? authority.uniqueTargetForBacking(semanticWindow) : null);
    if (!target) throw new WindowLinkResolutionError("window_link_stale");
    const resolved = authority.resolve(target);
    if (pane && (pane.windowRuntimeId !== resolved.runtimeWindowId || request.action !== "select"))
      throw new WindowLinkResolutionError("window_link_backing_mismatch");
    const address = {
      sessionId: resolved.runtimeSessionId,
      windowIndex: resolved.index,
      expectedWindowId: resolved.runtimeWindowId,
      expectedServerPid: this.attachedServerGeneration!.serverPid,
      expectedSessionCreated: this.attachedServerGeneration!.sessionCreated,
    };
    const args = pane
      ? buildNativeWindowLinkPaneSelectGuard(address, pane.runtimeId)
      : buildNativeWindowLinkGuard(address, request.action);
    let outcome: "applied" | "stale" | "native-refused" | "indeterminate";
    try {
      if (!this.opts.executeWindowLinkGuard) throw new Error("Window link executor unavailable");
      const result = await this.opts.executeWindowLinkGuard(args);
      outcome = classifyNativeWindowLinkGuardResult(result.status, result.stdout);
    } catch {
      // A lost command boundary can follow a mutation; never retry automatically.
      outcome = "indeterminate";
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconciled = await Promise.race([
      this.syncNow().then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (!reconciled) {
      authority.invalidate();
      this.latestWindowStage = null;
      return { outcome, windowLinks: null };
    }
    return { outcome, windowLinks: authority.snapshot() };
  }

  /** Optional native backing, addressed through the verified semantic binding. */
  captureNativeBacking(
    semanticPaneId: string,
    ownsSubscription: () => boolean = () => true,
  ): Promise<NativeGridReadResult> {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane || this.disposed || !ownsSubscription())
      return Promise.resolve({ status: "retired" });
    const { runtimeId, incarnation } = pane;
    this.input.flush();
    const outputOrdinal = this.outputOrdinals.get(runtimeId) ?? 0;
    const topologyEpoch = this.layoutTopologyEpoch;
    const authorityOrdinal = this.windowAuthorityOrdinal;
    return this.nativeGrid.read(
      runtimeId,
      () =>
        !this.disposed &&
        ownsSubscription() &&
        this.panesBySemantic.get(semanticPaneId) === pane &&
        this.panesByRuntime.get(runtimeId) === pane &&
        pane.runtimeId === runtimeId &&
        pane.incarnation === incarnation,
      // This remains raw backing, not a canonical revision. Reject observed
      // output/layout crossings before an owner can try to qualify it.
      () =>
        (this.outputOrdinals.get(runtimeId) ?? 0) === outputOrdinal &&
        this.layoutTopologyEpoch === topologyEpoch &&
        this.windowAuthorityOrdinal === authorityOrdinal,
    );
  }

  subscribePane(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
    nativeBootstrap = false,
  ): PaneSubscriptionHandle {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane) {
      throw new Error(`unknown semantic pane ${semanticPaneId} in session ${this.opts.session}`);
    }
    const sub: SubRecord = {
      feed: new PaneFeed(),
      nativeBootstrap: nativeBootstrap && !this.nativeBootstrapUnavailable,
      onEvent,
      onLayout: onLayout ?? null,
      pane,
      frozen: false,
      closed: false,
    };
    sub.feed.abortCurrent();
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
      captureNativeBacking: () =>
        this.captureNativeBacking(
          semanticPaneId,
          () =>
            !sub.closed && sub.pane === pane && this.panesBySemantic.get(semanticPaneId) === pane,
        ),
      readHistorySize: () =>
        new Promise((resolve) => {
          const current = () =>
            !this.disposed &&
            !sub.closed &&
            !sub.frozen &&
            this.panesByRuntime.get(pane.runtimeId) === pane;
          if (!current()) {
            resolve(null);
            return;
          }
          this.io.commandInline(
            `display-message -p -t ${pane.runtimeId} "#{history_size}"`,
            (reply) => {
              const value = reply.lines[0]?.trim() ?? "";
              const size = Number(value);
              resolve(
                current() && reply.ok && /^[0-9]+$/u.test(value) && Number.isSafeInteger(size)
                  ? size
                  : null,
              );
            },
          );
        }),
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

  qualificationListeners() {
    return Object.freeze({
      pane: [...this.panesByRuntime.values()].reduce((sum, pane) => sum + pane.subs.size, 0),
      layout: this.layoutSubscribers.size,
      layoutAuthority: this.layoutAuthoritySubscribers.size,
    });
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
      this.latestWindowStage?.links.length !== inventory.panes[0]!.sessionWindowCount ||
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
        (event.zoomed ? observed.length !== 1 : observed.length !== expectedPanes.size) ||
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

  sendBytes(semanticPaneId: string, data: Uint8Array, performanceTraceId?: string): void {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane)
      throw new Error(`unknown semantic pane ${semanticPaneId} in session ${this.opts.session}`);
    this.input.bytes(pane.runtimeId, data, performanceTraceId);
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
    this.clearWindowViewports();
    this.restoreWindowSizing(this.attachedIdentity?.runtimeSessionId ?? `=${this.opts.session}`);
    this.io.send(`refresh-client -C ${cols}x${rows}`);
  }

  private restoreWindowSizing(target: string): void {
    if (!this.geometryParticipating) return;
    // resize-window pins a window (including through inherited session options).
    // Evaluate inside the existing control connection: no shell, polling, or extra
    // request/response round trip. The shell also pre-fits hidden windows;
    // only the active window may have its manual policy repaired.
    const quoted = tmuxSingleQuote(target);
    // if-shell emits its own reply and the selected branch emits another.
    // Keep both branches at one command so either policy consumes exactly two
    // FIFO slots; a discard-only send would misroute the next capture replies.
    this.io.commandListInline(
      `if-shell -F -t ${quoted} '#{&&:#{window_active},#{==:#{window-size},manual}}' ` +
        tmuxSingleQuote(`set-option -w -t ${quoted} window-size latest`) +
        " " +
        tmuxSingleQuote(`display-message -p -t ${quoted} ''`),
      2,
      1,
      () => {},
    );
  }

  /**
   * Experimental: window-specific overrides stay private to this control client.
   * Native tmux still falls back to the client size for unscoped neighbours;
   * do not advertise isolated fitting until that behavior is accounted for.
   */
  fitWindowViewport(semanticWindowId: string, cols: number, rows: number): void {
    if (
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols < 2 ||
      rows < 2 ||
      cols > 4096 ||
      rows > 4096
    ) {
      throw new RangeError("viewport must contain positive bounded terminal cells");
    }
    const window = [...this.windowsByRuntime.values()].find(
      (entry) => entry.semanticId === semanticWindowId,
    );
    if (!window || !/^@[0-9]+$/u.test(window.runtimeId)) {
      throw new Error("unknown semantic window in this session");
    }
    const previous = this.fittedWindows.get(window.runtimeId);
    if (previous?.cols === cols && previous.rows === rows) return;
    this.input.flush();
    this.restoreWindowSizing(window.runtimeId);
    this.io.send(`refresh-client -C ${window.runtimeId}:${cols}x${rows}`);
    this.fittedWindows.set(window.runtimeId, { cols, rows });
  }

  /** Must also run on geometry-owner handoff, before the next owner fits. */
  clearWindowViewports(): void {
    if (!this.fittedWindows.size) return;
    this.input.flush();
    for (const runtimeId of this.fittedWindows.keys()) {
      // A removed window no longer has a live override to clear.
      if (this.windowsByRuntime.has(runtimeId)) this.io.send(`refresh-client -C ${runtimeId}:`);
    }
    this.fittedWindows.clear();
  }

  /** Toggle whether the retained control client participates in tmux sizing. */
  setGeometryParticipation(active: boolean): void {
    if (!active) this.clearWindowViewports();
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
    this.snapshotActive?.cleanup?.();
    this.snapshotActive?.cancelFence?.();
    this.snapshotActive = null;
    this.snapshotQueue.clear();
    this.windowLinkAuthority?.dispose();
    this.nativeGrid.dispose();
    this.settleFirstJoin();
    this.cancelSync?.();
    this.cancelSync = null;
    for (const runtime of [...this.recoveries.keys()]) this.cancelRecovery(runtime);
    this.discovery.dispose();
    this.input.flush();
    this.opts.ownedViewer?.dispose();
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.cancelCapture?.();
          try {
            sub.onEvent({ type: "closed" });
          } catch {
            // Close every sibling and the transport even if a consumer throws.
          }
        }
      }
      pane.subs.clear();
    }
    this.pendingLayoutOutput.clear();
    this.layoutNotificationOrdinals.clear();
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
    const stockRecovery = this.recoveries.get(runtimePane);
    const stockPane = this.panesByRuntime.get(runtimePane);
    if (stockRecovery?.stock && stockPane && stockRecovery.lease) {
      const disposition = stockRecovery.stock.acceptOutput(
        runtimePane,
        data,
        this.snapshotContext(stockPane),
      );
      if (disposition !== "live" && disposition !== "unrelated") {
        const ordinal = (this.outputOrdinals.get(runtimePane) ?? 0) + 1;
        this.outputOrdinals.set(runtimePane, ordinal);
        this.opts.onOutputObserved?.(stockPane.semanticId, ageMs, timing);
        if (ageMs !== null) {
          this.ageByRuntime.set(runtimePane, ageMs);
          if (ageMs > this.maxAgeMs) this.maxAgeMs = ageMs;
        }
        if (disposition === "invalid") this.retrySnapshot(stockRecovery);
        return;
      }
    }
    const windowId = this.panesByRuntime.get(runtimePane)?.windowRuntimeId;
    const pending = windowId ? this.pendingLayoutOutput.get(windowId) : undefined;
    if (pending) {
      if (!pending.overflowed) {
        pending.bytes += data.byteLength;
        if (pending.bytes > 1024 * 1024 || pending.records.length >= 1024) {
          pending.overflowed = true;
          pending.records = [];
        } else pending.records.push({ pane: runtimePane, data: data.slice(), ageMs, timing });
      }
      return;
    }
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
  }

  // ── Seed / reseed (the atomic recipe) ────────────────────────────────────

  private reseedPlain(sub: SubRecord, resumeReason: "requested" | null = null): void {
    if (sub.closed || sub.frozen || this.disposed) return;
    this.beginRecovery(sub.pane, resumeReason ?? "requested");
  }

  private retireInternalReadMarker(runtime: string, marker: string): void {
    if (!/^%(?:0|[1-9][0-9]*)$/u.test(runtime))
      throw new TypeError("internal read cleanup requires a runtime pane id");
    retireInternalReadOperation(marker, runtime);
    this.clearInternalReadMarkerOption(runtime, marker);
  }

  private clearInternalReadMarkerOption(runtime: string, marker: string): void {
    if (!/^%(?:0|[1-9][0-9]*)$/u.test(runtime))
      throw new TypeError("internal read cleanup requires a runtime pane id");
    // Success must keep the in-memory proof redeemable by a delayed observer.
    // The server option must still be removed when no observer hook is installed.
    // Pane capture phases overlap under cancellation. Clear only the exact
    // owned marker so a late A callback cannot erase the newer B authority.
    // Both selected branches must emit one reply in addition to if-shell's
    // own reply. An empty false branch emits none and shifts the control FIFO
    // whenever the true branch runs during capture cancellation.
    this.io.commandListInline(
      `if-shell -t ${runtime} -F "#{==:#{${INTERNAL_READ_OPERATION_OPTION}},${marker}}" ` +
        `"set-option -pu -t ${runtime} ${INTERNAL_READ_OPERATION_OPTION}" ` +
        `"display-message -p -t ${runtime} ''"`,
      2,
      1,
      () => {},
    );
  }

  private layoutCaptureSizeFor(sub: SubRecord): { cols: number; rows: number } | null {
    const windowId = sub.pane.windowRuntimeId;
    const event = windowId ? this.layoutEventFor(windowId, sub.pane.runtimeId) : null;
    if (!event || event.semanticWindowId === null) return null;
    const identities = event.panes.map((pane) => pane.semanticPaneId);
    if (identities.some((id) => id === null) || new Set(identities).size !== identities.length)
      return null;
    const matches = event.panes.filter((pane) => pane.semanticPaneId === sub.pane.semanticId);
    if (matches.length !== 1) return null;
    const pane = matches[0]!;
    if (
      ![event.cols, event.rows, pane.width, pane.height].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      !Number.isSafeInteger(pane.left) ||
      !Number.isSafeInteger(pane.top) ||
      pane.left < 0 ||
      pane.top < 0 ||
      pane.left + pane.width > event.cols ||
      pane.top + pane.height > event.rows
    )
      return null;
    return {
      cols: pane.width,
      rows: layoutContentRows(pane.top, pane.height, event.rows, event.paneBorderStatus),
    };
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
    sub.cancelCapture?.();
    const activeRecovery = this.recoveries.get(sub.pane.runtimeId);
    if (
      activeRecovery &&
      [...sub.pane.subs].some((candidate) => !candidate.closed && !candidate.frozen)
    )
      this.retrySnapshot(activeRecovery);
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
    try {
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
    } catch {
      // Optional diagnostics cannot prevent recovery or failure delivery.
    }
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
    this.recoveries.delete(runtime);
    this.snapshotQueue.delete(runtime);
    recovery.cancelCommandDeadline?.();
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelAbsoluteDeadline?.();
    const pane = this.panesByRuntime.get(runtime);
    if (pane?.incarnation === recovery.paneIncarnation)
      for (const sub of pane.subs) sub.feed.abortCurrent();
    if (recovery.lease) this.retireSnapshotLease(recovery.lease);
    else if (recovery.atomicCollectorNonce)
      this.io.retireAtomicPaneSnapshotCollector?.(recovery.atomicCollectorNonce, "retired");
    recovery.atomicCollectorNonce = null;
  }

  private beginRecovery(pane: PaneRecord, reason: "backpressure" | "requested"): void {
    if (this.disposed) return;
    const current = this.recoveries.get(pane.runtimeId);
    if (current && !current.retired) {
      if (this.snapshotQueue.get(pane.runtimeId) === current) return;
      this.retrySnapshot(current);
      return;
    }
    if (this.snapshotQueue.size >= MAX_QUEUED_SNAPSHOTS) {
      for (const sub of pane.subs) {
        sub.feed.abortCurrent();
        if (!sub.closed && !sub.frozen)
          sub.onEvent({ type: "fault", reason: "native-recovery-failed" });
      }
      return;
    }
    const recovery: RecoveryRecord = {
      ordinal: ++this.recoveryOrdinal,
      runtimeId: pane.runtimeId,
      paneIncarnation: pane.incarnation,
      reason,
      startedAtMs: this.recoveryNowMs(),
      retired: false,
      stage: "queued",
      attempts: 0,
      reseedOrdinal: 0,
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
      cancelCommandDeadline: null,
      cancelNoProgressDeadline: null,
      cancelAbsoluteDeadline: null,
    };
    this.recoveries.set(pane.runtimeId, recovery);
    this.snapshotQueue.set(pane.runtimeId, recovery);
    this.drainSnapshots();
  }

  private beginLocalOverflowRecovery(pane: PaneRecord): void {
    this.beginRecovery(pane, "backpressure");
  }

  private snapshotContext(pane: PaneRecord): StockPaneSnapshotContext {
    return {
      paneId: pane.runtimeId,
      incarnation: pane.incarnation,
      layoutGeneration: pane.snapshotLayoutGeneration,
      participants: [...pane.subs].filter((sub) => !sub.closed && !sub.frozen),
    };
  }

  private snapshotLeaseCurrent(lease: SnapshotLease): boolean {
    return (
      this.snapshotActive === lease && !lease.retired && this.recoveryPane(lease.recovery) !== null
    );
  }

  private drainSnapshots(): void {
    if (this.snapshotActive || this.disposed) return;
    for (const [runtime, recovery] of this.snapshotQueue) {
      if (
        recovery.waitForSyncAfter !== undefined &&
        this.completedSyncOrdinal <= recovery.waitForSyncAfter
      )
        continue;
      this.snapshotQueue.delete(runtime);
      const pane = this.recoveryPane(recovery);
      if (!pane || ![...pane.subs].some((sub) => !sub.closed && !sub.frozen)) {
        this.cancelRecovery(runtime);
        continue;
      }
      if (recovery.attempts >= RECOVERY_MAX_ATTEMPTS) {
        this.failRecovery(recovery, "attempts-exhausted");
        continue;
      }
      const lease: SnapshotLease = {
        recovery,
        retired: false,
        wireNonce: null,
        retry: false,
        fencePending: false,
        cancelFence: null,
      };
      this.snapshotActive = lease;
      recovery.lease = lease;
      if (!recovery.cancelAbsoluteDeadline) {
        recovery.startedAtMs = this.recoveryNowMs();
        this.beginRecoveryConvergence(recovery);
      } else this.noteRecoveryProgress(recovery);
      for (const sub of pane.subs) if (!sub.closed && !sub.frozen) sub.feed.abortCurrent();
      const target = this.nativeRecoveryTarget(pane);
      if (
        recovery.nativeOwner &&
        (target?.serverEpoch !== recovery.nativeOwner.serverEpoch ||
          target?.paneBirthId !== recovery.nativeOwner.paneBirthId)
      ) {
        this.failRecovery(recovery, "command-error");
        return;
      }
      if (target) {
        recovery.nativeOwner ??= target;
        recovery.stock = undefined;
        this.recoverNativeAtomic(pane, recovery, target);
      } else this.startStockSnapshot(pane, recovery, lease);
      return;
    }
  }

  private releaseSnapshotLease(lease: SnapshotLease): void {
    if (this.snapshotActive !== lease || lease.wireNonce || lease.fencePending) return;
    lease.cancelFence?.();
    lease.cancelFence = null;
    const pane = this.panesByRuntime.get(lease.recovery.runtimeId);
    if (
      lease.ownsPause &&
      pane?.incarnation === lease.recovery.paneIncarnation &&
      pane.subs.size === 0 &&
      !this.ledger.isRequested(pane.runtimeId)
    ) {
      this.io.commandInline(`refresh-client -A '${pane.runtimeId}:continue'`, () => {});
      this.ledger.noteContinued(pane.runtimeId);
    }
    this.snapshotActive = null;
    if (lease.recovery.lease === lease) lease.recovery.lease = undefined;
    if (lease.retry && this.recoveryPane(lease.recovery)) {
      lease.recovery.stage = "queued";
      this.snapshotQueue.set(lease.recovery.runtimeId, lease.recovery);
    }
    this.drainSnapshots();
  }

  private retireSnapshotLease(lease: SnapshotLease, retry = false): void {
    if (this.snapshotActive !== lease) return;
    lease.retired = true;
    if (this.disposed) {
      lease.cancelFence?.();
      lease.cancelFence = null;
      this.snapshotActive = null;
      this.snapshotQueue.clear();
      return;
    }
    lease.retry ||= retry;
    lease.recovery.stock?.invalidate();
    lease.cleanup?.();
    lease.cleanup = undefined;
    lease.recovery.cancelCommandDeadline?.();
    lease.recovery.cancelCommandDeadline = null;
    if (lease.wireNonce) {
      this.io.retireAtomicPaneSnapshotCollector?.(lease.wireNonce, "retired");
      return;
    }
    if (lease.fencePending) return;
    // Native wrapper/setup commands still own ordinary FIFO slots. A separate
    // bounded command proves they drained before another raw hook is admitted.
    lease.fencePending = true;
    const token = `tmux-ide-snapshot-admission:${randomBytes(24).toString("hex")}`;
    const failed = () => {
      if (this.snapshotActive !== lease) return;
      lease.retry = false;
      lease.cancelFence?.();
      void this.io.dispose();
    };
    lease.cancelFence = this.scheduleRecovery(failed, RECOVERY_ABSOLUTE_DEADLINE_MS);
    const done = (reply: ControlReply) => {
      if (this.snapshotActive !== lease) return;
      if (!reply.ok || reply.lines.length !== 1 || reply.lines[0] !== token) {
        failed();
        return;
      }
      lease.fencePending = false;
      this.releaseSnapshotLease(lease);
    };
    if (this.io.commandBoundedInline)
      this.io.commandBoundedInline(
        `display-message -p -l ${token}`,
        { maxBytes: 256, maxLines: 1 },
        done,
      );
    else this.io.commandInline(`display-message -p -l ${token}`, done);
  }

  private awaitSnapshotLayout(recovery: RecoveryRecord): void {
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelNoProgressDeadline = null;
    recovery.waitForSyncAfter = this.syncOrdinal;
    this.scheduleSync();
  }

  private retrySnapshot(recovery: RecoveryRecord): void {
    const pane = this.recoveryPane(recovery);
    if (!pane) return;
    for (const sub of pane.subs) if (!sub.closed && !sub.frozen) sub.feed.abortCurrent();
    recovery.stock?.invalidate();
    if (
      recovery.attempts >= RECOVERY_MAX_ATTEMPTS ||
      (recovery.cancelAbsoluteDeadline &&
        this.recoveryNowMs() - recovery.startedAtMs >= RECOVERY_ABSOLUTE_DEADLINE_MS)
    ) {
      this.failRecovery(recovery, "attempts-exhausted");
      return;
    }
    if (recovery.lease) this.retireSnapshotLease(recovery.lease, true);
    else {
      recovery.stage = "queued";
      this.snapshotQueue.set(recovery.runtimeId, recovery);
      this.drainSnapshots();
    }
  }

  private startStockSnapshot(
    pane: PaneRecord,
    recovery: RecoveryRecord,
    lease: SnapshotLease,
  ): void {
    if (!this.io.armAtomicPaneSnapshotCollector || !this.io.retireAtomicPaneSnapshotCollector) {
      this.failRecovery(recovery, "command-error");
      return;
    }
    if (
      !this.nativeBootstrapConfirmed &&
      !this.nativeBootstrapUnavailable &&
      [...pane.subs].some((sub) => !sub.closed && !sub.frozen && sub.nativeBootstrap)
    ) {
      // Negotiate the live server before placing -R in a NOHOOKS transaction:
      // an unsupported flag aborts that hook before its completion sentinel.
      recovery.nativeProbeAttempts = (recovery.nativeProbeAttempts ?? 0) + 1;
      let marker: string | null = null;
      let probeSettled = false;
      recovery.cancelCommandDeadline = this.scheduleRecovery(() => {
        if (probeSettled || !this.snapshotLeaseCurrent(lease)) return;
        probeSettled = true;
        if ((recovery.nativeProbeAttempts ?? 0) < 2) this.retrySnapshot(recovery);
        else this.failRecovery(recovery, "command-timeout");
      }, RECOVERY_COMMAND_DEADLINE_MS);
      this.captureWithViewer(
        pane.runtimeId,
        ["-R", "-S", "-"],
        (value) => {
          marker = value;
        },
        (reply) => {
          if (marker) this.retireInternalReadMarker(pane.runtimeId, marker);
          if (probeSettled || !this.snapshotLeaseCurrent(lease)) return;
          probeSettled = true;
          recovery.cancelCommandDeadline?.();
          recovery.cancelCommandDeadline = null;
          const native = reply.ok ? decodeNativeGridCapture(reply.lines.join("\n")) : null;
          if (native && isNativeBootstrapCapture(native)) this.nativeBootstrapConfirmed = true;
          else if (nativeBootstrapUnsupported(reply.ok, reply.lines, native)) {
            this.nativeBootstrapUnavailable = true;
            for (const current of this.panesByRuntime.values())
              for (const sub of current.subs) sub.nativeBootstrap = false;
          } else {
            if ((recovery.nativeProbeAttempts ?? 0) < 2) this.retrySnapshot(recovery);
            else this.failRecovery(recovery, "command-error");
            return;
          }
          this.startStockSnapshot(pane, recovery, lease);
        },
        { maxBytes: RECOVERY_CAPTURE_MAX_BYTES, maxLines: RECOVERY_CAPTURE_MAX_LINES },
      );
      return;
    }
    recovery.attempts += 1;
    recovery.stage = "stock-pause";
    recovery.stock = new StockPaneSnapshot(this.snapshotContext(pane));
    // These rows were received before this pause and belong to the new seed,
    // never to a delayed old-geometry replay after it.
    const pending = pane.windowRuntimeId
      ? this.pendingLayoutOutput.get(pane.windowRuntimeId)
      : null;
    if (pending) {
      pending.records = pending.records.filter((record) => record.pane !== pane.runtimeId);
      pending.bytes = pending.records.reduce((bytes, record) => bytes + record.data.byteLength, 0);
    }
    this.observeRecovery(pane, recovery, "pause");
    const nonce = randomBytes(24).toString("hex");
    const hook = `@tmux_ide_pause_${nonce}`;
    const body =
      `display-message -p -l '%tmux-ide-atomic-v1 ${nonce} start'` +
      ` ; refresh-client -A '${pane.runtimeId}:pause'` +
      ` ; display-message -p -l '%tmux-ide-atomic-v1 ${nonce} complete'`;
    let settled = false;
    let accepted = false;
    const cleanup = () =>
      this.io.commandListInline(
        `if-shell -t ${pane.runtimeId} -F ${tmuxSingleQuote(`#{==:#{${hook}},${body}}`)} ` +
          `${tmuxSingleQuote(`set-option -pu -t ${pane.runtimeId} ${hook}`)} ` +
          `${tmuxSingleQuote("display-message -p -l pause-cleanup-skipped")}`,
        2,
        1,
        () => {},
      );
    lease.cleanup = cleanup;
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (this.snapshotLeaseCurrent(lease)) this.retrySnapshot(recovery);
    };
    recovery.cancelCommandDeadline = this.scheduleRecovery(failed, RECOVERY_COMMAND_DEADLINE_MS);
    this.input.flush();
    this.io.commandInline(
      `set-option -po -t ${pane.runtimeId} ${hook} ${tmuxSingleQuote(body)}`,
      (reply) => {
        if (settled || !this.snapshotLeaseCurrent(lease)) {
          cleanup();
          return;
        }
        if (!reply.ok) {
          failed();
          return;
        }
        lease.wireNonce = nonce;
        const armed = this.io.armAtomicPaneSnapshotCollector!(
          {
            nonce,
            kind: "pause",
            runtimePaneId: pane.runtimeId,
            maxCaptureBytes: 1024,
            maxCaptureLines: 16,
            maxCursorBytes: 128,
            observerCommandCount: 0,
            onSettled: (result) => {
              cleanup();
              if (settled || !this.snapshotLeaseCurrent(lease)) return;
              if (!result.ok) {
                failed();
                return;
              }
              // The authenticated NOHOOKS body targets the same live pane as
              // set-hook -Rp. A successful pause is a no-op only when already
              // paused; its complete guard therefore fences that case too.
              accepted = recovery.stock!.observePause(this.snapshotContext(pane));
              if (!accepted) {
                failed();
                return;
              }
              lease.ownsPause = true;
              this.observedPaused.add(pane.runtimeId);
              this.ledger.notePause(pane.runtimeId);
              settled = true;
              recovery.cancelCommandDeadline?.();
              recovery.cancelCommandDeadline = null;
            },
            onDrained: (reason) => {
              if (lease.wireNonce === nonce) lease.wireNonce = null;
              if (reason === "channel-exit") {
                lease.retry = false;
                return;
              }
              if (!this.snapshotLeaseCurrent(lease) || !accepted) {
                this.releaseSnapshotLease(lease);
                return;
              }
              recovery.stage = "stock-capture";
              this.reseedRecoverySubscribersAtomic(
                pane,
                recovery,
                (result) => {
                  if (!this.snapshotLeaseCurrent(lease)) return;
                  if (!result.ok || !result.publish()) this.retrySnapshot(recovery);
                  else this.convergeRecovery(pane, recovery);
                },
                true,
              );
            },
          },
          Math.max(
            1,
            Math.floor(
              RECOVERY_ABSOLUTE_DEADLINE_MS - (this.recoveryNowMs() - recovery.startedAtMs),
            ),
          ),
        );
        if (!armed) {
          lease.wireNonce = null;
          failed();
          return;
        }
        // Once queued, this pause may execute even if its local callback is
        // cancelled. Return the owned pause after drain when no viewer remains.
        lease.ownsPause = true;
        // The option value is immutable for this attempt; compare it before
        // dispatch so another actor cannot replace the owned NOHOOKS body.
        this.io.commandListInline(
          `if-shell -t ${pane.runtimeId} -F ${tmuxSingleQuote(`#{==:#{${hook}},${body}}`)} ` +
            `${tmuxSingleQuote(`set-hook -Rp -t ${pane.runtimeId} ${hook}`)} ` +
            `${tmuxSingleQuote("display-message -p -l pause-hook-rejected")}`,
          2,
          1,
          (result) => {
            if (settled || !this.snapshotLeaseCurrent(lease)) return;
            if (!result.ok || result.lines.length) failed();
          },
        );
      },
    );
  }

  private nativeRecoveryTarget(
    pane: PaneRecord,
  ): (NativeAtomicSnapshotTarget & { representation: "native" | "dual" }) | null {
    // Mixed/plain recovery requires an explicitly negotiated dual snapshot.
    const live = [...pane.subs].filter((sub) => !sub.closed && !sub.frozen);
    const representation = live.every((sub) => sub.nativeBootstrap) ? "native" : "dual";
    const birth = pane.descriptor?.nativePaneBirthId;
    let epoch: string | null | undefined;
    try {
      epoch = this.opts.ownedViewer?.atomicSnapshotEpoch?.(this.io, representation);
    } catch {
      // Optional capability failure cannot strand ordinary recovery.
      return null;
    }
    return live.length > 0 && birth && epoch
      ? { serverEpoch: epoch, paneId: pane.runtimeId, paneBirthId: birth, representation }
      : null;
  }

  private recoverNativeAtomic(
    pane: PaneRecord,
    recovery: RecoveryRecord,
    target: NativeAtomicSnapshotTarget & { representation: "native" | "dual" },
  ): void {
    const lease = recovery.lease;
    if (!lease || !this.snapshotLeaseCurrent(lease) || this.recoveryPane(recovery) !== pane) return;
    const currentTarget = this.nativeRecoveryTarget(pane);
    if (
      currentTarget?.serverEpoch !== target.serverEpoch ||
      currentTarget.paneBirthId !== target.paneBirthId ||
      currentTarget.representation !== target.representation
    ) {
      this.failRecovery(recovery, "command-error");
      return;
    }
    if (recovery.attempts >= RECOVERY_MAX_ATTEMPTS) {
      this.failRecovery(recovery, "attempts-exhausted");
      return;
    }
    recovery.attempts += 1;
    const ordinal = ++recovery.reseedOrdinal;
    const participants = [...pane.subs]
      .filter((sub) => !sub.closed && !sub.frozen)
      .map((sub) => ({ sub, epoch: sub.feed.beginReseed() }));
    const exact = () => {
      const current = this.nativeRecoveryTarget(pane);
      const live = [...pane.subs].filter((sub) => !sub.closed && !sub.frozen);
      return (
        this.recoveryPane(recovery) === pane &&
        this.snapshotLeaseCurrent(lease) &&
        recovery.reseedOrdinal === ordinal &&
        current?.serverEpoch === target.serverEpoch &&
        current.paneBirthId === target.paneBirthId &&
        current.representation === target.representation &&
        live.length === participants.length &&
        participants.every(({ sub }) => live.includes(sub))
      );
    };
    let settled = false;
    const failed = () => {
      if (settled || this.recoveryPane(recovery) !== pane || recovery.reseedOrdinal !== ordinal)
        return;
      settled = true;
      recovery.cancelCommandDeadline?.();
      recovery.cancelCommandDeadline = null;
      for (const { sub } of participants) sub.feed.abortCurrent();
      // A malformed/late reply may follow a committed resume. Every retry
      // explicitly pauses first; never fall through to stock capture.
      this.retrySnapshot(recovery);
    };
    recovery.stage = "native-pause";
    recovery.cancelCommandDeadline = this.scheduleRecovery(failed, RECOVERY_COMMAND_DEADLINE_MS);
    this.input.flush();
    lease.ownsPause = true;
    this.io.commandInline(`refresh-client -A '${pane.runtimeId}:pause'`, (pauseReply) => {
      if (settled || !exact()) {
        failed();
        return;
      }
      if (!pauseReply.ok) {
        failed();
        return;
      }
      recovery.stage = "native-capture";
      recovery.cancelCommandDeadline?.();
      recovery.cancelCommandDeadline = this.scheduleRecovery(failed, RECOVERY_COMMAND_DEADLINE_MS);
      const accepted = this.opts.ownedViewer!.tryDispatch(
        this.io,
        target.representation === "dual"
          ? nativeAtomicDualSnapshotPlan({
              serverEpoch: target.serverEpoch,
              paneId: target.paneId,
              paneBirthId: target.paneBirthId,
            })
          : nativeAtomicSnapshotPlan({
              serverEpoch: target.serverEpoch,
              paneId: target.paneId,
              paneBirthId: target.paneBirthId,
            }),
        (reply) => {
          if (settled || !exact()) {
            failed();
            return;
          }
          const expected = {
            serverEpoch: target.serverEpoch,
            paneId: target.paneId,
            paneBirthId: target.paneBirthId,
          };
          const result: NativeAtomicSnapshotResult & { readonly ansiCapture?: Uint8Array } =
            target.representation === "dual"
              ? decodeNativeAtomicDualSnapshot(reply, expected)
              : decodeNativeAtomicSnapshot(reply, expected);
          if (result.status !== "ok") {
            failed();
            return;
          }
          const probe = parseCursorProbe(result.cursorLine);
          const size = this.layoutCaptureSizeFor(participants[0]!.sub);
          if (
            !probe ||
            probe.y >= probe.rows ||
            result.capture.cols !== probe.cols ||
            result.capture.rows !== probe.rows
          ) {
            failed();
            return;
          }
          if (
            (pane.windowRuntimeId !== null && this.pendingLayoutOutput.has(pane.windowRuntimeId)) ||
            (size && (size.cols !== probe.cols || size.rows !== probe.rows))
          ) {
            this.awaitSnapshotLayout(recovery);
            failed();
            return;
          }
          this.nativeBootstrapConfirmed = true;
          this.observeSnapshotMetadata(pane, result.cursorLine);
          const ansiLines = result.ansiCapture
            ? captureLinesFromAnsiBytes(result.ansiCapture)
            : null;
          const deliveries = participants.map(({ sub, epoch }) => {
            if (sub.nativeBootstrap) sub.feed.captureNativeReply(epoch, result.capture);
            else if (ansiLines) sub.feed.captureReply(epoch, ansiLines);
            return {
              sub,
              events: sub.feed.cursorReply(
                epoch,
                result.cursorLine,
                this.layoutSizeFor(pane.runtimeId),
              ),
            };
          });
          if (!exact() || deliveries.some(({ events }) => events.length === 0)) {
            failed();
            return;
          }
          for (const { sub, events } of deliveries)
            for (const event of events) {
              if (!exact()) {
                failed();
                return;
              }
              try {
                sub.onEvent(event);
              } catch {
                failed();
                return;
              }
            }
          if (!exact()) {
            failed();
            return;
          }
          settled = true;
          this.convergeRecovery(pane, recovery);
        },
      );
      if (!accepted) failed();
    });
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
    const cancel = this.scheduleRecovery(() => {
      if (recovery.cancelNoProgressDeadline !== cancel) return;
      if (this.recoveryPane(recovery)) this.failRecovery(recovery, "no-progress");
    }, RECOVERY_NO_PROGRESS_DEADLINE_MS);
    recovery.cancelNoProgressDeadline = cancel;
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

  private reseedRecoverySubscribersAtomic(
    pane: PaneRecord,
    recovery: RecoveryRecord,
    done: (result: ReseedResult) => void,
    deferPublish: boolean,
  ): void {
    const lease = recovery.lease;
    const stock = recovery.stock;
    if (!lease || !stock || !this.snapshotLeaseCurrent(lease)) {
      done(FAILED_RESEED_RESULT);
      return;
    }
    const live = [...pane.subs].filter((sub) => !sub.frozen && !sub.closed);
    if (live.length === 0) {
      done(FAILED_RESEED_RESULT);
      return;
    }
    const participants = live.map((sub) => Object.freeze({ sub, epoch: sub.feed.beginReseed() }));
    const nativeCapture =
      !this.nativeBootstrapUnavailable && participants.some(({ sub }) => sub.nativeBootstrap);
    const dualCapture = nativeCapture && participants.some(({ sub }) => !sub.nativeBootstrap);
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
        !this.snapshotLeaseCurrent(lease) ||
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
    lease.cleanup = cleanupHook;
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
    const observerRequired = this.opts.internalReadHookEmission !== undefined;
    const safeObserver =
      observer !== null &&
      /^[A-Za-z0-9._-]{1,256}$/u.test(observer.bufferName) &&
      /^[A-Za-z0-9._-]{1,256}$/u.test(observer.signalChannel) &&
      /^[A-Za-z0-9%:._|-]{1,1024}$/u.test(observer.record);
    if (observerRequired && !safeObserver) {
      fail();
      return;
    }
    const sentinel = (kind: string): string =>
      `display-message -p -l -t ${pane.runtimeId} ` + `"%tmux-ide-atomic-v1 ${nonce} ${kind}"`;
    const observerCommands = safeObserver
      ? ` ; ${boundedTmuxInteractionAppendCommand(observer!.bufferName, observer!.record)}` +
        ` ; wait-for -S ${observer!.signalChannel}`
      : "";
    const body =
      `set-option -po -t ${pane.runtimeId} ${INTERNAL_READ_OPERATION_OPTION} ${internalReadMarker}` +
      ` ; ${sentinel("start")}` +
      ` ; capture-pane -p ${nativeCapture ? "-R" : "-e -J"} -S -${this.opts.historyLines ?? ""} -t ${pane.runtimeId}` +
      ` ; ${sentinel("capture-end")}` +
      (dualCapture
        ? ` ; capture-pane -p -e -J -S -${this.opts.historyLines ?? ""} -t ${pane.runtimeId} ; ${sentinel("ansi-capture-end")}`
        : "") +
      ` ; display-message -p -t ${pane.runtimeId} "${RECOVERY_CURSOR_PROBE_FORMAT}"` +
      ` ; ${sentinel("cursor-end")}` +
      ` ; refresh-client -A ${tmuxSingleQuote(`${pane.runtimeId}:continue`)}` +
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
      if (settled || !this.snapshotLeaseCurrent(lease)) {
        cleanupHook();
        return;
      }
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
      lease.wireNonce = nonce;
      this.observedPaused.delete(pane.runtimeId);
      const armed = this.io.armAtomicPaneSnapshotCollector!(
        {
          nonce,
          runtimePaneId: pane.runtimeId,
          maxCaptureBytes: RECOVERY_CAPTURE_MAX_BYTES,
          maxCaptureLines: RECOVERY_CAPTURE_MAX_LINES,
          maxCursorBytes: RECOVERY_CURSOR_MAX_BYTES,
          observerCommandCount: safeObserver ? 2 : 0,
          dualCapture,
          onDrained: (reason) => {
            if (lease.wireNonce === nonce) lease.wireNonce = null;
            if (reason === "channel-exit") {
              lease.retry = false;
              return;
            }
            this.releaseSnapshotLease(lease);
          },
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
            const native = nativeCapture ? decodeNativeGridCapture(captureLines.join("\n")) : null;
            if (nativeCapture && (!native || !isNativeBootstrapCapture(native))) {
              if (nativeBootstrapUnsupported(true, captureLines, native)) {
                this.nativeBootstrapUnavailable = true;
                for (const { sub } of participants) sub.nativeBootstrap = false;
              }
              fail(result.statusObserved);
              return;
            }
            if (dualCapture && !result.ansiCaptureLines) {
              fail(result.statusObserved);
              return;
            }
            if (native) this.nativeBootstrapConfirmed = true;
            for (const { sub, epoch } of participants) {
              if (native && sub.nativeBootstrap) sub.feed.captureNativeReply(epoch, native);
              else sub.feed.captureReply(epoch, result.ansiCaptureLines ?? captureLines);
            }
            const probe = parseCursorProbe(result.cursorLine);
            const layoutSize = this.layoutCaptureSizeFor(participants[0]!.sub);
            const pendingLayout =
              pane.windowRuntimeId !== null && this.pendingLayoutOutput.has(pane.windowRuntimeId);
            if (
              !probe ||
              probe.y >= probe.rows ||
              (native && (native.cols !== probe.cols || native.rows !== probe.rows))
            ) {
              fail(result.statusObserved);
              return;
            }
            if (
              pendingLayout ||
              (layoutSize && (layoutSize.cols !== probe.cols || layoutSize.rows !== probe.rows))
            ) {
              this.awaitSnapshotLayout(recovery);
              fail(result.statusObserved);
              return;
            }
            const fallbackSize = this.layoutSizeFor(pane.runtimeId);
            this.observeSnapshotMetadata(pane, result.cursorLine!);
            const deliveries = participants.map(({ sub, epoch }) => ({
              sub,
              epoch,
              events: sub.feed
                .cursorReply(epoch, result.cursorLine!, fallbackSize)
                .map((event) =>
                  event.type === "seed" && sub.nativeBootstrap && !nativeCapture
                    ? { ...event, requiresNativeRecapture: true }
                    : event,
                ),
            }));
            if (!participantsExact() || deliveries.some(({ events }) => events.length === 0)) {
              fail(true);
              return;
            }
            let published = false;
            const publish = (): boolean => {
              if (published) return true;
              if (!participantsExact()) return false;
              published = stock.publish(
                deliveries.map(({ sub, events }) => ({ participant: sub, events })),
                () => {
                  if (!participantsExact()) throw new Error("snapshot lease retired");
                  return this.snapshotContext(pane);
                },
                (participant, event) => (participant as SubRecord).onEvent(event),
              );
              return published && participantsExact();
            };
            if (!deferPublish && !publish()) {
              fail(true);
              return;
            }
            settled = true;
            done({
              ok: true,
              fingerprint: null,
              publish,
              hold: () => {},
            });
          },
        },
        remaining,
      );
      if (!armed) {
        lease.wireNonce = null;
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
        if (settled || !this.snapshotLeaseCurrent(lease)) {
          cleanupHook();
          return;
        }
        if (!ownerReply.ok || !participantsExact()) {
          fail();
          return;
        }
        this.io.commandInline(
          `set-option -po -t ${pane.runtimeId} ${expectedName} ${tmuxSingleQuote(body)}`,
          (expectedReply) => {
            if (settled || !this.snapshotLeaseCurrent(lease)) {
              cleanupHook();
              return;
            }
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

  private convergeRecovery(pane: PaneRecord, recovery: RecoveryRecord): void {
    recovery.cancelCommandDeadline?.();
    recovery.cancelCommandDeadline = null;
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelNoProgressDeadline = null;
    recovery.cancelAbsoluteDeadline?.();
    recovery.cancelAbsoluteDeadline = null;
    this.recoveries.delete(recovery.runtimeId);
    recovery.retired = true;
    this.ledger.noteContinued(recovery.runtimeId);
    if (recovery.reason === "requested") this.ledger.clearRequest(recovery.runtimeId);
    for (const sub of pane.subs) {
      if (!sub.frozen && !sub.closed) {
        sub.feed.releaseQuarantine();
        try {
          sub.onEvent({ type: "flow", state: "resumed", reason: recovery.reason });
        } catch {
          // A consumer cannot strand shared snapshot admission for other panes.
        }
      }
    }
    this.observeRecovery(pane, recovery, "converged", null);
    if (recovery.lease) this.retireSnapshotLease(recovery.lease);
  }

  private restartRecoveryAfterOutputOverflow(pane: PaneRecord): void {
    const recovery = this.recoveries.get(pane.runtimeId);
    if (recovery) this.retrySnapshot(recovery);
    else this.beginLocalOverflowRecovery(pane);
  }

  private failRecovery(
    recovery: RecoveryRecord,
    failureReason: MirrorFlowRecoveryFailureReason,
  ): void {
    const pane = this.recoveryPane(recovery);
    if (!pane) return;
    recovery.cancelCommandDeadline?.();
    recovery.cancelCommandDeadline = null;
    recovery.cancelNoProgressDeadline?.();
    recovery.cancelNoProgressDeadline = null;
    recovery.cancelAbsoluteDeadline?.();
    recovery.cancelAbsoluteDeadline = null;
    recovery.retired = true;
    this.snapshotQueue.delete(recovery.runtimeId);
    this.recoveries.delete(recovery.runtimeId);
    for (const sub of pane.subs) sub.feed.abortCurrent();
    if (recovery.lease) this.retireSnapshotLease(recovery.lease);
    const collectorNonce = recovery.atomicCollectorNonce;
    recovery.atomicCollectorNonce = null;
    if (collectorNonce) this.io.retireAtomicPaneSnapshotCollector?.(collectorNonce, "retired");
    this.observeRecovery(pane, recovery, "nonconverged", failureReason);
    for (const sub of pane.subs) {
      sub.cancelCapture?.();
      if (sub.closed || sub.frozen) continue;
      try {
        sub.onEvent({ type: "fault", reason: "native-recovery-failed" });
      } catch {
        // A consumer must not prevent sibling subscribers from retiring.
      }
    }
  }

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
    sub.cancelCapture?.();
    const pane = sub.pane;
    pane.subs.delete(sub);
    const activeRecovery = this.recoveries.get(pane.runtimeId);
    if (
      activeRecovery &&
      [...pane.subs].some((candidate) => !candidate.closed && !candidate.frozen)
    )
      this.retrySnapshot(activeRecovery);
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

  private observeSnapshotMetadata(pane: PaneRecord, cursorLine: string): void {
    const fields = cursorLine.trim().split(/\s+/);
    const historySize = Number(fields[14]);
    if (Number.isSafeInteger(historySize) && historySize >= 0) pane.historySize = historySize;
    const value = fields[22];
    pane.scrollOnClear = value === "0" || value === "1" ? value === "1" : undefined;
  }

  private onNotify(name: string, rest: string): void {
    if (
      name === "window-add" ||
      name === "window-close" ||
      name === "unlinked-window-add" ||
      name === "unlinked-window-close" ||
      name === "session-renamed" ||
      name === "sessions-changed"
    )
      this.opts.onWindowTopologyChanged?.();
    if (name === "subscription-changed") {
      const policy =
        /^tmux-ide-scroll-on-clear\s+\$[0-9]+\s+@[0-9]+\s+[0-9]+\s+(%[0-9]+)\s+:\s+([01])\s*$/u.exec(
          rest,
        );
      if (policy) {
        const pane = this.panesByRuntime.get(policy[1]!);
        const enabled = policy[2] === "1";
        if (pane && pane.scrollOnClear !== enabled) {
          pane.scrollOnClear = enabled;
          // A pending capture already reads policy in its ordered cursor
          // probe. Cancelling it here can repeatedly retire opening recipes
          // while tmux delivers the initial sampled option notification.
          // Live feeds instead replace content and policy together.
          if (!this.recoveries.has(pane.runtimeId))
            for (const sub of pane.subs)
              if (!sub.closed && !sub.frozen && sub.feed.currentState() === "live")
                this.reseedPlain(sub);
        }
        return;
      }
      const history =
        /^tmux-ide-pane-history\s+\$[0-9]+\s+@[0-9]+\s+[0-9]+\s+(%[0-9]+)\s+:\s+([0-9]+)\s*$/u.exec(
          rest,
        );
      if (history) {
        const pane = this.panesByRuntime.get(history[1]!);
        const size = Number(history[2]);
        if (pane && Number.isSafeInteger(size)) {
          const cleared = size === 0 && (pane.historySize ?? 0) > 0;
          pane.historySize = size;
          // A quiet native clear writes no PTY bytes. Reuse the ordered seed path.
          if (cleared && !this.recoveries.has(pane.runtimeId)) {
            for (const sub of pane.subs) if (!sub.closed && !sub.frozen) this.reseedPlain(sub);
          }
        }
        return;
      }
    }
    const windowOptionHint =
      name === "subscription-changed"
        ? (/^tmux-ide-pane-borders\s+\$[0-9]+\s+(@[0-9]+)\s+[0-9]+\s+-\s*:\s*(?:top|bottom|off)\s*$/u.exec(
            rest,
          ) ??
          /^tmux-ide-copy-keys\s+\$[0-9]+\s+(@[0-9]+)\s+[0-9]+\s+-\s*:\s*(?:emacs|vi)\s*$/u.exec(
            rest,
          ))
        : null;
    if (windowOptionHint) {
      // Initial option samples from sibling windows are not evidence that this
      // pane's capture context changed. Unknown membership stays conservative.
      for (const pane of this.panesByRuntime.values())
        if (!pane.windowRuntimeId || pane.windowRuntimeId === windowOptionHint[1])
          pane.snapshotLayoutGeneration += 1;
      this.windowAuthorityOrdinal += 1;
      this.windowIdentityOrdinal += 1;
      this.scheduleSync();
      return;
    }
    if (
      name === "layout-change" ||
      name === "window-pane-changed" ||
      name === "session-window-changed" ||
      STRUCTURAL_NOTIFICATIONS.has(name)
    ) {
      this.windowAuthorityOrdinal += 1;
      // Structural and layout notifications remain conservative across all panes.
      for (const pane of this.panesByRuntime.values()) pane.snapshotLayoutGeneration += 1;
      if (name !== "layout-change") this.windowIdentityOrdinal += 1;
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
      this.observedPaused.add(runtime);
      const stockRecovery = this.recoveries.get(runtime);
      if (stockRecovery?.stock && stockRecovery.lease) {
        this.ledger.notePause(runtime);
        if (stockRecovery.stage !== "stock-pause") this.retrySnapshot(stockRecovery);
        return;
      }
      const nativeRecovery = this.recoveries.get(runtime);
      if (nativeRecovery) {
        this.ledger.notePause(runtime);
        if (nativeRecovery.stage !== "native-pause" && nativeRecovery.stage !== "queued")
          this.retrySnapshot(nativeRecovery);
        return;
      }
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
      this.observedPaused.delete(runtime);
      return;
    }
    if (name === "layout-change") {
      const change = parseLayoutChange(rest);
      if (!change) {
        this.windowIdentityOrdinal += 1;
        return;
      }
      const parsed = parseLayout(change.visible);
      if (!parsed) {
        this.windowIdentityOrdinal += 1;
        this.scheduleSync(); // never guess from a failed parse
        return;
      }
      this.layoutNotificationOrdinals.set(change.windowId, this.windowAuthorityOrdinal);
      for (const pane of this.panesByRuntime.values()) {
        if (pane.windowRuntimeId !== change.windowId) continue;
        const recovery = this.recoveries.get(pane.runtimeId);
        if (recovery?.lease && !recovery.lease.retired) {
          this.awaitSnapshotLayout(recovery);
          this.retrySnapshot(recovery);
        }
      }
      const pendingLayout = {
        ...parsed,
        zoomed: change.zoomed,
        unzoomed: parseLayout(change.layout) ?? undefined,
        rawLayout: change.layout,
      };
      const previousLayout =
        this.pendingLayoutOutput.get(change.windowId)?.layout ??
        this.layoutByWindow.get(change.windowId);
      if (
        !pendingLayout.unzoomed ||
        !previousLayout ||
        !layoutIdentitiesEqual(previousLayout, pendingLayout)
      )
        this.windowIdentityOrdinal += 1;
      // Resync on BOTH structural deltas: an unknown leaf (new pane) and a
      // known pane of this window missing from the leaves (a killed pane in a
      // surviving window emits only %layout-change — without this, its
      // subscribers never receive `closed`). Closure itself still comes only
      // from the truth reply; a probe failure never reads as absence.
      // Structural membership comes from the full tmux layout. Zoom only
      // changes visible geometry and must not look like sibling deletion.
      const membership = change.zoomed ? parseLayout(change.layout) : parsed;
      if (!membership) {
        this.scheduleSync();
        return;
      }
      const leafIds = new Set(membership.leaves.map((leaf) => leaf.id));
      const knownPaneVanished = [...this.panesByRuntime.values()].some(
        (pane) => pane.windowRuntimeId === change.windowId && !leafIds.has(pane.runtimeId),
      );
      if (
        membership.leaves.some((leaf) => !this.panesByRuntime.has(leaf.id)) ||
        knownPaneVanished
      ) {
        this.scheduleSync();
      }
      // %layout-change omits pane-border-status. Pairing fresh geometry with
      // the old cached option can reject every native capture after a border
      // change (for example 41 layout rows versus 40 content rows).
      // Keep the last qualified window visible in authority snapshots. A
      // pending option query is not evidence that the window disappeared.
      const held = this.pendingLayoutOutput.get(change.windowId);
      if (held) held.layout = pendingLayout;
      else
        this.pendingLayoutOutput.set(change.windowId, {
          layout: pendingLayout,
          bytes: 0,
          overflowed: false,
          records: [],
        });
      this.io.commandInline(
        `display-message -p -t ${change.windowId} "#{pane-border-status}"`,
        (reply) => {
          if (
            this.disposed ||
            this.pendingLayoutOutput.get(change.windowId)?.layout !== pendingLayout
          )
            return;
          const border = reply.lines[0];
          const window = this.windowsByRuntime.get(change.windowId);
          if (
            !reply.ok ||
            !window ||
            (border !== "top" && border !== "bottom" && border !== "off")
          ) {
            this.scheduleSync();
            return;
          }
          if (window.paneBorderStatus !== border) {
            // A query can observe an intermediate option between tmux's 1s
            // subscription samples. Reset its last-value cache so a return to
            // the previous value still produces a final authoritative refresh.
            this.io.send("refresh-client -B 'tmux-ide-pane-borders:@*:#{pane-border-status}'");
          }
          this.windowsByRuntime.set(change.windowId, { ...window, paneBorderStatus: border });
          this.layoutByWindow.set(change.windowId, pendingLayout);
          this.releasePendingLayout(change.windowId);
          this.emitLayoutAuthority();
        },
      );
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
      // The notification carries backing identity only; duplicate links require an index read.
      if (this.windowLinkAuthority) {
        this.scheduleSync();
        return;
      }
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

  private releasePendingLayout(windowRuntimeId: string, syncOrdinal?: number): void {
    const pending = this.pendingLayoutOutput.get(windowRuntimeId);
    this.pendingLayoutOutput.delete(windowRuntimeId);
    this.emitLayout(windowRuntimeId);
    for (const pane of this.panesByRuntime.values()) {
      if (pane.windowRuntimeId !== windowRuntimeId) continue;
      for (const sub of pane.subs) sub.resumeLayoutCapture?.(syncOrdinal);
    }
    if (pending?.overflowed) {
      for (const pane of this.panesByRuntime.values()) {
        if (pane.windowRuntimeId === windowRuntimeId) this.restartRecoveryAfterOutputOverflow(pane);
      }
    } else {
      for (const record of pending?.records ?? [])
        this.onOutput(record.pane, record.data, record.ageMs, record.timing);
    }
  }

  private emitLayout(windowRuntimeId: string): void {
    const event = this.layoutEventFor(windowRuntimeId);
    if (!event) return;
    for (const subscriber of this.layoutSubscribers) subscriber(event);
    for (const pane of this.panesByRuntime.values()) {
      if (pane.windowRuntimeId !== windowRuntimeId) continue;
      for (const sub of pane.subs) {
        if (!sub.closed && sub.onLayout)
          sub.onLayout(this.layoutEventFor(windowRuntimeId, pane.runtimeId) ?? event);
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
    const windowLinks = this.windowLinkAuthority?.snapshot();
    if (!windowLinks) return;
    const layouts = [...this.layoutByWindow.keys()]
      .map((runtimeId) => this.layoutEventFor(runtimeId))
      .filter((event): event is MirrorLayoutEvent => event !== null);
    subscriber({
      session: this.opts.session,
      runtimeSessionId,
      topologyEpoch: this.layoutTopologyEpoch,
      windowLinks,
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
    const event = this.layoutEventFor(windowRuntimeId, sub.pane.runtimeId);
    if (!sub.closed && event) sub.onLayout(event);
  }

  private layoutEventFor(
    windowRuntimeId: string,
    subscriberPane?: string,
  ): MirrorLayoutEvent | null {
    const visible = this.layoutByWindow.get(windowRuntimeId);
    if (!visible) return null;
    // Hidden terminal owners still need their real saved geometry to qualify
    // atomic seeds. Global layout subscribers receive only visible geometry.
    const layout =
      subscriberPane &&
      visible.zoomed &&
      visible.unzoomed &&
      !visible.leaves.some((leaf) => leaf.id === subscriberPane)
        ? { ...visible.unzoomed, zoomed: true }
        : visible;
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
      modeKeys: windowRecord?.modeKeys,
      panes: layout.leaves.map((leaf) => {
        const pane = this.panesByRuntime.get(leaf.id) ?? null;
        const display = pane
          ? resolvePaneDisplayName({
              hostName: TMUX_SERVER_HOSTNAME,
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
    const syncOrdinal = ++this.syncOrdinal;
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
    const previousCurrentWindow = this.currentWindow;
    const { listed, movedWindowRuntimeIds } = this.applyPaneTruth(truth);
    await this.syncWindows(
      this.opts.session,
      movedWindowRuntimeIds,
      previousCurrentWindow,
      syncOrdinal,
    );
    for (const pane of this.panesByRuntime.values()) {
      if (pane.windowRuntimeId && this.pendingLayoutOutput.has(pane.windowRuntimeId)) continue;
      for (const sub of pane.subs) sub.resumeLayoutCapture?.(syncOrdinal);
    }
    this.completedSyncOrdinal = Math.max(this.completedSyncOrdinal, syncOrdinal);
    this.drainSnapshots();
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
        if (pane.windowRuntimeId !== nextWindowRuntimeId) pane.snapshotLayoutGeneration += 1;
        pane.windowRuntimeId = nextWindowRuntimeId;
        continue;
      }
      this.cancelRecovery(runtime);
      this.panesByRuntime.delete(runtime);
      this.outputOrdinals.delete(runtime);
      this.panesBySemantic.delete(pane.semanticId);
      this.ledger.forget(runtime);
      this.ageByRuntime.delete(runtime);
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.cancelCapture?.();
          try {
            sub.onEvent({ type: "closed" });
          } catch {
            // Close every sibling and the transport even if a consumer throws.
          }
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
    const authorityOrdinal = this.windowIdentityOrdinal;
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
    const descriptorByPane = new Map<string, SessionPaneDescriptor>();
    for (const row of parsed.descriptors) {
      const previous = descriptorByPane.get(row.runtimePaneId);
      if (previous) {
        const comparable = (value: SessionPaneDescriptor) =>
          JSON.stringify({ ...value, windowActive: false, windowIndex: null });
        if (comparable(previous) !== comparable(row))
          throw new Error("Inconsistent linked pane observation");
        if (row.windowActive) descriptorByPane.set(row.runtimePaneId, row);
      } else descriptorByPane.set(row.runtimePaneId, row);
    }
    const descriptors = [...descriptorByPane.values()];
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
          pane.sessionWindowCount !== descriptors[0]!.sessionWindowCount,
      )
    ) {
      throw new Error(`trusted inventory for ${this.opts.session} has incomplete counts`);
    }
    const windowStage = await this.stageWindows(expectedRuntimeSessionId);
    const descriptorKeys = new Set<string>();
    for (const row of parsed.descriptors) {
      const link = windowStage.links.find((link) => link.index === row.windowIndex);
      const key = `${row.windowIndex}:${row.runtimePaneId}`;
      if (
        !link ||
        link.runtimeWindowId !== row.windowId ||
        link.active !== row.windowActive ||
        descriptorKeys.has(key)
      )
        throw new Error(
          `trusted inventory for ${this.opts.session} lacks verified identity: inconsistent linked pane membership`,
        );
      descriptorKeys.add(key);
    }
    for (const link of windowStage.links) {
      const count = computedWindowCounts.get(link.runtimeWindowId)!;
      if (parsed.descriptors.filter((row) => row.windowIndex === link.index).length !== count)
        throw new Error("Incomplete linked pane membership");
    }
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
      !this.windowStageIdentitiesEqual(windowStage, confirmedWindowStage) ||
      authorityOrdinal !== this.windowIdentityOrdinal
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
      const membership = layout.zoomed ? layout.unzoomed : layout;
      if (!membership || membership.leaves.length !== computedWindowCounts.get(runtimeWindowId)) {
        stagedPaneMembershipExact = false;
        break;
      }
      for (const leaf of membership.leaves) {
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
      confirmedWindowStage.links.length !== descriptors[0]!.sessionWindowCount ||
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
    const sessionWindowCount = confirmedWindowStage.links.length;
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
        ...(descriptor.nameSource ? { nameSource: descriptor.nameSource } : {}),
        type: descriptor.type,
        missionStamp: descriptor.missionStamp,
        nativePaneBirthId: descriptor.nativePaneBirthId ?? null,
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
    previousCurrentWindow = this.currentWindow,
    syncOrdinal?: number,
  ): Promise<boolean> {
    const stage = await this.stageWindows(target).catch((error) => {
      this.windowLinkAuthority?.invalidate();
      this.latestWindowStage = null;
      throw error;
    });
    this.commitWindowStage(stage, requiredLayoutEmits, previousCurrentWindow, syncOrdinal);
    return stage.repairedIdentity;
  }

  private commitWindowStage(
    stage: WindowSyncStage,
    requiredLayoutEmits: ReadonlySet<string> = new Set(),
    previousCurrentWindow = this.currentWindow,
    syncOrdinal?: number,
  ): void {
    // Control notifications in the same read chunk run before a promise-based
    // inventory read resumes. Preserve newer geometry (and its pending border
    // query) rather than letting that older inventory erase the notification.
    const newerLayouts = new Set(
      [...this.layoutNotificationOrdinals]
        .filter(([, ordinal]) => ordinal > stage.observedAuthorityOrdinal)
        .map(([runtimeId]) => runtimeId),
    );
    if (newerLayouts.size > 0) {
      stage = { ...stage, windows: new Map(stage.windows), layouts: new Map(stage.layouts) };
      for (const runtimeId of newerLayouts) {
        const currentLayout = this.layoutByWindow.get(runtimeId);
        const currentWindow = this.windowsByRuntime.get(runtimeId);
        const stagedWindow = stage.windows.get(runtimeId);
        if (currentLayout && currentWindow && stagedWindow) {
          stage.layouts.set(runtimeId, currentLayout);
          stage.windows.set(runtimeId, {
            ...stagedWindow,
            paneBorderStatus: currentWindow.paneBorderStatus,
          });
        }
      }
    }
    this.windowLinkAuthority?.reconcile(stage.links);
    this.latestWindowStage = stage;
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
        previous.modeKeys !== record.modeKeys ||
        !previousLayout ||
        previousLayout.zoomed !== nextLayout.zoomed ||
        JSON.stringify(previousLayout.unzoomed) !== JSON.stringify(nextLayout.unzoomed) ||
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
    for (const runtimeId of this.fittedWindows.keys())
      if (!stage.windows.has(runtimeId)) this.fittedWindows.delete(runtimeId);
    this.windowsByRuntime.clear();
    for (const [key, value] of stage.windows) this.windowsByRuntime.set(key, value);
    this.layoutByWindow.clear();
    for (const [key, value] of stage.layouts) this.layoutByWindow.set(key, value);
    const layoutEmits = windowSetChanged
      ? new Set(stage.windows.keys())
      : new Set(
          [...changedWindows, ...requiredLayoutEmits, ...this.pendingLayoutOutput.keys()].filter(
            (runtimeId) => stage.windows.has(runtimeId),
          ),
        );
    for (const runtimeId of this.pendingLayoutOutput.keys())
      if (!stage.windows.has(runtimeId) && !newerLayouts.has(runtimeId))
        this.pendingLayoutOutput.delete(runtimeId);
    for (const runtimeId of this.layoutNotificationOrdinals.keys())
      if (!stage.windows.has(runtimeId) && !newerLayouts.has(runtimeId))
        this.layoutNotificationOrdinals.delete(runtimeId);
    for (const runtimeId of layoutEmits)
      if (!newerLayouts.has(runtimeId) || !this.pendingLayoutOutput.has(runtimeId))
        this.releasePendingLayout(runtimeId, syncOrdinal);
    this.emitLayoutAuthority();
  }

  // Inventory establishes pane/window identity, not a frozen terminal size.
  // Native resize notifications independently publish geometry. Requiring two
  // identical sizes here makes continuous dragging exhaust the inventory retry
  // and revoke otherwise unchanged window links, stalling layout publication.
  private windowStageIdentitiesEqual(left: WindowSyncStage, right: WindowSyncStage): boolean {
    if (
      JSON.stringify(left.links) !== JSON.stringify(right.links) ||
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
        leftWindow.modeKeys !== rightWindow.modeKeys ||
        !layoutIdentitiesEqual(leftLayout, rightLayout)
      ) {
        return false;
      }
    }
    return true;
  }

  private async stageWindows(target = this.opts.session): Promise<WindowSyncStage> {
    const observedAuthorityOrdinal = this.windowAuthorityOrdinal;
    const lines = await this.io.request(
      `list-windows -t "${target}" -F "#{window_id}\t#{qa:@tmux_ide_window_id}\t#{qa:window_name}\t#{window_active}\t#{window_visible_layout}\t#{?window_zoomed_flag,1,0}\t#{pane-border-status}\t#{window_layout}\t#{mode-keys}\t#{window_index}"`,
    );
    if (lines.length > WINDOW_LINK_MAX_LINKS)
      throw new Error("Window link observation exceeds bound");
    interface Row {
      index: number;
      runtimeId: string;
      stamp: string | null;
      name: string | null;
      active: boolean;
      visible: string;
      full: string;
      zoomed: boolean;
      paneBorderStatus: "top" | "bottom" | "off";
      modeKeys?: "emacs" | "vi";
    }
    const rows: Row[] = [];
    const seenIndexes = new Set<number>();
    for (const raw of lines) {
      // Replies are latin1 byte strings; recover UTF-8 window names first.
      const line = Buffer.from(raw, "latin1").toString("utf8");
      const parts = line.split("\t");
      if (parts.length !== 10) {
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
        full = visible,
        modeKeys,
        indexRaw = "",
      ] = parts;
      const index = Number(indexRaw);
      if (
        !/^@[0-9]+$/u.test(runtimeId) ||
        !/^(?:0|[1-9][0-9]*)$/u.test(indexRaw) ||
        !Number.isSafeInteger(index) ||
        seenIndexes.has(index) ||
        (active !== "0" && active !== "1") ||
        (zoomed !== "0" && zoomed !== "1") ||
        (borderStatus !== "top" && borderStatus !== "bottom" && borderStatus !== "off") ||
        (modeKeys !== undefined && modeKeys !== "emacs" && modeKeys !== "vi")
      ) {
        throw new Error(`window layout truth for ${this.opts.session} is malformed`);
      }
      seenIndexes.add(index);
      const stamp = decodeTmuxArgument(stampRaw);
      const name = decodeTmuxArgument(nameRaw);
      rows.push({
        index,
        runtimeId,
        stamp: stamp.length > 0 ? stamp : null,
        name: name.length > 0 ? name : null,
        active: active === "1",
        visible,
        full,
        zoomed: zoomed === "1",
        paneBorderStatus: borderStatus,
        modeKeys,
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
    const backingRows = new Map<string, Row>();
    for (const row of rows) {
      const previous = backingRows.get(row.runtimeId);
      if (
        previous &&
        (previous.stamp !== row.stamp ||
          previous.name !== row.name ||
          previous.visible !== row.visible ||
          previous.full !== row.full ||
          previous.zoomed !== row.zoomed ||
          previous.paneBorderStatus !== row.paneBorderStatus ||
          previous.modeKeys !== row.modeKeys)
      )
        throw new Error("Inconsistent linked backing observation");
      backingRows.set(row.runtimeId, row);
    }
    const nextLayoutByWindow = new Map<string, WindowLayout>();
    for (const row of backingRows.values()) {
      const parsed = parseLayout(row.visible);
      if (!parsed) {
        throw new Error(`window layout truth for ${this.opts.session} is malformed`);
      }
      const unzoomed = parseLayout(row.full);
      if (!unzoomed) throw new Error(`full window layout for ${this.opts.session} is malformed`);
      nextLayoutByWindow.set(row.runtimeId, {
        ...parsed,
        zoomed: row.zoomed,
        unzoomed,
        rawLayout: row.full,
      });
    }
    // Publish validated physical membership before any identity repair writes.
    // The receiving session may introduce duplicate stamps by linking a window.
    this.opts.onWindowMembership?.([...backingRows.keys()]);
    await this.opts.beforeIdentityRepair?.();
    // Valid unique stamps are identity; missing/invalid/duplicated stamps are
    // ALL regenerated and stamped back (the pane policy, applied to windows).
    const stampCounts = new Map<string, number>();
    for (const row of backingRows.values()) {
      if (row.stamp && WorkspaceIdSchemaZ.safeParse(row.stamp).success) {
        stampCounts.set(row.stamp, (stampCounts.get(row.stamp) ?? 0) + 1);
      }
    }
    const claimed = new Set(stampCounts.keys());
    const generateWindowId = this.opts.generateWindowId ?? defaultMirrorWindowId;
    let repairedIdentity = false;
    const next = new Map<string, WindowRecord>();
    const nextCurrentWindow = activeRows[0]!.runtimeId;
    for (const row of backingRows.values()) {
      let semanticId: string | null = null;
      if (row.stamp && stampCounts.get(row.stamp) === 1) {
        semanticId = row.stamp;
      } else if (!this.opts.hasSharedWindowConflict?.()) {
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
        modeKeys: row.modeKeys,
      });
    }
    return {
      observedAuthorityOrdinal,
      windows: next,
      layouts: nextLayoutByWindow,
      currentWindow: nextCurrentWindow,
      repairedIdentity,
      links: rows.map((row) => ({
        index: row.index,
        runtimeWindowId: row.runtimeId,
        semanticWindowId: next.get(row.runtimeId)!.semanticId ?? "",
        active: row.active,
      })),
    };
  }

  private async reconcileIdentity(
    descriptors: readonly SessionPaneDescriptor[],
    listed: ReadonlySet<string>,
  ): Promise<boolean> {
    if (this.disposed) return false;
    if (this.opts.hasSharedWindowConflict?.()) {
      this.settleFirstJoin();
      return false;
    }
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
        this.panesByRuntime.delete(retiredRuntime);
        this.outputOrdinals.delete(retiredRuntime);
        this.ledger.forget(retiredRuntime);
        existingBySemantic.runtimeId = verified.runtimePaneId;
        existingBySemantic.incarnation = ++this.paneIncarnation;
        existingBySemantic.descriptor = descriptor;
        existingBySemantic.active = verified.active;
        if (existingBySemantic.windowRuntimeId !== windowRuntimeId)
          existingBySemantic.snapshotLayoutGeneration += 1;
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
        if (existingByRuntime.windowRuntimeId !== windowRuntimeId)
          existingByRuntime.snapshotLayoutGeneration += 1;
        existingByRuntime.windowRuntimeId = windowRuntimeId;
        continue;
      }
      if (existingByRuntime) {
        // The runtime address was restamped to a new identity (duplicate
        // resolution). The old semantic id is gone.
        this.panesBySemantic.delete(existingByRuntime.semanticId);
        this.cancelRecovery(existingByRuntime.runtimeId);
        this.ledger.forget(existingByRuntime.runtimeId);
        this.outputOrdinals.delete(existingByRuntime.runtimeId);
        for (const sub of existingByRuntime.subs) {
          if (sub.closed) continue;
          sub.closed = true;
          sub.cancelCapture?.();
          sub.feed.abortCurrent();
          try {
            sub.onEvent({ type: "closed" });
          } catch {
            // Close every sibling and the transport even if a consumer throws.
          }
        }
        existingByRuntime.subs.clear();
        existingByRuntime.incarnation = ++this.paneIncarnation;
        existingByRuntime.semanticId = verified.semanticPaneId;
        existingByRuntime.descriptor = descriptor;
        existingByRuntime.active = verified.active;
        if (existingByRuntime.windowRuntimeId !== windowRuntimeId)
          existingByRuntime.snapshotLayoutGeneration += 1;
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
        snapshotLayoutGeneration: 0,
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
    layouts: ReadonlyMap<string, WindowLayout>,
  ): Promise<boolean> {
    if (this.opts.hasSharedWindowConflict?.())
      throw new Error(
        "Linked windows across controlled sessions are unsupported. Unlink the shared window before controlling this session.",
      );
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
    this.snapshotActive?.cancelFence?.();
    this.snapshotActive = null;
    this.snapshotQueue.clear();
    for (const recovery of this.recoveries.values()) recovery.lease = undefined;
    this.opts.ownedViewer?.dispose();
    this.windowLinkAuthority?.dispose();
    this.nativeGrid.dispose();
    this.settleFirstJoin();
    for (const runtime of [...this.recoveries.keys()]) this.cancelRecovery(runtime);
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.cancelCapture?.();
          try {
            sub.onEvent({ type: "closed" });
          } catch {
            // Close every sibling and the transport even if a consumer throws.
          }
        }
      }
      pane.subs.clear();
    }
    this.opts.onExit?.();
  }
}
