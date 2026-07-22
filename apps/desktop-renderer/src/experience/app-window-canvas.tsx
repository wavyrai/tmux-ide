import {
  resolvePaneAppearance,
  type AppWindowDocumentV1,
  type ApplicationShellTerminalInventory,
  type PaneAppearance,
} from "@tmux-ide/contracts";
import {
  For,
  Show,
  createComputed,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

// Pane chrome CSS is already imported by the renderer's external stylesheet.
// Importing the styled entry would make Vite inject a CSP-blocked <style> tag.
import { WebPaneFrame } from "../../../../packages/daemon/src/ui/pane-frame/web-host-unstyled.tsx";
import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import type { TerminalRendererFactory } from "../terminal/xterm-renderer.ts";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
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
  readonly rendererFactory?: TerminalRendererFactory;
  readonly viewport?: AppWindowCanvasViewport;
  readonly onCommand?: (invocation: AppWindowCanvasCommandInvocation) => void;
}

function sceneAppearance(base: PaneAppearance, window: AppWindowCanvasItem): PaneAppearance {
  return resolvePaneAppearance({
    structure: window.placement,
    applicationFocus: {
      pane: window.selected,
      terminalInput: window.selected,
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

interface AppWindowCanvasRecord {
  readonly windowId: string;
  readonly value: Accessor<AppWindowCanvasItem>;
  readonly update: (next: AppWindowCanvasItem) => void;
}

/** Preserve mounted terminal components while their projected geometry changes. */
function createAppWindowRecords(
  source: Accessor<readonly AppWindowCanvasItem[]>,
): Accessor<readonly AppWindowCanvasRecord[]> {
  const [records, setRecords] = createSignal<readonly AppWindowCanvasRecord[]>([]);
  let available = new Map<string, AppWindowCanvasRecord>();
  createComputed(() => {
    const next = source().map((window) => {
      const current = available.get(window.windowId);
      if (current) {
        current.update(window);
        return current;
      }
      const [value, setValue] = createSignal(window, { equals: false });
      return {
        windowId: window.windowId,
        value,
        update: (item: AppWindowCanvasItem) => setValue(() => item),
      };
    });
    available = new Map(next.map((record) => [record.windowId, record]));
    setRecords(next);
  });
  onCleanup(() => available.clear());
  return records;
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
  const windowRecords = createAppWindowRecords(() => projection().windows);
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
      <For each={windowRecords()}>
        {(record) => {
          const window = record.value;
          let runtimeStyle: RuntimeStyleBinding | null = null;
          createComputed(() => {
            const value = window();
            runtimeStyle?.update({
              left: `${value.rect.x}px`,
              top: `${value.rect.y}px`,
              width: `${value.rect.width}px`,
              height: `${value.rect.height}px`,
              "z-index": value.zIndex,
            });
          });
          onCleanup(() => runtimeStyle?.dispose());
          const terminalSourceId = () => {
            const source = window().source;
            return source.kind === "terminal" ? source.terminalSourceId : null;
          };
          const sourceFrame = createMemo(() => {
            const sourceId = terminalSourceId();
            return sourceId ? (framesByTerminalSource().get(sourceId) ?? null) : null;
          });
          const frame = createMemo(() => {
            const source = sourceFrame();
            return source ? windowFrameModel(window(), source) : null;
          });
          const target = createMemo(() => {
            const sourceId = terminalSourceId();
            return sourceId ? terminalTarget(sourceId) : null;
          });
          return (
            <article
              ref={(element) => {
                runtimeStyle = createRuntimeStyleBinding(element);
                const value = window();
                runtimeStyle.update({
                  left: `${value.rect.x}px`,
                  top: `${value.rect.y}px`,
                  width: `${value.rect.width}px`,
                  height: `${value.rect.height}px`,
                  "z-index": value.zIndex,
                });
              }}
              class="app-window-card"
              data-window-id={window().windowId}
              data-terminal-source-id={terminalSourceId() ?? ""}
              data-placement={window().placement}
              data-selected={window().selected}
              data-active={window().active}
              onPointerDown={(event) => {
                if (event.target instanceof Element && event.target.closest(".terminal-surface")) {
                  return;
                }
                if (!window().selected)
                  props.onCommand?.(appWindowFocusInvocation(window().windowId, "mouse"));
              }}
            >
              <Show
                when={frame()}
                fallback={
                  <section class="app-window-card__unavailable" role="status">
                    <strong>{window().title ?? "Terminal unavailable"}</strong>
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
                            rendererFactory={props.rendererFactory}
                            onFocus={(source) => {
                              const sourceId = terminalSourceId();
                              if (sourceId) {
                                props.onCommand?.(
                                  appWindowFocusInvocation(window().windowId, source),
                                );
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
