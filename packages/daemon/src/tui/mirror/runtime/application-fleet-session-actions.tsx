/* @jsxImportSource @opentui/solid */
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { WorkspaceSessionCreateResult } from "@tmux-ide/contracts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import { applicationMachineAuthorityManager as manager } from "./application-machine-authority.ts";
import { fetchCanonicalLiveWorkspaceRouting } from "../canonical-workspace-routing.ts";
import { createFleetSession, closeFleetSession } from "./fleet-lifecycle-client.ts";
import { TuiButton } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";

export interface FleetSessionActionPorts {
  getMachine: typeof manager.getMachine;
  create: typeof createFleetSession;
  close: typeof closeFleetSession;
  routing: typeof fetchCanonicalLiveWorkspaceRouting;
}
const defaults: FleetSessionActionPorts = {
  getMachine: manager.getMachine,
  create: createFleetSession,
  close: closeFleetSession,
  routing: fetchCanonicalLiveWorkspaceRouting,
};

/** Passive fleet actions own confirmation only; they never select or attach a session. */
export function ApplicationFleetSessionActions(props: {
  command: ApplicationPaletteCommand | undefined;
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  active: boolean;
  initialName?: string;
  onModalChange(open: boolean): void;
  onCreated?(result: WorkspaceSessionCreateResult, machineId: string): void;
  ports?: FleetSessionActionPorts;
}) {
  const ports = () => props.ports ?? defaults;
  const selected = () =>
    typeof props.command === "object" && props.command.fleet ? props.command : null;
  const identity = () => {
    const command = selected();
    return command
      ? JSON.stringify([
          command.fleet!.machineId,
          command.fleet!.daemonInstanceId,
          command.fleet!.liveSessionId,
          command.sessionName,
        ])
      : null;
  };
  const [mode, setMode] = createSignal<"create" | "close" | null>(null);
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  let revision = 0;
  let lifetime: AbortController | null = null;
  const cancel = () => {
    revision++;
    lifetime?.abort();
    lifetime = null;
    setMode(null);
    setBusy(false);
    setValue("");
    props.onModalChange(false);
  };
  let previous: string | null = null;
  createEffect(() => {
    const key = identity();
    if (!props.active || key !== previous) {
      cancel();
      setMessage("");
    }
    previous = key;
  });
  onCleanup(cancel);
  const begin = (next: "create" | "close") => {
    const command = selected();
    if (
      !props.active ||
      !command ||
      command.fleet!.disabled ||
      busy() ||
      (next === "close" && (command.kind !== "open-session" || !command.fleet!.liveSessionId))
    )
      return;
    cancel();
    setMessage("");
    setMode(next);
    if (next === "create") setValue(props.initialName ?? "");
    props.onModalChange(true);
  };
  const submit = async () => {
    const command = selected();
    const action = mode();
    if (!props.active || !command || !action || busy()) return;
    const text = value().trim();
    if (action === "close" ? text.toLowerCase() !== "yes" : !text) return;
    const target = command.fleet!;
    const key = identity();
    const token = ++revision;
    lifetime?.abort();
    lifetime = new AbortController();
    const signal = lifetime.signal;
    setBusy(true);
    setMessage("");
    const current = () =>
      token === revision && key === identity() && props.active && !signal.aborted;
    try {
      const handle = ports().getMachine(target.machineId);
      const daemon = handle?.read();
      if (
        !handle ||
        target.disabled ||
        handle.endpoint().state !== "ready" ||
        daemon?.instanceId !== target.daemonInstanceId
      )
        throw new Error("The selected host is unavailable or has restarted.");
      const epoch = handle.endpoint().epoch;
      const routing = await ports().routing(daemon, undefined, signal);
      if (!current()) return;
      if (
        handle.endpoint().epoch !== epoch ||
        handle.read()?.instanceId !== target.daemonInstanceId ||
        (target.liveSessionId !== "" &&
          !routing.liveSessions.some(
            (session) =>
              session.liveSessionId === target.liveSessionId &&
              session.sessionName === command.sessionName,
          ))
      )
        throw new Error("The selected session has changed. Select it again.");
      const result =
        action === "create"
          ? await ports().create(handle, text)
          : await ports().close(handle, {
              daemonInstanceId: target.daemonInstanceId,
              liveSessionId: target.liveSessionId,
              sessionName: command.sessionName,
            });
      if (!current()) return;
      if (!result)
        throw new Error("The action could not be verified. Refresh the host before retrying.");
      cancel();
      setMessage(
        action === "create"
          ? `Created on ${target.hostLabel}`
          : `Closed ${command.sessionName} on ${target.hostLabel}`,
      );
      if (action === "create")
        props.onCreated?.(result as WorkspaceSessionCreateResult, target.machineId);
    } catch (error) {
      if (current()) setMessage(error instanceof Error ? error.message : "Session action failed.");
    } finally {
      if (current()) setBusy(false);
    }
  };
  useKeyboardRoute((event) => {
    if (!props.active || event.eventType !== "press") return false;
    if (!mode() && event.ctrl && !event.meta && ["n", "x"].includes(event.name.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      begin(event.name.toLowerCase() === "n" ? "create" : "close");
      return true;
    }
    if (!mode()) return false;
    const key = event.name.toLowerCase();
    if (!["escape", "enter", "return", "up", "down", "pageup", "pagedown", "tab"].includes(key))
      return false;
    event.preventDefault();
    event.stopPropagation();
    if (key === "escape") cancel();
    else if (key === "enter" || key === "return") void submit();
    return true;
  });
  return (
    <Show when={selected()}>
      <box height={2} flexDirection="column">
        <box height={1} flexDirection="row">
          <TuiButton
            theme={props.theme}
            size="compact"
            label="New on host ^N"
            disabled={!props.active || selected()?.fleet?.disabled || busy()}
            onPress={() => begin("create")}
          />
          <TuiButton
            theme={props.theme}
            size="compact"
            label="Close session ^X"
            variant="danger"
            disabled={
              !props.active ||
              selected()?.fleet?.disabled ||
              selected()?.kind !== "open-session" ||
              !selected()?.fleet?.liveSessionId ||
              busy()
            }
            onPress={() => begin("close")}
          />
        </box>
        <text height={1} fg={props.theme.roles.text.secondary}>
          {message()}
        </text>
      </box>
      <Show when={mode()}>
        <Dialog
          theme={props.theme}
          viewportWidth={props.width}
          viewportHeight={props.height}
          width={Math.max(1, Math.min(68, props.width - 2))}
          height={Math.max(1, Math.min(11, props.height - 2))}
          title={
            mode() === "create"
              ? `New session on ${selected()?.fleet?.hostLabel}`
              : `Close session on ${selected()?.fleet?.hostLabel}`
          }
          footer="Enter confirm · Esc cancel"
          active={true}
          zIndex={1500}
          onDismiss={cancel}
        >
          <text height={2} fg={props.theme.roles.text.primary}>
            {mode() === "create"
              ? "Session name"
              : `Close ${selected()?.sessionName} and all its windows? Type yes to confirm.`}
          </text>
          <input
            focused={!busy()}
            value={value()}
            maxLength={100}
            onInput={setValue}
            onSubmit={() => void submit()}
            placeholder={mode() === "create" ? "New session name" : "yes"}
          />
          <text height={2} fg={props.theme.roles.text.secondary}>
            {busy() ? "Working…" : message()}
          </text>
          <TuiButton
            theme={props.theme}
            label={mode() === "create" ? "Create session" : "Confirm close"}
            variant={mode() === "close" ? "danger" : "primary"}
            disabled={
              busy() ||
              (mode() === "close" ? value().trim().toLowerCase() !== "yes" : !value().trim())
            }
            onPress={() => void submit()}
          />
        </Dialog>
      </Show>
    </Show>
  );
}
