import { openSelectedWorkspace } from "./open-workspace";
import { fitSessionCells, projectWindowGeometry } from "./window-geometry";
import { createTerminalInputQueue } from "./terminal-input";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ApplicationShellProjectionInputV1 } from "@tmux-ide/contracts";
import type { Theme } from "@superlogical/shared/themes";
import {
  createWebWorkspaceClient,
  paneStreamBridgeForWebWorkspaceClient,
  type WebWorkspaceClient,
} from "../../desktop-renderer/src/runtime/web-workspace-client";
import {
  WorkspacePaneCompositor,
  type WorkspacePaneCompositorState,
} from "../../desktop-renderer/src/terminal/workspace-pane-compositor";
import type { PaneStreamLayoutEvent } from "../../desktop-renderer/src/terminal/pane-stream-transport";
import { getHost, observeWorkspaceShell } from "./client";
import { AgentIcon } from "./agent-icon";
import { AgentStatus } from "./pane-agent-indicators";
import "@xterm/xterm/css/xterm.css";

interface Runtime {
  client: WebWorkspaceClient;
  compositor: WorkspacePaneCompositor;
  shell: ApplicationShellProjectionInputV1;
}

/** A single WorkspaceClient owns transport/recovery. React only owns presentation. */
export function LiveWorkspace({
  sessionId,
  daemonInstanceId,
  selectedPane,
  onSelectedPane,
  theme,
  fontSize,
}: {
  sessionId: string;
  daemonInstanceId: string;
  selectedPane: string;
  onSelectedPane: (id: string) => void;
  theme: Theme;
  fontSize: number;
}) {
  const inputQueue = useRef<ReturnType<typeof createTerminalInputQueue> | null>(null);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [inputError, setInputError] = useState("");
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [state, setState] = useState<WorkspacePaneCompositorState | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let client: WebWorkspaceClient | null = null;
    let compositor: WorkspacePaneCompositor | null = null;
    let unsubscribe: (() => void) | undefined;
    setRuntime(null);
    setState(null);
    setError("");
    void (async () => {
      const host = getHost();
      const boot = await host.bootstrap();
      if (disposed) return;
      if (boot.daemon.status !== "connected") throw Error(boot.daemon.reason);
      if (boot.daemon.identity.instanceId !== daemonInstanceId)
        throw Error("The machine connection changed. Select the session again.");
      const workspaceName = await openSelectedWorkspace(
        host.daemon,
        daemonInstanceId,
        sessionId,
        controller.signal,
      );
      if (disposed) return;
      client = createWebWorkspaceClient({
        host,
        target: { daemon: boot.daemon.identity, workspaceName },
      });
      let paneKey = "";
      const update = () => {
        if (disposed || !client) return;
        const snapshot = client.getSnapshot();
        const shell = snapshot.authorityShell;
        if (
          snapshot.phase === "error" ||
          snapshot.phase === "degraded" ||
          snapshot.phase === "unavailable"
        )
          setError(
            "reason" in snapshot.shell
              ? String(snapshot.shell.reason)
              : `Session ${snapshot.phase}`,
          );
        if (!shell) return;
        observeWorkspaceShell(snapshot.target!.daemon.instanceId, workspaceName, shell, sessionId);
        const panes = (shell.terminalInventory?.resources ?? [])
          .filter((p) => p.attachability.status === "available")
          .map((p) => p.id);
        if (!panes.length) {
          setError("This session has no attachable panes.");
          return;
        }
        const nextKey = panes.join("\0");
        if (!compositor) {
          compositor = new WorkspacePaneCompositor({
            workspaceName,
            panes,
            transport: paneStreamBridgeForWebWorkspaceClient(client),
            onStateChanged: (value) => {
              if (!disposed) setState(value);
            },
          });
          compositor.start();
        } else if (paneKey !== nextKey) compositor.setPanes(panes);
        paneKey = nextKey;
        setRuntime({ client, compositor, shell });
      };
      unsubscribe = client.subscribe("lifecycle", update);
      update();
    })().catch((e) => {
      if (!disposed) setError(e instanceof Error ? e.message : "Cannot open the session.");
    });
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe?.();
      compositor?.dispose();
      void client?.dispose();
    };
  }, [sessionId, daemonInstanceId, attempt]);
  const inputClient = runtime?.client;
  useEffect(() => {
    setInputEnabled(false);
    setInputError("");
    if (!inputClient) return;
    const client = inputClient;
    const queue = createTerminalInputQueue(
      {
        authority: () =>
          client.ownsRuntimeAuthority?.("input")
            ? `${client.getSnapshot().generation}:${client.runtimeAuthorityClientId?.("input")}`
            : null,
        send: (pane, input) =>
          client.sendTerminalInput(
            { workspaceName: client.getSnapshot().target!.workspaceName, semanticPaneId: pane },
            input,
          ),
      },
      (reason) => {
        setInputError(reason);
        setInputEnabled(false);
      },
    );
    inputQueue.current = queue;
    const unsubscribe = client.subscribe("authority", () =>
      setInputEnabled(Boolean(client.ownsRuntimeAuthority?.("input"))),
    );
    const presence = () =>
      client.setPresence(
        document.visibilityState === "visible" && document.hasFocus() ? "foreground" : "background",
      );
    window.addEventListener("focus", presence);
    window.addEventListener("blur", presence);
    document.addEventListener("visibilitychange", presence);
    presence();
    return () => {
      queue.dispose();
      inputQueue.current = null;
      unsubscribe();
      window.removeEventListener("focus", presence);
      window.removeEventListener("blur", presence);
      document.removeEventListener("visibilitychange", presence);
    };
  }, [inputClient]);
  async function toggleInput() {
    if (!inputClient || claiming) return;
    setClaiming(true);
    setInputError("");
    try {
      if (inputEnabled) {
        inputQueue.current?.clear();
        await inputClient.releaseAuthority("input");
        setInputEnabled(false);
      } else {
        inputClient.setPresence("foreground");
        inputClient.noteActivity("focus");
        const lease = await inputClient.requestAuthority("input");
        const owns = Boolean(lease && inputClient.ownsRuntimeAuthority?.("input"));
        setInputEnabled(owns);
        if (!owns)
          setInputError("Input control is held by another client or the stream is reconnecting.");
      }
    } catch {
      setInputError("Could not change input control.");
    } finally {
      setClaiming(false);
    }
  }
  const layouts = state?.layouts ?? [];
  const appliedSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!runtime || !selectedPane || appliedSelection.current === selectedPane) return;
    const daemon = runtime.client.getSnapshot().target?.daemon.instanceId;
    const resource = runtime.shell.terminalInventory?.resources.find(
      (p) => `${daemon}:${p.id}` === selectedPane,
    );
    const window = resource && layouts.find((l) => l.panes.some((p) => p.pane === resource.id));
    if (!resource || !window) return;
    appliedSelection.current = selectedPane;
    setFocused(resource.id);
    setWindowId(window.semanticWindowId);
  }, [selectedPane, runtime, layouts]);
  const layout =
    layouts.find((l) => l.semanticWindowId === windowId) ??
    layouts.find((l) => l.currentWindow) ??
    layouts[0];
  const fault = error || state?.fault?.reason;
  return (
    <section className="live-workspace" aria-label="Live tmux workspace">
      <div className="live-workspace-toolbar">
        <nav className="live-window-tabs" aria-label="Tmux windows">
          {layouts.map((item, index) => (
            <button
              key={item.semanticWindowId ?? index}
              aria-current={item === layout ? "page" : undefined}
              onClick={() => setWindowId(item.semanticWindowId)}
            >
              <span className="live-window-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="live-window-label">{item.windowName || `Window ${index + 1}`}</span>
              {item.zoomed ? " · Zoomed" : ""}
            </button>
          ))}
        </nav>
        <div className="live-input-controls">
          <span className="live-view-mode">{inputEnabled ? "Input enabled" : "Read only"}</span>
          <button disabled={!runtime || claiming || !layout} onClick={() => void toggleInput()}>
            {claiming
              ? "Requesting control…"
              : inputEnabled
                ? "Release input control"
                : "Take input control"}
          </button>
        </div>
      </div>
      {inputError && (
        <div role="status" className="live-connection-state">
          {inputError}
        </div>
      )}
      {fault ? (
        <div role="status" className="live-connection-state">
          {fault} <button onClick={() => setAttempt((a) => a + 1)}>Reconnect</button>
        </div>
      ) : !layout ? (
        <div role="status" className="live-connection-state">
          Opening terminal stream…
        </div>
      ) : null}
      {runtime && layout && (
        <NativeWindow
          layout={layout}
          layouts={layouts}
          runtime={runtime}
          inputEnabled={inputEnabled}
          onInput={(pane, bytes) => {
            runtime.client.noteActivity("input");
            inputQueue.current?.enqueue(pane, bytes);
          }}
          theme={theme}
          fontSize={fontSize}
          focused={focused}
          onFocus={(id) => {
            setFocused(id);
            const daemon = runtime.client.getSnapshot().target?.daemon.instanceId;
            if (daemon) onSelectedPane(`${daemon}:${id}`);
          }}
        />
      )}
    </section>
  );
}

function NativeWindow({
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
  layouts: readonly PaneStreamLayoutEvent[];
  inputEnabled: boolean;
  onInput: (pane: string, bytes: Uint8Array) => void;
  runtime: Runtime;
  theme: Theme;
  fontSize: number;
  focused: string | null;
  onFocus: (id: string) => void;
}) {
  const [cell, setCell] = useState({ width: fontSize * 0.61, height: fontSize * 1.25 });
  const projection = projectWindowGeometry(layout, cell, 26);
  const body = useRef<HTMLDivElement>(null);
  const [fitPending, setFitPending] = useState(false);
  const [fitError, setFitError] = useState("");
  const client = runtime.client;
  async function fit() {
    if (fitPending || !body.current) return;
    const cells = fitSessionCells(
      layouts,
      { width: body.current.clientWidth, height: body.current.clientHeight },
      cell,
      26,
    );
    if (!cells) {
      setFitError("This window is too small to fit terminal cells.");
      return;
    }
    setFitPending(true);
    setFitError("");
    try {
      client.setPresence("foreground");
      client.noteActivity("geometry");
      const result = await client.fitViewport(cells.cols, cells.rows);
      if (result !== "ok")
        setFitError(
          result === "geometry-authority-conflict"
            ? "Another client controls window sizing."
            : "The connection changed. Try fitting again.",
        );
    } catch {
      setFitError("Session fitting is unavailable on this connection.");
    } finally {
      setFitPending(false);
    }
  }
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
  return (
    <div className="live-native-window">
      {
        <div className="live-window-controls">
          <button
            title="Resize all tmux windows in this session to fit the available terminal area"
            disabled={fitPending}
            onClick={() => void fit()}
          >
            {fitPending ? "Fitting…" : "Fit session"}
          </button>
        </div>
      }
      {fitError && (
        <div role="status" className="live-connection-state">
          {fitError}
        </div>
      )}
      {zoomError && (
        <div role="status" className="live-connection-state">
          {zoomError}
        </div>
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
              <div
                className="live-pane"
                data-focused={focused === p.pane}
                key={p.pane}
                style={{
                  left: p.x,
                  top: p.y,
                  width: p.pixelWidth,
                  height: p.pixelHeight,
                }}
                onPointerDownCapture={() => onFocus(p.pane!)}
              >
                <header className="live-pane-header">
                  <AgentIcon name={agent?.harness ?? resource?.title ?? "terminal"} />
                  <span>{resource?.title ?? "Terminal"}</span>
                  {agent && <AgentStatus agent={agent} />}
                  <button
                    className="live-pane-action"
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
                  </button>
                </header>
                <LiveTerminal
                  inputEnabled={inputEnabled}
                  onInput={(bytes) => onInput(p.pane!, bytes)}
                  pane={p.pane}
                  cols={p.width}
                  rows={p.height}
                  compositor={runtime.compositor}
                  theme={theme}
                  fontSize={fontSize}
                  onCell={setCell}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LiveTerminal({
  inputEnabled,
  onInput,
  pane,
  cols,
  rows,
  compositor,
  theme,
  fontSize,
  onCell,
}: {
  pane: string;
  inputEnabled: boolean;
  onInput: (bytes: Uint8Array) => void;
  cols: number;
  rows: number;
  compositor: WorkspacePaneCompositor;
  theme: Theme;
  fontSize: number;
  onCell: (value: { width: number; height: number }) => void;
}) {
  const currentInput = useRef({ inputEnabled, onInput });
  currentInput.current = { inputEnabled, onInput };
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    const pending = new Set<() => void>();
    const term = new Terminal({
      cols,
      rows,
      disableStdin: true,
      allowTransparency: true,
      theme: { ...theme.terminal, background: "#00000000" },
      fontFamily: '"Geist Mono Variable", monospace',
      fontSize,
      lineHeight: 1.25,
      scrollback: 0,
      cursorBlink: false,
    });
    terminal.current = term;
    term.open(mount.current);
    const data = term.onData((text) => {
      if (currentInput.current.inputEnabled)
        currentInput.current.onInput(new TextEncoder().encode(text));
    });
    const binary = term.onBinary((text) => {
      if (currentInput.current.inputEnabled)
        currentInput.current.onInput(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    });
    const measure = () => {
      const screen = mount.current?.querySelector(".xterm-screen");
      if (screen) {
        const r = screen.getBoundingClientRect();
        if (r.width && r.height)
          onCell({ width: r.width / term.cols, height: r.height / term.rows });
      }
    };
    const write = (bytes: Uint8Array) =>
      new Promise<void>((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        const done = () => {
          pending.delete(done);
          resolve();
        };
        pending.add(done);
        term.write(bytes, done);
      });
    const unregister = compositor.registerPaneSink(pane, {
      async applySeedBatch(batch) {
        if (disposed) return;
        term.reset();
        if (batch.reset) term.resize(batch.reset.cols, batch.reset.rows);
        const chunks = [batch.seed, ...batch.held];
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        await write(bytes);
        measure();
      },
      applyGeometry(c, r) {
        if (!disposed) {
          term.resize(c, r);
          measure();
        }
      },
      applyOutput: write,
      applyCursor() {
        /* Canonical ANSI updates already carry the authoritative cursor. */
      },
    });
    const observer = new ResizeObserver(measure);
    observer.observe(mount.current);
    measure();
    return () => {
      disposed = true;
      observer.disconnect();
      data.dispose();
      binary.dispose();
      unregister();
      for (const done of pending) done();
      terminal.current = null;
      term.dispose();
    };
  }, [pane, compositor]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !inputEnabled;
  }, [inputEnabled]);
  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.theme = { ...theme.terminal, background: "#00000000" };
      terminal.current.options.fontSize = fontSize;
    }
  }, [theme, fontSize]);
  return (
    <div
      className="live-terminal"
      ref={mount}
      onPointerDown={() => {
        if (currentInput.current.inputEnabled) terminal.current?.focus();
      }}
      aria-label={`Terminal ${pane}`}
    />
  );
}
