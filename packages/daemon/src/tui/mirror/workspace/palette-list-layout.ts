import type { ApplicationPaletteCommand } from "./application-command-description.ts";

export function paletteSection(command: ApplicationPaletteCommand): string {
  if (command === "switch-session") return "Sessions";
  if (typeof command === "object")
    return command.kind === "jump-agent"
      ? "Agents"
      : command.kind === "open-machine"
        ? "Machines"
        : "Sessions";
  if (command === "home" || command === "terminals") return "Navigation";
  if (command === "appearance") return "Appearance";
  if (command === "shortcuts" || command === "whats-new") return "Help";
  return "Panes";
}

/** Headings consume cells, never command indices or keyboard stops. */
export function paletteListLayout(
  commands: readonly ApplicationPaletteCommand[],
  selected: number,
  capacity: number,
  grouped: boolean,
) {
  const limit = Math.max(1, capacity);
  const sections = commands.map(paletteSection);
  const useGroups = grouped && limit >= 6;
  const focus = Math.max(0, Math.min(selected, commands.length - 1));
  let start = focus;
  let used = useGroups ? 2 : 1;
  while (start > 0) {
    const cost = 1 + (useGroups && sections[start - 1] !== sections[start] ? 2 : 0);
    if (used + cost > limit) break;
    used += cost;
    start--;
  }
  const rows: {
    command: ApplicationPaletteCommand;
    index: number;
    heading: string | null;
    gap: boolean;
  }[] = [];
  used = 0;
  for (let index = start; index < commands.length; index++) {
    const heading =
      useGroups && (index === start || sections[index] !== sections[index - 1])
        ? sections[index]!
        : null;
    const gap = Boolean(heading && index !== start);
    const cost = 1 + (heading ? 1 : 0) + (gap ? 1 : 0);
    if (used + cost > limit) break;
    used += cost;
    rows.push({ command: commands[index]!, index, heading, gap });
  }
  return rows;
}
