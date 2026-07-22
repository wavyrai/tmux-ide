import {
  resolvePaneAppearance,
  type AppWindowDocumentV1,
  type ApplicationShellTerminalInventory,
  type PaneAppearance,
} from "@tmux-ide/contracts";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { WebPaneFrame } from "../../../../packages/daemon/src/ui/pane-frame/web-host.tsx";
import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import { DomIcon } from "./dom-icon.tsx";
import {
  appWindowFocusInvocation,
  projectAppWindowCanvas,
  type AppWindowCanvasCommandInvocation,
  type AppWindowCanvasItem,
  type AppWindowCanvasViewport,
} from "./app-window-canvas-presenter.ts";

export interface AppWindowCanvasProps {
  readonly document: AppWindowDocumentV1;
  readonly paneFrames: readonly PaneFrameModel[];
  readonly terminalInventory?: ApplicationShellTerminalInventory;
  readonly workspaceName: string;
  readonly transport?: NativeTerminalTransport | null;
  readonly reducedMotion?: boolean;
  readonly terminalThemeKey?: string;
  readonly viewport?: AppWindowCanvasViewport;
  readonly onCommand?: (invocation: AppWindowCanvasCommandInvocation) => void;
  readonly onTerminalFocus?: (
    windowId: string,
    terminalSourceId: string,
    source: "keyboard" | "mouse",
  ) => void;
}

function sceneAppearance(base: PaneAppearance, window: AppWindowCanvasItem): PaneAppearance {
  return resolvePaneAppearance({
    structure: window.placement,
    applicationFocus: {
      pane: window.selected || base.accessibility.focused,
      terminalInput: window.selected || base.accessibility.terminalInputOwner,
      windowActive: base.header.windowActive,
    },
    agentActivity: base.header.agentActivity,
    domainStatus: base.status.domainStatus,
    attention: base.status.attention,
    layoutInteraction: {
      editable: true,
      selected: window.selected,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: false,
      focusVisible: false,
      pressed: false,
      disabled: base.action.disabled,
      loading: base.action.loading,
    },
  });
}

function windowFrameModel(window: AppWindowCanvasItem, source: PaneFrameModel): PaneFrameModel {
  const paneId = window.windowId;
  return {
    ...source,
    pane: { ...source.pane, id: paneId },
    title: window.title ?? source.title,
    appearance: sceneAppearance(source.appearance, window),
    status: source.status ? { ...source.status, id: `${paneId}.status` } : null,
    chips: source.chips.map((chip, index) => ({
      ...chip,
      id: `${paneId}.chip.${index}`,
    })),
    actions: source.actions.map((action) => ({
      ...action,
      available: false,
      disabledReason: "App window controls are not connected yet",
      pressed: false,
    })),
  };
}

function measuredViewport(element: HTMLElement): AppWindowCanvasViewport {
  const bounds = element.getBoundingClientRect();
  return {
    width: Math.max(0, Math.round(bounds.width || element.clientWidth)),
    height: Math.max(0, Math.round(bounds.height || element.clientHeight)),
  };
}

/** App-owned scene host. tmux supplies bytes; it never owns this geometry. */
export function AppWindowCanvas(props: AppWindowCanvasProps) {
  const [measured, setMeasured] = createSignal<AppWindowCanvasViewport>(
    props.viewport ?? { width: 1_000, height: 640 },
  );
  let canvas: HTMLDivElement | undefined;

  onMount(() => {
    if (!canvas || props.viewport) return;
    const update = () => canvas && setMeasured(measuredViewport(canvas));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  const viewport = createMemo(() => props.viewport ?? measured());
  const projection = createMemo(() => projectAppWindowCanvas(props.document, viewport()));
  const framesByTerminalSource = createMemo(
    () => new Map(props.paneFrames.map((frame) => [frame.pane.id, frame])),
  );
  const resourcesById = createMemo(
    () => new Map(props.terminalInventory?.resources.map((resource) => [resource.id, resource])),
  );

  const terminalTarget = (terminalSourceId: string): string | null => {
    const resource = resourcesById().get(terminalSourceId);
    if (props.terminalInventory !== undefined) {
      return resource?.attachability.status === "available"
        ? resource.attachability.semanticPaneId
        : null;
    }
    return terminalSourceId;
  };

  return (
    <div
      ref={(element) => {
        canvas = element;
      }}
      class="app-window-canvas"
      data-window-revision={projection().revision}
      data-window-count={projection().windows.length}
      data-focused-window-id={projection().focusedWindowId ?? ""}
    >
      <For each={projection().windows}>
        {(window) => {
          const terminalSourceId = () =>
            window.source.kind === "terminal" ? window.source.terminalSourceId : null;
          const sourceFrame = createMemo(() => {
            const sourceId = terminalSourceId();
            return sourceId ? (framesByTerminalSource().get(sourceId) ?? null) : null;
          });
          const frame = createMemo(() => {
            const source = sourceFrame();
            return source ? windowFrameModel(window, source) : null;
          });
          const target = createMemo(() => {
            const sourceId = terminalSourceId();
            return sourceId ? terminalTarget(sourceId) : null;
          });
          return (
            <article
              class="app-window-card"
              data-window-id={window.windowId}
              data-terminal-source-id={terminalSourceId() ?? ""}
              data-placement={window.placement}
              data-selected={window.selected}
              data-active={window.active}
              style={{
                left: `${window.rect.x}px`,
                top: `${window.rect.y}px`,
                width: `${window.rect.width}px`,
                height: `${window.rect.height}px`,
                "z-index": window.zIndex,
              }}
              onPointerDown={() => {
                if (!window.selected)
                  props.onCommand?.(appWindowFocusInvocation(window.windowId, "mouse"));
              }}
            >
              <Show
                when={frame()}
                fallback={
                  <section class="app-window-card__unavailable" role="status">
                    <strong>{window.title ?? "Terminal unavailable"}</strong>
                    <span>This saved window no longer has a matching terminal resource.</span>
                  </section>
                }
              >
                {(model) => (
                  <WebPaneFrame
                    model={model()}
                    renderPaneIcon={(_pane, icon) => <DomIcon id={icon} usage="pane" />}
                    renderActionIcon={(action) => <DomIcon id={action.icon} usage="action" />}
                    renderGripIcon={(icon) => <DomIcon id={icon} usage="action" />}
                  >
                    <div class="agent-pane__body" data-focus-zone="terminal">
                      <Show
                        when={target()}
                        fallback={
                          <div class="terminal-surface terminal-surface--unavailable" role="status">
                            <strong>Terminal unavailable</strong>
                            <span>
                              {model().status?.description ??
                                "This terminal cannot be attached safely."}
                            </span>
                          </div>
                        }
                      >
                        {(semanticPaneId) => (
                          <TerminalSurface
                            target={{
                              workspaceName: props.workspaceName,
                              semanticPaneId: semanticPaneId(),
                            }}
                            title={model().title}
                            transport={props.transport}
                            focused={model().appearance.accessibility.terminalInputOwner}
                            reducedMotion={props.reducedMotion}
                            themeKey={props.terminalThemeKey}
                            onFocus={(source) => {
                              const sourceId = terminalSourceId();
                              if (sourceId) {
                                props.onTerminalFocus?.(window.windowId, sourceId, source);
                              }
                            }}
                          />
                        )}
                      </Show>
                    </div>
                  </WebPaneFrame>
                )}
              </Show>
            </article>
          );
        }}
      </For>
      <Show when={projection().windows.length === 0}>
        <div class="app-window-canvas__empty" role="status">
          <strong>No terminal windows in this saved layout</strong>
          <span>Create or restore a terminal window to place it on the canvas.</span>
        </div>
      </Show>
    </div>
  );
}
