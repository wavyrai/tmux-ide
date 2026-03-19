import { IdeError } from "./errors.ts";
import type { IdeConfig } from "../types.ts";

export function printLayout(config: IdeConfig): void {
  const INNER = 40;
  const rows = config.rows ?? [];
  if (rows.length === 0) return;

  for (let r = 0; r < rows.length; r++) {
    const panes = rows[r]!.panes ?? [];
    const count = panes.length || 1;
    const widths: number[] = [];
    let remaining = INNER;
    for (let i = 0; i < count; i++) {
      const w = i < count - 1 ? Math.floor(INNER / count) : remaining;
      widths.push(w);
      remaining -= w;
    }

    // Top border or mid divider
    if (r === 0) {
      let top = "  \u250c";
      for (let i = 0; i < count; i++) {
        top += "\u2500".repeat(widths[i]!);
        top += i < count - 1 ? "\u252c" : "\u2510";
      }
      console.log(top);
    } else {
      console.log("  \u251c" + "\u2500".repeat(INNER + count - 1) + "\u2524");
    }

    // Content line
    const sizeLabel = rows[r]!.size ?? "";
    let line = "  \u2502";
    for (let i = 0; i < count; i++) {
      const title = panes[i]?.title ?? "";
      const w = widths[i]!;
      const pad = Math.max(0, w - title.length);
      const left = Math.floor(pad / 2);
      const right = pad - left;
      line += " ".repeat(left) + title + " ".repeat(right) + "\u2502";
    }
    if (sizeLabel) line += "  " + sizeLabel;
    console.log(line);

    // Bottom border (last row only)
    if (r === rows.length - 1) {
      let bot = "  \u2514";
      for (let i = 0; i < count; i++) {
        bot += "\u2500".repeat(widths[i]!);
        bot += i < count - 1 ? "\u2534" : "\u2518";
      }
      console.log(bot);
    }
  }
}

export function outputError(
  message: string,
  code: string,
  { exitCode = 1 }: { exitCode?: number } = {},
): never {
  throw new IdeError(message, { code, exitCode });
}

export function printCommandError(
  error: IdeError,
  { json = false }: { json?: boolean } = {},
): never {
  if (json) {
    console.error(JSON.stringify(error.toJSON(), null, 2));
  } else {
    console.error(error.message);
  }
  process.exit(error.exitCode ?? 1);
}
