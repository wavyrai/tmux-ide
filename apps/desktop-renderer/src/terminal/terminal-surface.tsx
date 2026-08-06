import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentGeometryOwnership,
  type TerminalAttachmentSemanticTarget,
  type TerminalAttachmentViewport,
} from "@tmux-ide/contracts";
import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import {
  isNativeTerminalOutput,
  validateNativeTerminalRequest,
  validateNativeTerminalViewport,
  type NativeTerminalAttachment,
  type NativeTerminalEvent,
  type NativeTerminalTransport,
  type NativeTerminalTransportError,
} from "./native-terminal-transport.ts";
import { WidgetSurface } from "./widgets/widget-surface.tsx";
import { createWidgetMarkerByteWatcher, detectWidgetMarker } from "@tmux-ide/contracts";
import { resolveWidget, type WidgetResolution } from "./widgets/widget-registry.ts";
import { WIDGET_SCAN_MAX_ROWS } from "./widgets/xterm-cell-rows.ts";
import type { TerminalRenderer, TerminalRendererFactory } from "./xterm-renderer.ts";

export type TerminalSurfacePhase =
  | "unavailable"
  | "measuring"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * Renderer-local first-attach milestones (m50 follow-up #169).
 *
 * These are deliberately NOT part of the daemon/attachment wire contract.
 * They name what this surface can prove happened, and are exposed as bounded
 * data attributes so browser failure artifacts identify the stalled boundary
 * without leaking a ticket, daemon address, or private tmux identity.
 */
export type TerminalSurfaceAttachPhase =
  | "unavailable"
  | "renderer-loading"
  | "renderer-ready"
  | "waiting-for-viewport"
  | "attach-requested"
  | "transport-ready"
  | "attachment-ready"
  | "awaiting-first-output"
  | "first-output-received"
  | "painting-first-frame"
  | "live"
  | "disconnected"
  | "failed";

interface TerminalSurfaceAttachTraceEntry {
  readonly phase: TerminalSurfaceAttachPhase;
  /** Monotonic milliseconds since this attach attempt began. */
  readonly atMs: number;
}

const ATTACH_PHASE_RANK: Readonly<Record<TerminalSurfaceAttachPhase, number>> = Object.freeze({
  unavailable: 0,
  "renderer-loading": 1,
  "renderer-ready": 2,
  "waiting-for-viewport": 3,
  "attach-requested": 4,
  "transport-ready": 5,
  "attachment-ready": 6,
  "awaiting-first-output": 7,
  "first-output-received": 8,
  "painting-first-frame": 9,
  live: 10,
  disconnected: 11,
  failed: 11,
});

const MAX_ATTACH_TRACE_ENTRIES = 16;

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/**
 * Provisional viewport for a size-passive attach (m41 attach-5). The origin
 * window is attached size-passive (`-f ignore-size`), so tmux discards the
 * client viewport when sizing the window; the request only needs a valid grid.
 * The window's real grid arrives on the connected/geometry event and drives the
 * renderer through {@link TerminalRenderer.resizeGrid}.
 */
const SIZE_PASSIVE_CONNECT_VIEWPORT: TerminalAttachmentViewport = { cols: 80, rows: 24 };

const MAX_PENDING_OUTPUT_WRITES = 64;
const OUTPUT_WRITE_TIMEOUT_MS = 15_000;
const MAX_PENDING_INPUT_WRITES = 64;
const MAX_PENDING_INPUT_BYTES = 256 * 1024;

/**
 * How long writes are allowed to accumulate before the grid is scanned for a
 * widget marker. A marker arrives as one burst of output, so coalescing costs
 * the user nothing visible and saves a full-buffer scan per chunk.
 */
const WIDGET_SCAN_DEBOUNCE_MS = 40;

export interface TerminalSurfaceProps {
  readonly target: TerminalAttachmentSemanticTarget;
  readonly title: string;
  readonly transport?: NativeTerminalTransport | null;
  readonly focused?: boolean;
  readonly reducedMotion?: boolean;
  readonly themeKey?: string;
  readonly onFocus?: (source: "keyboard" | "mouse") => void;
  readonly rendererFactory?: TerminalRendererFactory;
  /**
   * Who decides how big the origin tmux window is (m50.2, gap 1).
   *
   * `passive` (the default) renders the origin window's own grid and letterboxes
   * the remainder: DOM measurements never reflow tmux, the renderer is sized
   * from the transport-reported window grid, and the surface centers it inside
   * the card. Every mirror and every read-only viewer stays here.
   *
   * `owner` measures the card, floors it into whole cells, and drives tmux to
   * match through the attachment's resize path — so the window IS the card and
   * there is no letterbox. The daemon has attached this client without
   * `-f ignore-size` for exactly that purpose; the contract carries the same
   * word, and the interactive lease's per-window exclusivity is what keeps two
   * owners from fighting.
   */
  readonly geometryOwnership?: TerminalAttachmentGeometryOwnership;
}

/**
 * How long the surface waits before asking tmux for a new size.
 *
 * A window drag produces a resize event per frame, and each one is a serialized
 * daemon round trip that makes tmux re-tile every pane and repaint every client
 * watching. Coalescing to the settled size costs the user nothing they can see —
 * the grid is repainted by tmux either way — and spares the multiplexer a
 * re-tile per frame of a drag.
 */
const OWNED_RESIZE_DEBOUNCE_MS = 150;

function sameViewport(
  left: TerminalAttachmentViewport | null,
  right: TerminalAttachmentViewport,
): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

function usableViewport(
  value: TerminalAttachmentViewport | null,
): TerminalAttachmentViewport | null {
  if (!value) return null;
  const parsed = TerminalAttachmentViewportSchemaZ.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validatedTransportReason(value: string): string {
  const reason = value.trim();
  const hasControlCharacter = [...reason].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (reason.length === 0 || reason.length > 240 || hasControlCharacter) {
    return "The native terminal transport reported an invalid error.";
  }
  return reason;
}

/**
 * A window-keyed interactive lease from a prior attach releases only after its
 * grace/ticket window, so an immediate re-attach honestly conflicts rather than
 * fails. Name that to the user instead of surfacing the raw daemon reason.
 */
function connectFailureMessage(error: NativeTerminalTransportError): string {
  if (error.code === "interactive-viewer-conflict") {
    return "This terminal's previous session is still releasing. Wait a few seconds, then try again.";
  }
  return validatedTransportReason(error.reason);
}

interface OutputEpoch {
  readonly retired: Promise<void>;
  readonly retire: () => void;
  pending: number;
}

interface InputEpoch {
  readonly queue: Uint8Array[];
  retired: boolean;
  inFlight: boolean;
  inFlightBytes: number;
  pendingEntries: number;
  pendingBytes: number;
}

function outputEpoch(): OutputEpoch {
  let retire = (): void => undefined;
  const retired = new Promise<void>((resolve) => {
    retire = resolve;
  });
  return { retired, retire, pending: 0 };
}

function inputEpoch(): InputEpoch {
  return {
    queue: [],
    retired: false,
    inFlight: false,
    inFlightBytes: 0,
    pendingEntries: 0,
    pendingBytes: 0,
  };
}

const OUTPUT_NOT_CONSUMED = new Error("Terminal output was not consumed by the renderer.");

/**
 * Native Solid terminal leaf. This component renders bytes and forwards input;
 * it never creates a process, resolves a tmux target, or opens a network path.
 */
export function TerminalSurface(props: TerminalSurfaceProps) {
  /**
   * The render consequence of ownership, named once.
   *
   * Passive is the default so an omitted prop is the harmless behavior: a
   * surface that forgot to declare itself cannot silently start reflowing a
   * window other clients are attached to.
   */
  const ownsGeometry = (): boolean => props.geometryOwnership === "owner";
  const sizePassive = (): boolean => !ownsGeometry();
  const [phase, setPhase] = createSignal<TerminalSurfacePhase>(
    props.transport ? "measuring" : "unavailable",
  );
  const initialAttachPhase: TerminalSurfaceAttachPhase = props.transport
    ? "renderer-loading"
    : "unavailable";
  const [attachPhase, setAttachPhase] =
    createSignal<TerminalSurfaceAttachPhase>(initialAttachPhase);
  const [attachTrace, setAttachTrace] = createSignal<readonly TerminalSurfaceAttachTraceEntry[]>([
    { phase: initialAttachPhase, atMs: 0 },
  ]);
  const [attachAttempt, setAttachAttempt] = createSignal(props.transport ? 1 : 0);
  const [reason, setReason] = createSignal<string | null>(null);
  const [hasValidatedFrame, setHasValidatedFrame] = createSignal(false);
  const [sourceGrid, setSourceGrid] = createSignal<TerminalAttachmentViewport | null>(null);
  const [clientViewport, setClientViewport] = createSignal<TerminalAttachmentViewport | null>(null);
  const [widget, setWidget] = createSignal<WidgetResolution | null>(null);
  let mount: HTMLDivElement | undefined;
  let renderer: TerminalRenderer | null = null;
  let attachment: NativeTerminalAttachment | null = null;
  let observer: ResizeObserver | null = null;
  let inputSubscription: { dispose(): void } | null = null;
  let animationFrame: number | null = null;
  let disposed = false;
  let generation = 0;
  let activeInputEpoch = inputEpoch();
  let outputTail = Promise.resolve();
  let activeOutputEpoch = outputEpoch();
  let observedTarget = `${props.target.workspaceName}\0${props.target.semanticPaneId}`;
  let observedTransport = props.transport;
  let currentViewport: TerminalAttachmentViewport | null = null;
  let latestMeasuredViewport: TerminalAttachmentViewport | null = null;
  let pendingResize: TerminalAttachmentViewport | null = null;
  let resizeFlight: Promise<void> | null = null;
  let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  /** True until the first owned resize has been sent, so that one goes at once. */
  let resizeSettled = true;
  let pointerFocus = false;
  let rendererLoadGeneration = 0;
  let markerWatcher = createWidgetMarkerByteWatcher();
  let widgetScan: ReturnType<typeof setTimeout> | null = null;
  let attachTraceStartedAt = monotonicNow();

  /**
   * Record each milestone once, but never let a late callback move the visible
   * diagnostic backwards. Early output is legal: the transport listener can
   * consume the seed before connect() resolves with its attachment handle.
   */
  const recordAttachPhase = (next: TerminalSurfaceAttachPhase): void => {
    const currentTrace = attachTrace();
    if (!currentTrace.some((entry) => entry.phase === next)) {
      const entry = {
        phase: next,
        atMs: Math.max(0, Math.round(monotonicNow() - attachTraceStartedAt)),
      } satisfies TerminalSurfaceAttachTraceEntry;
      setAttachTrace([...currentTrace, entry].slice(-MAX_ATTACH_TRACE_ENTRIES));
    }
    if (ATTACH_PHASE_RANK[next] >= ATTACH_PHASE_RANK[attachPhase()]) setAttachPhase(next);
  };

  const resetAttachTrace = (available: boolean): void => {
    attachTraceStartedAt = monotonicNow();
    const next: TerminalSurfaceAttachPhase = available ? "renderer-loading" : "unavailable";
    setAttachPhase(next);
    setAttachTrace([{ phase: next, atMs: 0 }]);
    setAttachAttempt((attempt) => attempt + 1);
  };

  /**
   * Read the grid and decide what this pane is showing (m49.7).
   *
   * Runs after the emulator has committed the write, because cells — not bytes
   * — are where a wrapped marker line exists as one logical line.
   */
  const scanForWidget = (): void => {
    widgetScan = null;
    const active = renderer;
    if (disposed || !active) return;
    const marker = detectWidgetMarker(active.readCellRows(WIDGET_SCAN_MAX_ROWS));
    setWidget(marker ? resolveWidget(marker) : null);
  };

  const scheduleWidgetScan = (): void => {
    if (disposed || widgetScan !== null) return;
    widgetScan = setTimeout(scanForWidget, WIDGET_SCAN_DEBOUNCE_MS);
  };

  const cancelWidgetScan = (): void => {
    if (widgetScan !== null) clearTimeout(widgetScan);
    widgetScan = null;
  };

  /**
   * Should this write trigger a scan?
   *
   * Two reasons it might. Either the bytes carry the sentinel token, or a widget
   * is ALREADY showing — in which case every write is a candidate for taking it
   * away, since the Ctrl-C path clears the screen and the marker simply stops
   * existing. Without the second case a pane could never stop being a widget.
   */
  const widgetScanCandidate = (bytes: Uint8Array): boolean =>
    markerWatcher.observe(bytes) || widget() !== null;

  /** The pane's widget identity for the DOM: a widget id, "invalid", or absent. */
  const widgetTag = (): string | undefined => {
    const resolution = widget();
    if (!resolution) return undefined;
    return resolution.status === "ready" ? resolution.definition.id : "invalid";
  };

  const resetWidgetState = (): void => {
    cancelWidgetScan();
    markerWatcher = createWidgetMarkerByteWatcher();
    setWidget(null);
  };

  const retireInput = (): void => {
    const epoch = activeInputEpoch;
    epoch.retired = true;
    epoch.queue.length = 0;
    epoch.pendingEntries = epoch.inFlight ? 1 : 0;
    epoch.pendingBytes = epoch.inFlightBytes;
    activeInputEpoch = inputEpoch();
  };

  const retireOutput = (): void => {
    activeOutputEpoch.retire();
    activeOutputEpoch = outputEpoch();
    outputTail = Promise.resolve();
  };

  const safelyDispose = (active: NativeTerminalAttachment): void => {
    try {
      active.dispose();
    } catch {
      // A broken host cleanup cannot revive or retain renderer authority.
    }
  };

  const disposeAttachment = (): void => {
    const active = attachment;
    attachment = null;
    if (resizeDebounce !== null) clearTimeout(resizeDebounce);
    resizeDebounce = null;
    resizeSettled = true;
    pendingResize = null;
    resizeFlight = null;
    retireInput();
    retireOutput();
    if (active) safelyDispose(active);
  };

  const disposeRenderer = (): void => {
    rendererLoadGeneration += 1;
    resetWidgetState();
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    const activeObserver = observer;
    observer = null;
    try {
      activeObserver?.disconnect();
    } catch {
      // A stale observer cannot retain renderer ownership after invalidation.
    }
    const activeInputSubscription = inputSubscription;
    inputSubscription = null;
    try {
      activeInputSubscription?.dispose();
    } catch {
      // A stale input callback is generation-gated even if teardown is broken.
    }
    const activeRenderer = renderer;
    renderer = null;
    try {
      activeRenderer?.dispose();
    } catch {
      // Renderer teardown is best-effort; authority has already been retired.
    }
    try {
      mount?.replaceChildren();
    } catch {
      // The replacement renderer still receives a fresh generation and instance.
    }
  };

  const flushResize = (): void => {
    if (!attachment || !pendingResize || resizeFlight || disposed) return;
    const next = pendingResize;
    pendingResize = null;
    const activeAttachment = attachment;
    const operation = activeAttachment
      .resize(validateNativeTerminalViewport(next))
      .then((result) => {
        if (result.status !== "error" || disposed || attachment !== activeAttachment) {
          return;
        }
        setReason(validatedTransportReason(result.error.reason));
        setPhase("error");
        recordAttachPhase("failed");
        generation += 1;
        disposeAttachment();
      })
      .catch(() => {
        if (disposed || attachment !== activeAttachment) return;
        setReason("The desktop host could not resize this terminal.");
        setPhase("error");
        recordAttachPhase("failed");
        generation += 1;
        disposeAttachment();
      })
      .finally(() => {
        if (resizeFlight === operation) resizeFlight = null;
        flushResize();
      });
    resizeFlight = operation;
  };

  const queueOutput = (bytes: Uint8Array, activeGeneration: number): Promise<void> => {
    const activeRenderer = renderer;
    const epoch = activeOutputEpoch;
    if (!activeRenderer || epoch.pending >= MAX_PENDING_OUTPUT_WRITES) {
      setReason("The terminal renderer could not keep up with the native output stream.");
      setPhase("error");
      recordAttachPhase("failed");
      generation += 1;
      disposeAttachment();
      return Promise.reject(OUTPUT_NOT_CONSUMED);
    }
    epoch.pending += 1;
    const payload = bytes.slice();
    const scanAfterWrite = widgetScanCandidate(payload);
    const operation = outputTail
      .catch(() => undefined)
      .then(async () => {
        if (
          disposed ||
          generation !== activeGeneration ||
          renderer !== activeRenderer ||
          epoch !== activeOutputEpoch
        ) {
          throw OUTPUT_NOT_CONSUMED;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            activeRenderer.write(payload).then(() => "written" as const),
            epoch.retired.then(() => "retired" as const),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("terminal renderer write timed out")),
                OUTPUT_WRITE_TIMEOUT_MS,
              );
            }),
          ]);
          if (outcome === "retired") throw OUTPUT_NOT_CONSUMED;
          if (scanAfterWrite) scheduleWidgetScan();
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      })
      .catch(() => {
        const retiredOrStale =
          disposed ||
          generation !== activeGeneration ||
          renderer !== activeRenderer ||
          epoch !== activeOutputEpoch;
        if (!retiredOrStale) {
          setReason("The terminal renderer could not consume native output.");
          setPhase("error");
          recordAttachPhase("failed");
          generation += 1;
          disposeAttachment();
        }
        throw OUTPUT_NOT_CONSUMED;
      })
      .finally(() => {
        epoch.pending -= 1;
      });
    outputTail = operation;
    return operation;
  };

  const handleEvent = (
    event: NativeTerminalEvent,
    activeGeneration: number,
  ): void | Promise<void> => {
    if (disposed || activeGeneration !== generation) {
      return event.type === "output" ? Promise.reject(OUTPUT_NOT_CONSUMED) : undefined;
    }
    if (isNativeTerminalOutput(event)) {
      if (!hasValidatedFrame()) {
        recordAttachPhase("first-output-received");
        recordAttachPhase("painting-first-frame");
      }
      return queueOutput(event.bytes, activeGeneration).then(() => {
        if (!disposed && activeGeneration === generation) {
          setHasValidatedFrame(true);
          recordAttachPhase("live");
        }
      });
    }
    if (event.type === "geometry") {
      currentViewport = event.clientViewport;
      setSourceGrid(event.sourceGrid);
      setClientViewport(event.clientViewport);
      if (sizePassive()) {
        // Size-passive card: mirror the origin window's grid; never resize tmux.
        renderer?.resizeGrid(event.sourceGrid);
        return;
      }
      const measured = latestMeasuredViewport;
      if (attachment && measured && !sameViewport(event.clientViewport, measured)) {
        pendingResize = measured;
        flushResize();
      }
      return;
    }
    if (event.type !== "state") return;
    if (event.state === "connected") {
      recordAttachPhase("transport-ready");
      currentViewport = event.clientViewport;
      setSourceGrid(event.sourceGrid);
      setClientViewport(event.clientViewport);
      if (attachment) {
        setReason(null);
        setPhase("connected");
        if (!hasValidatedFrame()) recordAttachPhase("awaiting-first-output");
        if (sizePassive()) {
          // Size-passive card: mirror the origin window's grid; never resize tmux.
          renderer?.resizeGrid(event.sourceGrid);
          return;
        }
        const measured = latestMeasuredViewport;
        if (measured && !sameViewport(event.clientViewport, measured)) {
          pendingResize = measured;
          flushResize();
        }
      }
      return;
    }
    setReason(
      event.error
        ? validatedTransportReason(event.error.reason)
        : "The native tmux attachment closed.",
    );
    setPhase("disconnected");
    recordAttachPhase("disconnected");
    generation += 1;
    disposeAttachment();
  };

  const failConnect = (message: string, activeGeneration: number): void => {
    if (disposed || activeGeneration !== generation) return;
    generation += 1;
    disposeAttachment();
    setReason(message);
    setPhase("error");
    recordAttachPhase("failed");
  };

  const connect = (viewport: TerminalAttachmentViewport): void => {
    if (!props.transport || attachment || phase() === "connecting" || disposed) return;
    const activeGeneration = ++generation;
    setReason(null);
    setPhase("connecting");
    recordAttachPhase("attach-requested");
    let request: TerminalAttachRequest;
    try {
      request = validateNativeTerminalRequest({
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        target: props.target,
        viewerMode: "interactive",
        geometryOwnership: props.geometryOwnership ?? "passive",
        viewport,
      });
    } catch {
      failConnect("The semantic terminal target or viewport is invalid.", activeGeneration);
      return;
    }
    void props.transport
      .connect(request, (event) => handleEvent(event, activeGeneration))
      .then((result) => {
        if (disposed || activeGeneration !== generation) {
          if (result.status === "connected") {
            safelyDispose(result.attachment);
          }
          return;
        }
        if (result.status === "error") {
          failConnect(connectFailureMessage(result.error), activeGeneration);
          return;
        }
        attachment = result.attachment;
        setPhase("connected");
        recordAttachPhase("attachment-ready");
        if (!hasValidatedFrame()) recordAttachPhase("awaiting-first-output");
        const latestViewport = latestMeasuredViewport;
        if (currentViewport && latestViewport && !sameViewport(currentViewport, latestViewport)) {
          pendingResize = latestViewport;
          flushResize();
        }
        if (props.focused) renderer?.focus();
      })
      .catch(() => {
        failConnect("The native terminal transport could not attach this pane.", activeGeneration);
      });
  };

  const fit = (): void => {
    animationFrame = null;
    if (disposed) return;
    if (sizePassive()) {
      // Size-passive card: the origin window owns its size, so a DOM measurement
      // must never reflow tmux. Re-assert the window grid on an existing
      // attachment; otherwise open one with a provisional (ignored) viewport.
      if (attachment) {
        const grid = sourceGrid();
        if (grid) renderer?.resizeGrid(grid);
        return;
      }
      if (phase() === "measuring") {
        latestMeasuredViewport = SIZE_PASSIVE_CONNECT_VIEWPORT;
        connect(SIZE_PASSIVE_CONNECT_VIEWPORT);
      }
      return;
    }
    const viewport = usableViewport(renderer?.fit() ?? null);
    if (!viewport) {
      if (!attachment && props.transport) {
        setPhase("measuring");
        recordAttachPhase("waiting-for-viewport");
      }
      return;
    }
    latestMeasuredViewport = viewport;
    if (!attachment) {
      if (phase() === "measuring") connect(viewport);
      return;
    }
    if (!currentViewport) return;
    if (sameViewport(currentViewport, viewport)) return;
    pendingResize = viewport;
    /*
     * Coalesce, but never on the FIRST size.
     *
     * A window drag is a stream of measurements and only the last one matters,
     * so the flush waits for the size to settle. The initial fit after connect
     * is not part of a stream — it is the moment the grid stops being the
     * provisional 80x24 the attach was opened with — and delaying it shows the
     * user a visibly wrong terminal for a fifth of a second on every open.
     */
    if (resizeSettled) {
      flushResize();
      resizeSettled = false;
      return;
    }
    if (resizeDebounce !== null) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      flushResize();
    }, OWNED_RESIZE_DEBOUNCE_MS);
  };

  const scheduleFit = (): void => {
    if (disposed || animationFrame !== null) return;
    animationFrame = requestAnimationFrame(fit);
  };

  const retry = (): void => {
    generation += 1;
    disposeAttachment();
    disposeRenderer();
    currentViewport = null;
    latestMeasuredViewport = null;
    pendingResize = null;
    setSourceGrid(null);
    setClientViewport(null);
    setHasValidatedFrame(false);
    resetAttachTrace(Boolean(props.transport));
    setPhase(props.transport ? "measuring" : "unavailable");
    ensureRenderer();
    scheduleFit();
  };

  const failInput = (message: string): void => {
    setReason(message);
    setPhase("error");
    recordAttachPhase("failed");
    generation += 1;
    disposeAttachment();
  };

  const drainInput = (epoch: InputEpoch): void => {
    if (
      disposed ||
      epoch !== activeInputEpoch ||
      epoch.retired ||
      epoch.inFlight ||
      epoch.queue.length === 0
    ) {
      return;
    }
    const activeAttachment = attachment;
    const activeGeneration = generation;
    if (!activeAttachment || phase() !== "connected") return;
    const payload = epoch.queue.shift();
    if (!payload) return;
    epoch.inFlight = true;
    epoch.inFlightBytes = payload.byteLength;
    void Promise.resolve()
      .then(() => {
        if (
          disposed ||
          epoch.retired ||
          epoch !== activeInputEpoch ||
          generation !== activeGeneration ||
          attachment !== activeAttachment ||
          phase() !== "connected"
        ) {
          return null;
        }
        return activeAttachment.write(payload);
      })
      .then((result) => {
        if (
          !result ||
          result.status !== "error" ||
          disposed ||
          epoch.retired ||
          epoch !== activeInputEpoch ||
          generation !== activeGeneration ||
          attachment !== activeAttachment
        ) {
          return;
        }
        failInput(validatedTransportReason(result.error.reason));
      })
      .catch(() => {
        if (
          disposed ||
          epoch.retired ||
          epoch !== activeInputEpoch ||
          generation !== activeGeneration ||
          attachment !== activeAttachment
        ) {
          return;
        }
        failInput("The desktop host could not forward terminal input.");
      })
      .finally(() => {
        epoch.inFlight = false;
        epoch.inFlightBytes = 0;
        epoch.pendingEntries -= 1;
        epoch.pendingBytes -= payload.byteLength;
        if (epoch === activeInputEpoch && !epoch.retired) drainInput(epoch);
      });
  };

  const queueInput = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0 || !attachment || phase() !== "connected") return;
    const epoch = activeInputEpoch;
    if (
      epoch.pendingEntries >= MAX_PENDING_INPUT_WRITES ||
      bytes.byteLength > MAX_PENDING_INPUT_BYTES - epoch.pendingBytes
    ) {
      failInput("Terminal input exceeded the native forwarding buffer.");
      return;
    }
    const payload = bytes.slice();
    epoch.queue.push(payload);
    epoch.pendingEntries += 1;
    epoch.pendingBytes += payload.byteLength;
    drainInput(epoch);
  };

  const activateRenderer = (nextRenderer: TerminalRenderer, activeLoad: number): void => {
    if (disposed || activeLoad !== rendererLoadGeneration || !mount) {
      nextRenderer.dispose();
      return;
    }
    renderer = nextRenderer;
    renderer.open(mount);
    if (props.transport) recordAttachPhase("renderer-ready");
    renderer.refreshTheme();
    renderer.setReducedMotion(props.reducedMotion ?? false);
    if (props.focused) renderer.focus();
    inputSubscription = renderer.onInput((bytes) => {
      if (activeLoad === rendererLoadGeneration && renderer === nextRenderer) queueInput(bytes);
    });
    observer = new ResizeObserver(() => {
      if (activeLoad === rendererLoadGeneration && renderer === nextRenderer) scheduleFit();
    });
    observer.observe(mount);
    scheduleFit();
  };

  const ensureRenderer = (): void => {
    if (renderer || disposed || !mount || (!props.transport && !props.rendererFactory)) return;
    const activeLoad = ++rendererLoadGeneration;
    const options = {
      reducedMotion: props.reducedMotion ?? false,
      label: `${props.title} terminal`,
    };
    if (props.rendererFactory) {
      activateRenderer(props.rendererFactory(options), activeLoad);
      return;
    }
    void import("./xterm-renderer.ts")
      .then(({ createXtermRenderer }) => activateRenderer(createXtermRenderer(options), activeLoad))
      .catch(() => {
        if (disposed || activeLoad !== rendererLoadGeneration) return;
        setReason("The native terminal renderer could not be loaded.");
        setPhase("error");
        recordAttachPhase("failed");
      });
  };

  onMount(() => {
    ensureRenderer();

    onCleanup(() => {
      disposed = true;
      generation += 1;
      disposeAttachment();
      disposeRenderer();
    });
  });

  createEffect(() => {
    if (props.focused) renderer?.focus();
  });

  createEffect(() => {
    const themeKey = props.themeKey;
    renderer?.refreshTheme();
    // A theme change can alter the font token, which changes xterm's cell
    // metrics; re-fit so cols/rows (and the host viewport) never go stale
    // against the new cell size. When geometry is unchanged this is a no-op.
    scheduleFit();
    return themeKey;
  });

  createEffect(() => {
    renderer?.setReducedMotion(props.reducedMotion ?? false);
  });

  createEffect(() => {
    const nextTarget = `${props.target.workspaceName}\0${props.target.semanticPaneId}`;
    const nextTransport = props.transport;
    if (nextTarget === observedTarget && nextTransport === observedTransport) return;
    observedTarget = nextTarget;
    observedTransport = nextTransport;
    if (disposed) return;
    generation += 1;
    disposeAttachment();
    disposeRenderer();
    currentViewport = null;
    latestMeasuredViewport = null;
    pendingResize = null;
    setSourceGrid(null);
    setClientViewport(null);
    setReason(null);
    setHasValidatedFrame(false);
    resetAttachTrace(Boolean(nextTransport));
    setPhase(nextTransport ? "measuring" : "unavailable");
    ensureRenderer();
    scheduleFit();
  });

  return (
    <div
      class="terminal-surface"
      data-phase={phase()}
      data-attach-phase={props.transport ? attachPhase() : undefined}
      data-attach-attempt={props.transport ? attachAttempt() : undefined}
      data-attach-trace={props.transport ? JSON.stringify(attachTrace()) : undefined}
      data-focused={props.focused ?? false}
      data-size-passive={sizePassive()}
      data-geometry-ownership={props.geometryOwnership ?? "passive"}
      data-reduced-motion={props.reducedMotion ?? false}
      data-preserves-frame={hasValidatedFrame()}
      data-widget={widgetTag()}
      data-source-grid={sourceGrid() ? `${sourceGrid()!.cols}x${sourceGrid()!.rows}` : undefined}
      data-client-viewport={
        clientViewport() ? `${clientViewport()!.cols}x${clientViewport()!.rows}` : undefined
      }
      onPointerDown={() => {
        pointerFocus = true;
        props.onFocus?.("mouse");
        queueMicrotask(() => {
          pointerFocus = false;
        });
      }}
      onFocusIn={() => {
        if (!pointerFocus) props.onFocus?.("keyboard");
      }}
    >
      <div
        ref={(element) => {
          mount = element;
        }}
        class="terminal-surface__viewport"
        aria-label={`${props.title} terminal`}
      />
      {/*
       * The widget overlay (m49.7). It covers the grid; it does not replace it.
       * The emulator stays mounted and focusable underneath so Ctrl-C still
       * reaches the process, which is what returns the pane to a shell.
       */}
      <Show when={widget()} keyed>
        {(resolution) => (
          <WidgetSurface resolution={resolution} onRequestFocus={() => renderer?.focus()} />
        )}
      </Show>
      <Show when={phase() !== "connected" || !hasValidatedFrame()}>
        <div
          class="terminal-surface__state"
          role={phase() === "error" || phase() === "disconnected" ? "alert" : "status"}
          aria-live="polite"
        >
          <i aria-hidden="true" />
          <Switch>
            <Match when={phase() === "unavailable"}>
              <strong>Native terminal unavailable</strong>
              <span>The verified desktop terminal transport is not present in this build.</span>
            </Match>
            <Match when={phase() === "measuring"}>
              <strong>Preparing terminal</strong>
              <span>Waiting for enough pane space to attach safely.</span>
            </Match>
            <Match when={phase() === "connecting"}>
              <strong>Connecting to tmux</strong>
              <span>
                {attachPhase() === "transport-ready"
                  ? "The terminal transport is ready; waiting for the attachment handle."
                  : "The desktop host is issuing and redeeming this semantic attachment."}
              </span>
            </Match>
            <Match when={phase() === "connected" && !hasValidatedFrame()}>
              <strong>Loading terminal contents</strong>
              <span>The attachment is ready; waiting for xterm to paint its first frame.</span>
            </Match>
            <Match when={phase() === "disconnected"}>
              <strong>Terminal disconnected</strong>
              <span>{reason()}</span>
              <button type="button" onClick={retry}>
                Reconnect
              </button>
            </Match>
            <Match when={phase() === "error"}>
              <strong>Terminal could not attach</strong>
              <span>{reason()}</span>
              <button type="button" onClick={retry}>
                Try again
              </button>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}
