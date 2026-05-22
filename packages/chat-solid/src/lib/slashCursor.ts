export type SlashContext = { active: false } | { active: true; slashIndex: number; query: string };

export function detectSlashContext(value: string, caret: number): SlashContext {
  const boundedCaret = Math.max(0, Math.min(caret, value.length));
  if (boundedCaret === 0) return { active: false };

  const slashIndex = value.lastIndexOf("/", boundedCaret - 1);
  if (slashIndex < 0) return { active: false };
  if (slashIndex > 0 && !/\s/.test(value[slashIndex - 1] ?? "")) {
    return { active: false };
  }

  const query = value.slice(slashIndex + 1, boundedCaret);
  if (/\s/.test(query)) return { active: false };

  return { active: true, slashIndex, query };
}
