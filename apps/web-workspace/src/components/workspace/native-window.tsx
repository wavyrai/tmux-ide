import { getHost } from "../../client";
import { Pane, PaneHeader, PaneTitle, PaneAction } from "../ui/pane";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Theme } from "@superlogical/shared/themes";
import type { PaneStreamLayoutEvent } from "../../../../desktop-renderer/src/terminal/pane-stream-transport";
import type { WorkspaceRuntime } from "../../runtime/workspace-runtime";
import { WorkspaceNotice } from "../ui/workspace-notice";
import { Columns2, Rows2, Prompt } from "../../icons";
import { usePaneSwap } from "../../use-pane-swap";
import { LiveDivider } from "../../live-divider";
import { projectWindowGeometry } from "../../window-geometry";
import { useSessionViewport } from "../../runtime/use-session-viewport";
import { AgentIcon } from "../../agent-icon";
import { AgentStatus } from "../../pane-agent-indicators";
import { LiveTerminal } from "../terminal/live-terminal";
export function NativeWindow({
  controlsMount,
  inputEnabled,
  onInput,
  layout,
  layouts,
  runtime,
  theme,
  fontSize,
  focused,
  onFocus,
}: {
  layout: PaneStreamLayoutEvent;
  controlsMount: HTMLDivElement | null;
  layouts: readonly PaneStreamLayoutEvent[];
  inputEnabled: boolean;
  onInput: (pane: string, bytes: Uint8Array) => void;
  runtime: WorkspaceRuntime;
  theme: Theme;
  fontSize: number;
  focused: string | null;
  onFocus: (id: string) => void;
}) {
  const [cell, setCell] = useState({ width: fontSize * 0.61, height: fontSize * 1.25 });
  const [cellsMeasured, setCellsMeasured] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(28);
  const projection = projectWindowGeometry(layout, cell, headerHeight);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!body.current) return;
    const value = parseFloat(
      getComputedStyle(body.current).getPropertyValue("--dw-pane-header-height"),
    );
    if (Number.isFinite(value) && value > 0) setHeaderHeight(value);
  }, []);
  const client = runtime.client;
  const readAsset = useCallback(
    async (assetId: string) => {
      const before = client.getSnapshot();
      const host = getHost();
      const bootstrap = await host.bootstrap();
      if (
        bootstrap.daemon.status !== "connected" ||
        bootstrap.daemon.identity.instanceId !== before.target?.daemon.instanceId
      )
        throw Error("The widget belongs to a different machine connection.");
      const result = await host.daemon.fetchWidgetAsset({ assetId });
      const after = client.getSnapshot();
      if (
        after.generation !== before.generation ||
        after.target?.daemon.instanceId !== before.target?.daemon.instanceId
      )
        throw Error("The machine connection changed.");
      if (result.status !== "ok") throw Error(result.error.reason);
      return result.asset;
    },
    [client],
  );
  const { fitPending, fitError, fitState, autoFit, setAutoFit, fit } = useSessionViewport(
    client,
    body,
    layouts,
    cell,
    cellsMeasured,
  );
  const [zoomPending, setZoomPending] = useState(false);
  const [zoomError, setZoomError] = useState("");
  async function zoom(pane: string) {
    if (zoomPending || !inputEnabled) return;
    const target = runtime.client.getSnapshot().target;
    if (!target) return;
    setZoomPending(true);
    setZoomError("");
    try {
      await runtime.client.dispatch({
        kind: "semantic-intent",
        intent: {
          verb: "workspace.pane.zoom.toggle",
          workspaceName: target.workspaceName,
          semanticPaneId: pane,
          desired: layout.zoomed ? "unzoomed" : "zoomed",
        },
      });
    } catch (e) {
      setZoomError(e instanceof Error ? e.message : "Could not change pane zoom.");
    } finally {
      setZoomPending(false);
    }
  }
  const swap = usePaneSwap(
    client,
    [
      layout.semanticWindowId,
      layout.zoomed,
      ...layout.panes.map((p) => [p.pane, p.left, p.top, p.width, p.height].join(":")),
    ].join("|"),
    inputEnabled && !layout.zoomed,
    setZoomError,
  );
  const [splitPending, setSplitPending] = useState(false);
  async function split(pane: string, direction: "right" | "down") {
    if (splitPending || !inputEnabled || !client.ownsRuntimeAuthority?.("input")) return;
    const target = client.getSnapshot().target;
    if (!target) return;
    setSplitPending(true);
    setZoomError("");
    try {
      client.noteActivity("input");
      await client.dispatch({
        kind: "semantic-intent",
        intent: {
          verb: "workspace.window.split",
          workspaceName: target.workspaceName,
          semanticPaneId: pane,
          direction,
        },
      });
    } catch {
      setZoomError("Could not split the pane. Check input control and try again.");
    } finally {
      setSplitPending(false);
    }
  }
  return (
    <div className="live-native-window">
      {controlsMount &&
        createPortal(
          <>
            {(fitState === "shared" || fitState === "paused" || fitState === "manual") && (
              <span
                className="live-viewport-status"
                role="status"
                title={fitError || "The session keeps its current cell dimensions."}
              >
                <span>
                  {fitState === "shared"
                    ? "Sized by another client"
                    : fitState === "manual"
                      ? "Fixed size"
                      : "Sizing paused"}
                </span>
                <button className="live-viewport-retry" disabled={fitPending} onClick={fit}>
                  {fitPending ? "Fitting…" : "Fit session"}
                </button>
              </span>
            )}
            <details className="live-layout-options">
              <summary title="Terminal sizing options">Layout</summary>
              <div className="live-layout-popover">
                <button
                  title="Resize all tmux windows in this session to fit the available terminal area"
                  disabled={fitPending}
                  onClick={() => void fit()}
                >
                  {fitPending ? "Fitting…" : "Fit session"}
                </button>
                <label className="live-auto-fit">
                  <input
                    type="checkbox"
                    checked={autoFit}
                    onChange={(event) => {
                      setAutoFit(event.target.checked);
                    }}
                  />
                  Follow window size
                </label>
                <p className="live-viewport-description">
                  {fitError ||
                    (autoFit
                      ? "All windows follow this view while it is active."
                      : "The session keeps its current size until you fit it again.")}
                </p>
                <p>
                  Fit session resizes every window in this session, including views in other
                  clients.
                </p>
              </div>
            </details>
          </>,
          controlsMount,
        )}
      {swap.source && (
        <div className="live-swap-hint" role="status">
          Drop on another pane to swap · keyboard: Tab to its title, then Enter · Esc cancels
        </div>
      )}
      {zoomError && (
        <WorkspaceNotice actions={<button onClick={() => setZoomError("")}>Dismiss</button>}>
          {zoomError}
        </WorkspaceNotice>
      )}
      <div className="live-window-scroll" ref={body}>
        <div
          className="live-window-grid"
          style={{
            width: projection.width,
            height: projection.height,
          }}
        >
          {projection.panes.map((p) => {
            if (!p.pane) return null;
            const resource = runtime.shell.terminalInventory?.resources.find(
              (r) => r.id === p.pane,
            );
            const agent = runtime.shell.workspace.sidebar.agents.find((a) => a.paneId === p.pane);
            return (
              <Pane
                data-focused={focused === p.pane}
                data-semantic-pane={p.pane}
                data-drag-source={swap.source === p.pane}
                data-drop-target={swap.target === p.pane}
                key={p.pane}
                style={{
                  left: p.x,
                  top: p.y,
                  width: p.pixelWidth,
                  height: p.pixelHeight,
                }}
                onPointerDownCapture={() => onFocus(p.pane!)}
              >
                <PaneHeader>
                  {agent ? <AgentIcon name={agent.harness} /> : <Prompt size={14} />}
                  <PaneTitle
                    disabled={!inputEnabled || layout.zoomed || swap.pending}
                    aria-label={`Move ${resource?.title ?? "Terminal"}`}
                    title="Drag to swap panes · Enter to pick up, then Enter on another title to swap"
                    {...swap.handle(p.pane)}
                  >
                    {resource?.title ?? "Terminal"}
                  </PaneTitle>
                  {agent && <AgentStatus agent={agent} />}
                  <PaneAction
                    disabled={!inputEnabled || splitPending}
                    aria-label={`Split ${resource?.title ?? "Terminal"} right`}
                    title="Split right"
                    onClick={() => void split(p.pane!, "right")}
                  >
                    <Columns2 size={14} />
                  </PaneAction>
                  <PaneAction
                    disabled={!inputEnabled || splitPending}
                    aria-label={`Split ${resource?.title ?? "Terminal"} down`}
                    title="Split down"
                    onClick={() => void split(p.pane!, "down")}
                  >
                    <Rows2 size={14} />
                  </PaneAction>
                  <PaneAction
                    disabled={zoomPending || !inputEnabled}
                    title={
                      inputEnabled
                        ? "Change tmux pane zoom"
                        : "Take input control to change pane zoom"
                    }
                    aria-label={`${layout.zoomed ? "Unzoom" : "Zoom"} ${resource?.title ?? "terminal"}`}
                    onClick={() => void zoom(p.pane!)}
                  >
                    {layout.zoomed ? "Unzoom" : "Zoom"}
                  </PaneAction>
                </PaneHeader>
                <LiveTerminal
                  readAsset={readAsset}
                  inputEnabled={inputEnabled}
                  onInput={(bytes) => onInput(p.pane!, bytes)}
                  pane={p.pane}
                  cols={p.width}
                  rows={p.contentRows}
                  compositor={runtime.compositor}
                  theme={theme}
                  fontSize={fontSize}
                  onCell={(next) => {
                    setCellsMeasured(true);
                    setCell((previous) =>
                      previous.width === next.width && previous.height === next.height
                        ? previous
                        : next,
                    );
                  }}
                />
              </Pane>
            );
          })}
          {!layout.zoomed &&
            projection.panes.flatMap((p) => {
              if (!p.pane) return [];
              const handles = [];
              if (p.left + p.width < layout.cols)
                handles.push(
                  <LiveDivider
                    key={`${p.pane}:cols`}
                    client={client}
                    pane={p.pane}
                    axis="cols"
                    cells={p.width}
                    maximum={layout.cols - 2}
                    cellPixels={cell.width}
                    enabled={inputEnabled}
                    onError={setZoomError}
                    style={{
                      left: p.x + p.pixelWidth,
                      top: p.y,
                      width: cell.width,
                      height: p.pixelHeight,
                    }}
                  />,
                );
              if (p.top + p.height < layout.rows)
                handles.push(
                  <LiveDivider
                    key={`${p.pane}:rows`}
                    client={client}
                    pane={p.pane}
                    axis="rows"
                    cells={p.contentRows}
                    maximum={layout.rows - 2}
                    cellPixels={cell.height}
                    enabled={inputEnabled}
                    onError={setZoomError}
                    style={{
                      left: p.x,
                      top: p.y + p.pixelHeight,
                      width: p.pixelWidth,
                      height: cell.height,
                    }}
                  />,
                );
              return handles;
            })}
        </div>
      </div>
    </div>
  );
}
