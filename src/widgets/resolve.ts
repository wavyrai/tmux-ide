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

// Widgets run from source with Bun (not bundled dist/)
// The .tsx extension is used at runtime; Bun handles JSX via preload plugin
const WIDGET_ENTRY_POINTS: Record<string, string> = {
  explorer: "explorer/index.tsx",
  changes: "changes/index.tsx",
  preview: "preview/index.tsx",
  tasks: "tasks/index.tsx",
  warroom: "warroom/index.tsx",
  costs: "costs/index.tsx",
  setup: "setup/index.tsx",
};

export function resolveWidgetCommand(type: string, opts: WidgetOptions): string {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);

  // Resolve to src/widgets/ source directory (not dist/)
  // When running from dist/, __dirname is dist/widgets/ — go up to find src/widgets/
  let widgetsDir = __dirname;
  if (widgetsDir.includes("/dist/")) {
    widgetsDir = widgetsDir.replace("/dist/widgets", "/src/widgets");
  }

  const scriptPath = resolve(widgetsDir, entry);
  const args = [`--session=${opts.session}`, `--dir=${opts.dir}`];
  if (opts.target) args.push(`--target=${opts.target}`);
  if (opts.theme) args.push(`--theme='${JSON.stringify(opts.theme)}'`);

  // cd to project root first so bunfig.toml preload is found
  return `cd ${opts.dir} && bun ${scriptPath} ${args.join(" ")}`;
}
