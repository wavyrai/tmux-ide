import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThemeConfig } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WidgetOptions {
  session: string;
  dir: string;
  target: string | null;
  theme: ThemeConfig | null;
}

const WIDGET_ENTRY_POINTS: Record<string, string> = {
  explorer: "explorer/index.js",
  changes: "changes/index.js",
};

export function resolveWidgetCommand(type: string, opts: WidgetOptions): string {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);
  const scriptPath = resolve(__dirname, entry);
  const args = [`--session=${opts.session}`, `--dir=${opts.dir}`];
  if (opts.target) args.push(`--target=${opts.target}`);
  if (opts.theme) args.push(`--theme='${JSON.stringify(opts.theme)}'`);
  return `bun ${scriptPath} ${args.join(" ")}`;
}
