import { WorkspaceNotice } from "./components/ui/workspace-notice";
import type { WorkspaceRuntime } from "./runtime/workspace-runtime";
import { NativeWindow } from "./components/workspace/native-window";
import { WindowTabs } from "./components/workspace/window-tabs";
import { openSelectedWorkspace } from "./open-workspace";
import { createTerminalInputQueue } from "./terminal-input";
import { useEffect, useRef, useState } from "react";
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
import { getHost, observeWorkspaceShell } from "./client";
import "@xterm/xterm/css/xterm.css";

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
  const inputRequest = useRef(0);
  const inputBinding = useRef<WebWorkspaceClient | null>(null);
  const [inputError, setInputError] = useState("");
  const [runtime, setRuntime] = useState<WorkspaceRuntime | null>(null);
  const [state, setState] = useState<WorkspacePaneCompositorState | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [controlsMount, setControlsMount] = useState<HTMLDivElement | null>(null);
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
        if (snapshot.phase === "live") setError("");
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
    inputBinding.current = inputClient ?? null;
    inputRequest.current++;
    setClaiming(false);
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
      inputBinding.current = null;
      inputRequest.current++;
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
    const request = ++inputRequest.current;
    const generation = inputClient.getSnapshot().generation;
    const current = () =>
      inputRequest.current === request &&
      inputBinding.current === inputClient &&
      inputClient.getSnapshot().generation === generation;
    setClaiming(true);
    setInputError("");
    try {
      if (inputEnabled) {
        inputQueue.current?.clear();
        await inputClient.releaseAuthority("input");
        if (!current()) return;
        setInputEnabled(false);
      } else {
        inputClient.setPresence("foreground");
        inputClient.noteActivity("focus");
        const lease = await inputClient.requestAuthority("input");
        if (!current()) return;
        const owns = Boolean(lease && inputClient.ownsRuntimeAuthority?.("input"));
        setInputEnabled(owns);
        if (!owns)
          setInputError("Input control is held by another client or the stream is reconnecting.");
      }
    } catch {
      if (current()) setInputError("Could not change input control.");
    } finally {
      if (inputRequest.current === request) setClaiming(false);
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
        <WindowTabs
          value={layout?.semanticWindowId ?? null}
          onValueChange={setWindowId}
          items={layouts
            .filter((item) => item.semanticWindowId !== null)
            .map((item, index) => ({
              id: item.semanticWindowId!,
              name: item.windowName || `Window ${index + 1}`,
              paneCount: item.panes.length,
              zoomed: item.zoomed,
              command:
                runtime?.shell.workspace.sidebar.agents.find((agent) =>
                  item.panes.some((pane) => pane.pane === agent.paneId && pane.active),
                )?.harness ??
                runtime?.shell.workspace.sidebar.agents.find((agent) =>
                  item.panes.some((pane) => pane.pane === agent.paneId),
                )?.harness ??
                "zsh",
            }))}
        />
        <div className="live-layout-mount" ref={setControlsMount} />
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
        <WorkspaceNotice actions={<button onClick={() => setInputError("")}>Dismiss</button>}>
          {inputError}
        </WorkspaceNotice>
      )}
      {fault ? (
        <WorkspaceNotice
          actions={<button onClick={() => setAttempt((a) => a + 1)}>Reconnect</button>}
        >
          {fault}
        </WorkspaceNotice>
      ) : !layout ? (
        <WorkspaceNotice>Opening terminal stream…</WorkspaceNotice>
      ) : null}
      {runtime && layout && (
        <NativeWindow
          layout={layout}
          layouts={layouts}
          controlsMount={controlsMount}
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
