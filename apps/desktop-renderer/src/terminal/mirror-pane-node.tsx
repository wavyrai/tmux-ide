import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import type { DesktopConnectionHealth } from "../runtime/connection-health.ts";
import type { MirrorPaneSink, MirrorPaneNodeState } from "./workspace-pane-compositor.ts";
import type { PaneMirrorSeedBatch } from "./pane-stream-transport.ts";
import type {
  MirrorTerminalRenderer,
  MirrorTerminalRendererFactory,
} from "./mirror-xterm-renderer.ts";
import { WidgetSurface } from "./widgets/widget-surface.tsx";
import { createWidgetMarkerByteWatcher, detectWidgetMarker } from "@tmux-ide/contracts";
import { resolveWidget, type WidgetResolution } from "./widgets/widget-registry.ts";
import { WIDGET_SCAN_MAX_ROWS } from "./widgets/xterm-cell-rows.ts";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import { useGuiPerformanceTelemetry } from "../runtime/gui-performance-context.tsx";

export interface MirrorPaneNodeProps {
  /** Semantic pane identity; never a runtime tmux id. */
  readonly pane: string;
  readonly title: string;
  readonly state: MirrorPaneNodeState;
  /** Stream-level derived health; a ws drop reads as reconnecting, never blank. */
  readonly connection: DesktopConnectionHealth;
  /** The typed cause behind a stopped stream, when the vocabulary named one. */
  readonly faultLabel?: string | null;
  readonly registerSink: (sink: MirrorPaneSink) => () => void;
  readonly onRetry?: () => void;
  readonly reducedMotion?: boolean;
  readonly themeKey?: string;
  readonly rendererFactory?: MirrorTerminalRendererFactory;
  /** Reports xterm's painted selection to the workspace copy authority. */
  readonly onSelectionChange?: (selection: string) => void;
}

/**
 * Read-only mirror pane body (m43 card 3): xterm.js fed exclusively from the
 * pane stream — seed-batch as ONE atomic paint, deltas as writes, cursor as
 * CUP. It is size-PASSIVE: the grid comes from the stream's reset dimensions
 * and the remainder letterboxes; a mirror node never issues a resize.
 */
/** Writes are coalesced before the grid is scanned; see the interactive twin. */
const WIDGET_SCAN_DEBOUNCE_MS = 40;

export function MirrorPaneNode(props: MirrorPaneNodeProps) {
  const performanceTelemetry = useGuiPerformanceTelemetry();
  const [grid, setGrid] = createSignal<{ cols: number; rows: number } | null>(null);
  const [painted, setPainted] = createSignal(false);
  const [widget, setWidget] = createSignal<WidgetResolution | null>(null);
  let mount: HTMLDivElement | undefined;
  let overlayStyle: RuntimeStyleBinding | null = null;
  let markerWatcher = createWidgetMarkerByteWatcher();
  let widgetScan: ReturnType<typeof setTimeout> | null = null;
  let renderer: MirrorTerminalRenderer | null = null;
  let selectionSubscription: { dispose(): void } | null = null;
  let unregister: (() => void) | null = null;
  let containerObserver: ResizeObserver | null = null;
  let overlayElement: HTMLDivElement | undefined;
  let disposed = false;
  let rendererLoad = 0;

  /**
   * Read the grid and decide what this pane is showing (m49.7).
   *
   * The mirror is the harder of the two detection points: a re-lease reseeds
   * the pane from `capture-pane`, so the marker arrives as part of a SEED
   * rather than as live output, and a scan that only ran on deltas would show a
   * blank widget after every reconnect.
   */
  const scanForWidget = (): void => {
    widgetScan = null;
    const active = renderer;
    if (disposed || !active) return;
    const marker = detectWidgetMarker(active.readCellRows(WIDGET_SCAN_MAX_ROWS));
    setWidget(marker ? resolveWidget(marker) : null);
    positionOverlay();
  };

  const scheduleWidgetScan = (): void => {
    if (disposed || widgetScan !== null) return;
    widgetScan = setTimeout(scanForWidget, WIDGET_SCAN_DEBOUNCE_MS);
  };

  /**
   * Pin the overlay to the LETTERBOXED grid, not to the card.
   *
   * The mirror scales its render down to fit, so a widget positioned at the
   * card's own inset would spill across the letterbox margins and sit wider
   * than the terminal it replaced. Both numbers come from the renderer's own
   * committed fit — the rule-10 invariant in CANVAS_INTERACTIONS.md.
   */
  const positionOverlay = (): void => {
    if (!overlayElement) return;
    const geometry = renderer?.gridOverlayGeometry() ?? null;
    overlayStyle ??= createRuntimeStyleBinding(overlayElement);
    if (!geometry) {
      overlayStyle.update({ inset: "0" });
      return;
    }
    overlayStyle.update({
      left: `${geometry.box.left}px`,
      top: `${geometry.box.top}px`,
      width: `${geometry.box.width}px`,
      height: `${geometry.box.height}px`,
      right: "auto",
      bottom: "auto",
    });
  };

  const activateRenderer = (next: MirrorTerminalRenderer, load: number): void => {
    if (disposed || load !== rendererLoad || !mount) {
      next.dispose();
      return;
    }
    renderer = next;
    renderer.open(mount);
    selectionSubscription?.dispose();
    selectionSubscription = next.onSelectionChange((selection) =>
      props.onSelectionChange?.(selection),
    );
    renderer.refreshTheme();
    observeContainer(next, mount);
    attachSink(next);
  };

  /**
   * The card is laid out by the canvas, so the letterbox has to follow the card
   * as well as the grid: the deck shrinks its nodes to stay on screen, and the
   * render must re-fit when it does. ResizeObserver is absent in some test DOMs;
   * the seed-time fit still covers the common case there.
   */
  const observeContainer = (next: MirrorTerminalRenderer, element: HTMLElement): void => {
    if (typeof ResizeObserver === "undefined") return;
    containerObserver?.disconnect();
    containerObserver = new ResizeObserver(() => {
      if (disposed || renderer !== next) return;
      next.fitToContainer();
      // The fit just changed, so anything pinned to it has to move with it.
      positionOverlay();
    });
    containerObserver.observe(element);
  };

  /**
   * Bind the stream sink to the live renderer. The node mounts ONCE and streams
   * for its whole life, so a new lease arrives as a new registrar rather than
   * as a remount: re-attaching here is what keeps a re-leased pane painting.
   */
  const attachSink = (next: MirrorTerminalRenderer): void => {
    unregister?.();
    unregister = props.registerSink({
      applySeedBatch: (batch: PaneMirrorSeedBatch) => {
        if (disposed || renderer !== next) return;
        if (batch.reset) setGrid({ cols: batch.reset.cols, rows: batch.reset.rows });
        const finishParse = performanceTelemetry?.beginParse();
        const paint = performanceTelemetry?.beginPaint(next.performanceChannel?.() ?? null);
        const applied = Promise.resolve(next.applySeedBatch(batch)).then(
          () => {
            finishParse?.();
            paint?.commit();
            performanceTelemetry?.recordReseed();
            performanceTelemetry?.commitDelivery();
            setPainted(true);
            // A seed REPLACES the screen, so it can both create and destroy a
            // widget; it is always worth a scan after the paint committed.
            scheduleWidgetScan();
          },
          (error: unknown) => {
            paint?.cancel();
            throw error;
          },
        );
        return applied;
      },
      applyGeometry: (cols: number, rows: number) => {
        if (disposed || renderer !== next) return;
        setGrid({ cols, rows });
        next.resizeGrid({ cols, rows });
        positionOverlay();
      },
      applyOutput: (bytes: Uint8Array) => {
        if (disposed || renderer !== next) return;
        // Either the bytes carry the sentinel, or a widget is already showing
        // and this write may be the clear that takes it away.
        if (markerWatcher.observe(bytes) || widget() !== null) scheduleWidgetScan();
        const finishParse = performanceTelemetry?.beginParse();
        const paint = performanceTelemetry?.beginPaint(next.performanceChannel?.() ?? null);
        return next.write(bytes).then(
          () => {
            finishParse?.();
            paint?.commit();
            performanceTelemetry?.commitDelivery();
          },
          (error: unknown) => {
            paint?.cancel();
            throw error;
          },
        );
      },
      applyCursor: (x: number, y: number) => {
        if (disposed || renderer !== next) return;
        next.applyCursor(x, y);
      },
    });
  };

  onMount(() => {
    const load = ++rendererLoad;
    const options = {
      reducedMotion: props.reducedMotion ?? false,
      label: `${props.title} mirror`,
      performanceTelemetry,
    };
    if (props.rendererFactory) {
      activateRenderer(props.rendererFactory(options), load);
    } else {
      void import("./mirror-xterm-renderer.ts")
        .then(({ createMirrorXtermRenderer }) =>
          activateRenderer(createMirrorXtermRenderer(options), load),
        )
        .catch(() => {
          // The state overlay keeps reporting "connecting"; the stream itself
          // is unaffected and a remount retries the renderer load.
        });
    }
    onCleanup(() => {
      disposed = true;
      rendererLoad += 1;
      if (widgetScan !== null) clearTimeout(widgetScan);
      widgetScan = null;
      markerWatcher = createWidgetMarkerByteWatcher();
      setWidget(null);
      overlayStyle?.dispose();
      overlayStyle = null;
      containerObserver?.disconnect();
      containerObserver = null;
      unregister?.();
      unregister = null;
      selectionSubscription?.dispose();
      selectionSubscription = null;
      props.onSelectionChange?.("");
      const active = renderer;
      renderer = null;
      try {
        active?.dispose();
      } catch {
        // Teardown is best-effort; the sink is already unregistered.
      }
      try {
        mount?.replaceChildren();
      } catch {
        // A replacement node receives a fresh mount either way.
      }
    });
  });

  createEffect(() => {
    const themeKey = props.themeKey;
    renderer?.refreshTheme();
    return themeKey;
  });

  let boundRegistrar = props.registerSink;
  createEffect(() => {
    const registrar = props.registerSink;
    if (registrar === boundRegistrar) return;
    boundRegistrar = registrar;
    const active = renderer;
    if (!disposed && active) attachSink(active);
  });

  /** The pane's widget identity for the DOM: a widget id, "invalid", or absent. */
  const widgetTag = (): string | undefined => {
    const resolution = widget();
    if (!resolution) return undefined;
    return resolution.status === "ready" ? resolution.definition.id : "invalid";
  };

  const streamInterrupted = () =>
    props.connection.kind === "reconnecting" ||
    props.connection.kind === "stopped" ||
    props.connection.kind === "connecting";

  return (
    <div
      class="mirror-pane-node"
      data-pane={props.pane}
      data-state={props.state.kind}
      data-flow-paused={props.state.kind === "live" && props.state.flowPaused}
      data-connection={props.connection.kind}
      data-painted={painted()}
      data-widget={widgetTag()}
      data-grid={grid() ? `${grid()!.cols}x${grid()!.rows}` : undefined}
    >
      <div
        class="mirror-pane-node__viewport"
        aria-label={`${props.title} mirror`}
        ref={(element) => {
          mount = element;
        }}
      />
      {/*
       * The widget overlay (m49.7), pinned to the letterboxed grid rather than
       * to the card. A mirror pane takes no keyboard input, so unlike the
       * interactive twin there is nothing focusable to preserve underneath —
       * but the emulator still streams, which is how the widget goes away.
       */}
      <Show when={widget()} keyed>
        {(resolution) => (
          <div
            class="mirror-pane-node__widget"
            ref={(element) => {
              overlayElement = element;
              positionOverlay();
            }}
          >
            <WidgetSurface resolution={resolution} />
          </div>
        )}
      </Show>
      <Show when={props.state.kind === "live" && props.state.flowPaused}>
        <span class="mirror-pane-node__flow" role="status">
          Stream paused — catching up
        </span>
      </Show>
      <Show when={props.state.kind !== "live" || streamInterrupted()}>
        <div
          class="mirror-pane-node__state"
          role={props.state.kind === "unavailable" ? "alert" : "status"}
          aria-live="polite"
        >
          <i aria-hidden="true" />
          <Switch>
            <Match when={props.state.kind === "ended"}>
              <strong>Pane ended</strong>
              <span>This tmux pane exited; the mirror keeps its last frame.</span>
            </Match>
            <Match when={props.connection.kind === "reconnecting"}>
              <strong>Reconnecting to the pane stream</strong>
              <span>
                {props.connection.kind === "reconnecting" && props.connection.attempt > 0
                  ? `Attempt ${props.connection.attempt} of ${props.connection.maximumAttempts}`
                  : "The stream supervisor is retrying automatically."}
              </span>
            </Match>
            <Match when={props.connection.kind === "stopped"}>
              <strong>Pane stream stopped</strong>
              <span>{props.connection.kind === "stopped" ? props.connection.reason : ""}</span>
              <Show when={props.faultLabel}>
                <span class="mirror-pane-node__cause">{`Cause: ${props.faultLabel}.`}</span>
              </Show>
              <Show when={props.onRetry}>
                <button type="button" onClick={() => props.onRetry?.()}>
                  Reconnect
                </button>
              </Show>
            </Match>
            <Match when={props.state.kind === "unavailable"}>
              <strong>Mirror unavailable</strong>
              <span>{props.state.kind === "unavailable" ? props.state.reason : ""}</span>
            </Match>
            <Match when={true}>
              <strong>Connecting mirror</strong>
              <span>Waiting for the pane stream seed.</span>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}
