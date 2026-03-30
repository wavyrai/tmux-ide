import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThemeConfig } from "../types.ts";
import { shellEscape } from "../lib/shell.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WidgetOptions {
  session: string;
  dir: string;
  target: string | null;
  theme: ThemeConfig | null;
}

// The .tsx extension is used at runtime; Bun handles JSX via preload plugin
const WIDGET_ENTRY_POINTS: Record<string, string> = {
  explorer: "explorer/index.tsx",
  changes: "changes/index.tsx",
  preview: "preview/index.tsx",
  tasks: "tasks/index.tsx",
  costs: "costs/index.tsx",
  setup: "setup/index.tsx",
  config: "config/index.tsx",
  "mission-control": "mission-control/index.tsx",
};

export function resolveWidgetCommand(type: string, opts: WidgetOptions): string {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);

  const scriptPath = resolve(__dirname, entry);
  const args = [`--session=${opts.session}`, `--dir=${opts.dir}`];
  if (opts.target) args.push(`--target=${opts.target}`);
  if (opts.theme) args.push(`--theme=${JSON.stringify(opts.theme)}`);

  const escapedArgs = args.map(shellEscape).join(" ");

  // cd to project root first so bunfig.toml preload is found
  return `cd ${shellEscape(opts.dir)} && bun ${shellEscape(scriptPath)} ${escapedArgs}`;
}
