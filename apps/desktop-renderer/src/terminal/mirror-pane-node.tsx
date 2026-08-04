import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import type { DesktopConnectionHealth } from "../runtime/connection-health.ts";
import type { MirrorPaneSink, MirrorPaneNodeState } from "./pane-mirror-controller.ts";
import type { PaneMirrorSeedBatch } from "./pane-stream-transport.ts";
import type {
  MirrorTerminalRenderer,
  MirrorTerminalRendererFactory,
} from "./mirror-xterm-renderer.ts";

export interface MirrorPaneNodeProps {
  /** Semantic pane identity; never a runtime tmux id. */
  readonly pane: string;
  readonly title: string;
  readonly state: MirrorPaneNodeState;
  /** Stream-level derived health; a ws drop reads as reconnecting, never blank. */
  readonly connection: DesktopConnectionHealth;
  readonly registerSink: (sink: MirrorPaneSink) => () => void;
  readonly onRetry?: () => void;
  readonly reducedMotion?: boolean;
  readonly themeKey?: string;
  readonly rendererFactory?: MirrorTerminalRendererFactory;
}

/**
 * Read-only mirror pane body (m43 card 3): xterm.js fed exclusively from the
 * pane stream — seed-batch as ONE atomic paint, deltas as writes, cursor as
 * CUP. It is size-PASSIVE: the grid comes from the stream's reset dimensions
 * and the remainder letterboxes; a mirror node never issues a resize.
 */
export function MirrorPaneNode(props: MirrorPaneNodeProps) {
  const [grid, setGrid] = createSignal<{ cols: number; rows: number } | null>(null);
  const [painted, setPainted] = createSignal(false);
  let mount: HTMLDivElement | undefined;
  let renderer: MirrorTerminalRenderer | null = null;
  let unregister: (() => void) | null = null;
  let disposed = false;
  let rendererLoad = 0;

  const activateRenderer = (next: MirrorTerminalRenderer, load: number): void => {
    if (disposed || load !== rendererLoad || !mount) {
      next.dispose();
      return;
    }
    renderer = next;
    renderer.open(mount);
    renderer.refreshTheme();
    unregister = props.registerSink({
      applySeedBatch: (batch: PaneMirrorSeedBatch) => {
        if (disposed || renderer !== next) return;
        if (batch.reset) setGrid({ cols: batch.reset.cols, rows: batch.reset.rows });
        const applied = next.applySeedBatch(batch);
        setPainted(true);
        return applied;
      },
      applyOutput: (bytes: Uint8Array) => {
        if (disposed || renderer !== next) return;
        return next.write(bytes);
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
      unregister?.();
      unregister = null;
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
      data-grid={grid() ? `${grid()!.cols}x${grid()!.rows}` : undefined}
    >
      <div
        class="mirror-pane-node__viewport"
        aria-label={`${props.title} mirror`}
        ref={(element) => {
          mount = element;
        }}
      />
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
