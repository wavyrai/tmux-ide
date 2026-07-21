/**
 * The Files surface — explorer + viewer.
 *
 * The tree is the app's own: `filterEntries` applies the H (hidden) and I
 * (ignored) toggles, `sortEntries` orders dirs-then-files, and `buildNodes` /
 * `insertChildrenAt` do the expand. Toggle H and I below and watch what appears
 * — `node_modules` and `.git` stay gone regardless, because ALWAYS_IGNORE says
 * so in the app, not here.
 *
 * The io is what's staged: a real explorer reads the disk, and a browser has no
 * disk. The directory listing below is a fixture; every rule applied to it is
 * the product's.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  buildNodes,
  filterEntries,
  insertChildrenAt,
  sortEntries,
  type FileNode,
  type RawEntry,
} from "@daemon/tui/mirror/file-tree.ts";
import { ACCENT, DEFAULT_BG, DEFAULT_FG, MUTED, TAB_ACTIVE_BG } from "@daemon/tui/mirror/theme.ts";
import { DEMO_PANEL_BG } from "./demo-theme.ts";

const TREE_W = 34;
const VIEW_W = 62;
const ROWS = 16;

/** A fixture filesystem: what `readdir` would hand the app, per directory. */
const FS: Record<string, RawEntry[]> = {
  ".": [
    { name: "packages", isDir: true },
    { name: "docs", isDir: true },
    { name: "node_modules", isDir: true },
    { name: ".git", isDir: true },
    { name: ".env.local", isDir: false },
    { name: "tsconfig.tsbuildinfo", isDir: false, ignored: true },
    { name: "ide.yml", isDir: false },
    { name: "package.json", isDir: false },
    { name: "README.md", isDir: false },
  ],
  "./packages": [
    { name: "daemon", isDir: true },
    { name: "tmux-bridge", isDir: true },
  ],
  "./packages/daemon": [
    { name: "src", isDir: true },
    { name: "package.json", isDir: false },
  ],
  "./docs": [
    { name: "app", isDir: true },
    { name: "tui-web", isDir: true },
  ],
};

const CONTENTS: Record<string, string[]> = {
  "./ide.yml": [
    "name: checkout-api",
    "sidebar: true",
    "rows:",
    "  - size: 70%",
    "    panes:",
    "      - { title: Editor, command: claude, focus: true }",
    "      - { title: Shell }",
    "  - panes:",
    "      - { title: Changes, type: changes }",
    "      - { title: Dev, command: pnpm dev, dir: apps/web }",
  ],
  "./package.json": [
    "{",
    '  "name": "checkout-api",',
    '  "version": "2.8.0",',
    '  "license": "MIT"',
    "}",
  ],
  "./README.md": ["# checkout-api", "", "The payments service.", "", "    pnpm dev"],
  "./.env.local": ["# hidden by default — press H to reveal", "STRIPE_KEY=sk_test_…"],
};

export function FilesScene() {
  const [showHidden, setShowHidden] = createSignal(false);
  const [showIgnored, setShowIgnored] = createSignal(false);
  const [expanded, setExpanded] = createSignal<string[]>([]);
  const [open, setOpen] = createSignal<string>("./ide.yml");

  /** Read a directory through the app's filter + sort. */
  const listing = (dir: string): RawEntry[] =>
    sortEntries(
      filterEntries(FS[dir] ?? [], {
        showHidden: showHidden(),
        showIgnored: showIgnored(),
      }),
    );

  /** The visible tree: root nodes, with expanded dirs' children spliced in by
   *  the app's own `insertChildrenAt`. */
  const nodes = createMemo<FileNode[]>(() => {
    let tree = buildNodes(".", listing("."), 0);
    for (const dir of expanded()) {
      const at = tree.findIndex((n) => n.path === dir);
      if (at === -1) continue;
      const children = buildNodes(dir, listing(dir), tree[at]!.depth + 1);
      tree = insertChildrenAt(tree, at, children);
    }
    return tree;
  });

  const lines = createMemo(() => CONTENTS[open()] ?? ["", "  (binary or unreadable)"]);

  const toggle = (node: FileNode) => {
    if (!node.isDir) {
      setOpen(node.path);
      return;
    }
    setExpanded((e) =>
      e.includes(node.path) ? e.filter((p) => p !== node.path) : [...e, node.path],
    );
  };

  return (
    <box flexDirection="row" backgroundColor={DEFAULT_BG}>
      <box flexDirection="column" width={TREE_W} height={ROWS} paddingLeft={1} overflow="hidden">
        {/* The two visibility toggles the surface actually has. */}
        <box flexDirection="row" gap={1}>
          <text
            fg={showHidden() ? ACCENT : MUTED}
            bg={DEMO_PANEL_BG}
            onMouse={(e) => e.type === "down" && setShowHidden((v) => !v)}
          >
            {` H hidden ${showHidden() ? "on " : "off"} `}
          </text>
          <text
            fg={showIgnored() ? ACCENT : MUTED}
            bg={DEMO_PANEL_BG}
            onMouse={(e) => e.type === "down" && setShowIgnored((v) => !v)}
          >
            {` I ignored ${showIgnored() ? "on " : "off"} `}
          </text>
        </box>
        <box height={1} />

        <For each={nodes().slice(0, ROWS - 3)}>
          {(node) => {
            const isOpen = () => expanded().includes(node.path);
            const selected = () => open() === node.path;
            return (
              <box
                flexDirection="row"
                backgroundColor={selected() ? TAB_ACTIVE_BG : DEFAULT_BG}
                onMouse={(e) => e.type === "down" && toggle(node)}
              >
                <text fg={MUTED}>{"  ".repeat(node.depth)}</text>
                <text fg={node.isDir ? ACCENT : node.ignored ? MUTED : DEFAULT_FG}>
                  {`${node.isDir ? (isOpen() ? "▾ " : "▸ ") : "  "}${node.name}`}
                </text>
              </box>
            );
          }}
        </For>
      </box>

      {/* The viewer. */}
      <box flexDirection="column" width={VIEW_W} height={ROWS} paddingLeft={1} overflow="hidden">
        <text fg={ACCENT}>{open()}</text>
        <box height={1} />
        <Show when={lines().length > 0}>
          <For each={lines().slice(0, ROWS - 3)}>
            {(line, i) => (
              <box flexDirection="row" gap={1}>
                <text fg={DEMO_PANEL_BG}>{String(i() + 1).padStart(3, " ")}</text>
                <text fg={line.trim().startsWith("#") ? MUTED : DEFAULT_FG}>
                  {line.slice(0, VIEW_W - 8)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </box>
  );
}
