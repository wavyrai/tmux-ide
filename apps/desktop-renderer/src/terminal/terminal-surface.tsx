import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachRequest,
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
} from "./native-terminal-transport.ts";
import type { TerminalRenderer, TerminalRendererFactory } from "./xterm-renderer.ts";

export type TerminalSurfacePhase =
  | "unavailable"
  | "measuring"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const MAX_PENDING_OUTPUT_WRITES = 64;
const OUTPUT_WRITE_TIMEOUT_MS = 15_000;
const MAX_PENDING_INPUT_WRITES = 64;
const MAX_PENDING_INPUT_BYTES = 256 * 1024;

export interface TerminalSurfaceProps {
  readonly target: TerminalAttachmentSemanticTarget;
  readonly title: string;
  readonly transport?: NativeTerminalTransport | null;
  readonly focused?: boolean;
  readonly reducedMotion?: boolean;
  readonly themeKey?: string;
  readonly onFocus?: (source: "keyboard" | "mouse") => void;
  readonly rendererFactory?: TerminalRendererFactory;
}

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
  const [phase, setPhase] = createSignal<TerminalSurfacePhase>(
    props.transport ? "measuring" : "unavailable",
  );
  const [reason, setReason] = createSignal<string | null>(null);
  const [hasValidatedFrame, setHasValidatedFrame] = createSignal(false);
  const [sourceGrid, setSourceGrid] = createSignal<TerminalAttachmentViewport | null>(null);
  const [clientViewport, setClientViewport] = createSignal<TerminalAttachmentViewport | null>(null);
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
  let pointerFocus = false;
  let rendererLoadGeneration = 0;

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
    pendingResize = null;
    resizeFlight = null;
    retireInput();
    retireOutput();
    if (active) safelyDispose(active);
  };

  const disposeRenderer = (): void => {
    rendererLoadGeneration += 1;
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
        generation += 1;
        disposeAttachment();
      })
      .catch(() => {
        if (disposed || attachment !== activeAttachment) return;
        setReason("The desktop host could not resize this terminal.");
        setPhase("error");
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
      generation += 1;
      disposeAttachment();
      return Promise.reject(OUTPUT_NOT_CONSUMED);
    }
    epoch.pending += 1;
    const payload = bytes.slice();
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
      return queueOutput(event.bytes, activeGeneration).then(() => {
        if (!disposed && activeGeneration === generation) setHasValidatedFrame(true);
      });
    }
    if (event.type === "geometry") {
      currentViewport = event.clientViewport;
      setSourceGrid(event.sourceGrid);
      setClientViewport(event.clientViewport);
      const measured = latestMeasuredViewport;
      if (attachment && measured && !sameViewport(event.clientViewport, measured)) {
        pendingResize = measured;
        flushResize();
      }
      return;
    }
    if (event.type !== "state") return;
    if (event.state === "connected") {
      currentViewport = event.clientViewport;
      setSourceGrid(event.sourceGrid);
      setClientViewport(event.clientViewport);
      if (attachment) {
        setReason(null);
        setPhase("connected");
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
    generation += 1;
    disposeAttachment();
  };

  const failConnect = (message: string, activeGeneration: number): void => {
    if (disposed || activeGeneration !== generation) return;
    generation += 1;
    disposeAttachment();
    setReason(message);
    setPhase("error");
  };

  const connect = (viewport: TerminalAttachmentViewport): void => {
    if (!props.transport || attachment || phase() === "connecting" || disposed) return;
    const activeGeneration = ++generation;
    setReason(null);
    setPhase("connecting");
    let request: TerminalAttachRequest;
    try {
      request = validateNativeTerminalRequest({
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        target: props.target,
        viewerMode: "interactive",
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
          failConnect(validatedTransportReason(result.error.reason), activeGeneration);
          return;
        }
        attachment = result.attachment;
        setPhase("connected");
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
    const viewport = usableViewport(renderer?.fit() ?? null);
    if (!viewport) {
      if (!attachment && props.transport) setPhase("measuring");
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
    flushResize();
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
    setPhase(props.transport ? "measuring" : "unavailable");
    ensureRenderer();
    scheduleFit();
  };

  const failInput = (message: string): void => {
    setReason(message);
    setPhase("error");
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
    setPhase(nextTransport ? "measuring" : "unavailable");
    ensureRenderer();
    scheduleFit();
  });

  return (
    <div
      class="terminal-surface"
      data-phase={phase()}
      data-focused={props.focused ?? false}
      data-reduced-motion={props.reducedMotion ?? false}
      data-preserves-frame={hasValidatedFrame()}
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
      <Show when={phase() !== "connected"}>
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
              <span>The desktop host is attaching this semantic pane.</span>
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
