import { PANE_ACTION_MENU_ITEMS } from "./pane-action-menu-model.ts";
export interface FleetPaletteTarget {
  readonly machineId: string;
  readonly liveSessionId: string;
  readonly hostLabel: string;
  readonly daemonInstanceId: string;
  readonly disabled?: boolean;
  readonly agentActivities?: readonly { paneId: string; attention: boolean; activity: string }[];
}

export interface ApplicationAgentPaletteCommand {
  readonly fleet?: FleetPaletteTarget;
  readonly kind: "jump-agent";
  readonly sessionName: string;
  readonly paneId: string;
  readonly label: string;
}

export interface ApplicationSessionPaletteCommand {
  readonly fleet?: FleetPaletteTarget;
  readonly kind: "open-session";
  readonly sessionName: string;
  readonly label: string;
}

export interface ApplicationMachinePaletteCommand {
  readonly kind: "open-machine";
  readonly sessionName: "";
  readonly label: string;
  readonly fleet: FleetPaletteTarget;
}

export type ApplicationPaletteCommand =
  | "home"
  | "terminals"
  | "appearance"
  | "zoom-pane"
  | "new-window"
  | "split-right"
  | "split-down"
  | "close-pane"
  | ApplicationMachinePaletteCommand
  | ApplicationAgentPaletteCommand
  | ApplicationSessionPaletteCommand;

/** Presentation only: execution remains in the existing application owners. */
export function applicationCommandDescription(command: ApplicationPaletteCommand) {
  if (typeof command === "object" && command.kind === "open-machine")
    return {
      id: JSON.stringify([command.kind, command.fleet.machineId]),
      label: `Machine · ${command.label}`,
      detail: command.fleet.disabled ? "Unavailable" : "Browse sessions or create on this host",
    };
  if (typeof command === "object") {
    const session = command.kind === "open-session";
    return {
      id: JSON.stringify(
        command.fleet
          ? [
              command.kind,
              command.fleet.machineId,
              command.fleet.liveSessionId,
              session ? null : command.paneId,
            ]
          : session
            ? [command.kind, command.sessionName]
            : [command.kind, command.sessionName, command.paneId],
      ),
      label: session
        ? `Open session · ${command.label}${command.fleet ? ` · ${command.fleet.hostLabel}` : ""}`
        : `Jump to ${command.label} · ${command.sessionName}${command.fleet ? ` · ${command.fleet.hostLabel}` : ""}`,
      detail: command.fleet
        ? `${command.fleet.hostLabel} · ${session ? "Session" : "Agent"}${command.fleet.disabled ? " · unavailable" : ""}`
        : session
          ? "Session"
          : "Agent",
    };
  }
  const pane = PANE_ACTION_MENU_ITEMS.find((item) => item.id === command);
  return {
    id: command,
    label:
      pane?.label ??
      (command === "appearance"
        ? "Appearance…"
        : command === "zoom-pane"
          ? "Zoom / unzoom pane"
          : undefined) ??
      (command === "home"
        ? "F1 Home"
        : command === "terminals"
          ? "F2 Terminals"
          : "New terminal window"),
    detail:
      command === "home"
        ? "sessions and agent state"
        : command === "terminals"
          ? "Control the live tmux session"
          : "Current session",
  };
}

export function filterApplicationCommands(
  commands: readonly ApplicationPaletteCommand[],
  query: string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const { label, detail } = applicationCommandDescription(command);
    const text = `${label} ${detail}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
