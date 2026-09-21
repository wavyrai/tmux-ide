export interface WorkbenchCommand {
  id: string;
  label: string;
  group: string;
  description?: string;
  disabledReason?: string;
  agent?: string;
  icon?: "terminal" | "home" | "layout" | "columns" | "rows" | "theme";
  shortcut?: string;
  keywords?: readonly string[];
  disabled?: boolean;
  run: () => void;
}

const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Bounded, deterministic ranking: exact, prefix, word start, substring, abbreviation. */
function score(text: string, term: string): number {
  if (text === term) return 100;
  if (text.startsWith(term)) return 80;
  if (text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(term))) return 60;
  if (text.includes(term)) return 40;
  let cursor = 0;
  for (const character of term) {
    const index = text.indexOf(character, cursor);
    if (index < 0) return 0;
    cursor = index + 1;
  }
  return 10;
}

export function rankCommands(
  commands: readonly WorkbenchCommand[],
  query: string,
): WorkbenchCommand[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const ranked = commands
    .map((command, index) => {
      const label = normalize(command.label);
      const aliases = [...(command.keywords ?? []), command.description ?? "", command.group].map(
        normalize,
      );
      const scores = terms.map((term) =>
        Math.max(score(label, term), ...aliases.map((alias) => score(alias, term) * 0.8)),
      );
      return {
        command,
        index,
        score: scores.every(Boolean) ? scores.reduce((a, b) => a + b, 0) : -1,
      };
    })
    .filter((item) => item.score >= 0);
  const groups = new Map<string, typeof ranked>();
  for (const item of ranked) {
    const group = groups.get(item.command.group) ?? [];
    group.push(item);
    groups.set(item.command.group, group);
  }
  // Group by the best match, then rank within each group; this is also keyboard order.
  return [...groups.values()]
    .sort(
      (a, b) => Math.max(...b.map((item) => item.score)) - Math.max(...a.map((item) => item.score)),
    )
    .flatMap((group) =>
      group.sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.command),
    );
}

export function activeCommand(commands: readonly WorkbenchCommand[], id: string | null) {
  return (
    commands.find((command) => command.id === id && !command.disabled) ??
    commands.find((command) => !command.disabled)
  );
}
