import { PANE_ACTION_MENU_ITEMS } from "./pane-action-menu-model.ts";
import type { ApplicationPaletteCommand } from "../runtime/application-palette-input.ts";

/** Presentation only: execution remains in the existing application owners. */
export function applicationCommandDescription(command: ApplicationPaletteCommand) {
  if (typeof command === "object") {
    const session = command.kind === "open-session";
    return {
      id: JSON.stringify(
        session
          ? [command.kind, command.sessionName]
          : [command.kind, command.sessionName, command.paneId],
      ),
      label: session
        ? `Open session · ${command.label}`
        : `Jump to ${command.label} · ${command.sessionName}`,
      detail: session ? "Session" : "Agent",
    };
  }
  const pane = PANE_ACTION_MENU_ITEMS.find((item) => item.id === command);
  return {
    id: command,
    label:
      pane?.label ??
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
