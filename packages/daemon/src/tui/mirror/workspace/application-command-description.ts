import { CHROME_ACTIONS } from "./application-action-descriptions.ts";
import type { CommandParam, TmuxServerScope } from "@tmux-ide/contracts";
import { fuzzyTermsMatch as commandSearchMatch } from "../../team/fuzzy.ts";
export { fuzzyTermsMatch as commandSearchMatch } from "../../team/fuzzy.ts";
import { PANE_ACTION_MENU_ITEMS } from "./pane-action-menu-model.ts";
export interface FleetPaletteTarget {
  readonly server?: TmuxServerScope;
  readonly machineId: string;
  readonly liveSessionId: string;
  readonly hostLabel: string;
  readonly daemonInstanceId: string;
  readonly disabled?: boolean;
  readonly favorite?: boolean;
  readonly recentRank?: number;
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

/** A command a plugin registered, from the daemon's command catalog. */
export interface ApplicationPluginPaletteCommand {
  readonly kind: "plugin-command";
  readonly fleet?: undefined;
  /** Catalog id, `plugin.<plugin>.<id>`. */
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly plugin: string;
  readonly dangerous: boolean;
  readonly params: readonly CommandParam[];
}

/** One choice in the step-by-step form a plugin command with parameters opens. */
export interface ApplicationPluginFormPaletteCommand {
  readonly kind: "plugin-form";
  readonly fleet?: undefined;
  /** Unique within the current form step. */
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly disabledReason?: string;
}

export type ApplicationPaletteCommand =
  | "hide-sidebar"
  | "show-sidebar"
  | "switch-session"
  | "help"
  | "shortcuts"
  | "whats-new"
  | "home"
  | "terminals"
  | "appearance"
  | "zoom-pane"
  | "new-agent"
  | "new-window"
  | "split-right"
  | "split-down"
  | "close-pane"
  | ApplicationMachinePaletteCommand
  | ApplicationAgentPaletteCommand
  | ApplicationSessionPaletteCommand
  | ApplicationPluginPaletteCommand
  | ApplicationPluginFormPaletteCommand;

export const PALETTE_REFERENCE_COMMANDS = {
  shortcuts: { label: "Keyboard shortcuts", shortcut: "Ctrl+K", key: "k", page: "shortcuts" },
  "whats-new": { label: "What's new", shortcut: "Ctrl+B", key: "b", page: "changes" },
} as const;

/** Presentation only: execution remains in the existing application owners. */
export function applicationCommandDescription(command: ApplicationPaletteCommand): {
  id: string;
  label: string;
  detail: string;
  shortcut?: string;
} {
  if (command === "new-agent")
    return {
      id: command,
      label: "New agent…",
      detail: "Named Claude or Codex agent in this workspace",
    };
  if (command === "help")
    return { id: command, label: "Using tmux-ide", detail: "Help and getting started" };
  if (command === "hide-sidebar" || command === "show-sidebar")
    return {
      id: command,
      label: command === "hide-sidebar" ? "Hide sidebar" : "Show sidebar",
      detail: "Terminal layout",
      shortcut: CHROME_ACTIONS.sidebar.keys,
    };
  if (command === "switch-session")
    return {
      id: command,
      label: "Switch session",
      shortcut: CHROME_ACTIONS.sessions.keys,
      detail: "Sessions across machines",
    };
  if (command === "shortcuts" || command === "whats-new")
    return { id: command, ...PALETTE_REFERENCE_COMMANDS[command], detail: "Help and reference" };
  if (typeof command === "object" && command.kind === "plugin-command")
    return {
      id: JSON.stringify([command.kind, command.id]),
      label: command.params.length > 0 || command.dangerous ? `${command.label}…` : command.label,
      detail: `${command.category} · ${command.plugin} plugin`,
    };
  if (typeof command === "object" && command.kind === "plugin-form")
    return {
      id: JSON.stringify([command.kind, command.key]),
      label: command.label,
      detail: command.detail,
    };
  if (typeof command === "object" && command.kind === "open-machine")
    return {
      id: JSON.stringify([
        command.kind,
        command.fleet.machineId,
        ...(command.fleet.server
          ? [command.fleet.server.serverId, command.fleet.server.generation]
          : []),
      ]),
      label: `${command.fleet.server ? "Server" : "Machine"} · ${command.label}`,
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
              ...(command.fleet.server
                ? [command.fleet.server.serverId, command.fleet.server.generation]
                : []),
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
      (command === "home" ? "Home" : command === "terminals" ? "Terminals" : "New terminal window"),
    shortcut:
      command === "home"
        ? CHROME_ACTIONS.home.keys
        : command === "terminals"
          ? CHROME_ACTIONS.terminals.keys
          : undefined,
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
  return commands
    .map((command, index) => {
      const { label, detail, shortcut } = applicationCommandDescription(command);
      const score = commandSearchMatch(`${label} ${detail} ${shortcut ?? ""}`, query)?.score;
      const fleet = typeof command === "object" ? command.fleet : undefined;
      return {
        command,
        index,
        score,
        favorite: Boolean(fleet?.favorite),
        recent: fleet?.recentRank ?? 1000,
      };
    })
    .filter((row) => row.score !== undefined)
    .sort(
      (a, b) =>
        (!query.trim()
          ? Number(typeof a.command !== "string") - Number(typeof b.command !== "string")
          : 0) ||
        b.score! - a.score! ||
        Number(b.favorite) - Number(a.favorite) ||
        a.recent - b.recent ||
        a.index - b.index,
    )
    .map((row) => row.command);
}
