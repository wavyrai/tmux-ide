import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";

export interface ApplicationAgentPaletteCommand {
  readonly kind: "jump-agent";
  readonly sessionName: string;
  readonly paneId: string;
  readonly label: string;
}

export type ApplicationPaletteCommand =
  | "home"
  | "terminals"
  | "new-window"
  | "split-right"
  | "split-down"
  | "close-pane"
  | ApplicationAgentPaletteCommand;

const BASE_COMMANDS: readonly ApplicationPaletteCommand[] = [
  "home",
  "terminals",
  "new-window",
  "split-right",
  "split-down",
  "close-pane",
];

/** Agent commands are derived from the same semantic rows as the sidebar. */
export function applicationPaletteCommands(
  semantic: ApplicationShellProjectionV1 | null,
): readonly ApplicationPaletteCommand[] {
  if (!semantic) return BASE_COMMANDS;
  const sessionName =
    semantic.sidebar.sessions.find((session) => session.active)?.label ??
    semantic.sidebar.sessions.find((session) => session.id === semantic.sidebar.activeSessionId)
      ?.label ??
    semantic.workspace.name;
  const agents = semantic.sidebar.agents.flatMap((agent) =>
    agent.paneId
      ? [
          {
            kind: "jump-agent" as const,
            sessionName,
            paneId: agent.paneId,
            label: agent.name,
          },
        ]
      : [],
  );
  return [...BASE_COMMANDS, ...agents];
}

export type ApplicationPaletteKeyAction =
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "activate"; readonly command: ApplicationPaletteCommand }
  | { readonly kind: "close" };

export function applicationPaletteKeyAction(
  key: { readonly name: string },
  paletteOpen: boolean,
  selected: number,
  commands: readonly ApplicationPaletteCommand[] = BASE_COMMANDS,
): ApplicationPaletteKeyAction | null {
  if (!paletteOpen) return null;
  if (commands.length === 0) return null;
  const name = key.name.toLowerCase();
  if (name === "up")
    return { kind: "select", index: (selected - 1 + commands.length) % commands.length };
  if (name === "down") return { kind: "select", index: (selected + 1) % commands.length };
  if (name === "return" || name === "enter") {
    const command = commands[selected];
    return command ? { kind: "activate", command } : null;
  }
  if (name === "f1") return { kind: "activate", command: "home" };
  if (name === "f2") return { kind: "activate", command: "terminals" };
  if (name === "escape") return { kind: "close" };
  return null;
}

/** Palette modality is shared by keyboard, paste, and pointer routing. */
export function applicationPaletteOwnsInput(open: boolean): boolean {
  return open;
}

export type ApplicationPaletteKeyboardDisposition =
  | ApplicationPaletteKeyAction
  | { readonly kind: "block" };

export function applicationPaletteKeyboardDisposition(
  key: { readonly name: string },
  open: boolean,
  selected: number,
  commands?: readonly ApplicationPaletteCommand[],
): ApplicationPaletteKeyboardDisposition | null {
  return (
    applicationPaletteKeyAction(key, open, selected, commands) ?? (open ? { kind: "block" } : null)
  );
}
