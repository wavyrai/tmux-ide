import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { relative } from "node:path";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, batch, Show } from "solid-js";
import { Breadcrumbs } from "./breadcrumbs.tsx";
import { FileTree } from "./tree.tsx";
import { Footer } from "./footer.tsx";
import {
  buildRootNodes,
  flattenVisibleNodes,
  refreshExpandedNodes,
  type TreeNode,
} from "./tree-model.ts";
import { createIgnoreFilter } from "../lib/files.ts";
import { getGitStatusMap, getGitBranch, isGitRepo } from "../lib/git.ts";
import { watchDirectory, watchGitHead } from "../lib/watcher.ts";
import { createTheme } from "../lib/theme.ts";
import {
  findPaneByTitle,
  sendCommand,
  openFileInEditor,
  findPaneByPattern,
} from "../lib/pane-comms.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    target: { type: "string" },
    theme: { type: "string" },
  },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const targetTitle = values.target ?? null;
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function getTmuxOption(key: string): string | null {
  if (!session) return null;
  try {
    return (
      execFileSync("tmux", ["show-option", "-t", session, "-v", key], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function setTmuxOption(key: string, value: string): void {
  if (!session) return;
  try {
    execFileSync("tmux", ["set-option", "-t", session, key, value], { stdio: "ignore" });
  } catch {}
}

function setPreviewFile(filePath: string | null): void {
  if (!session) return;
  try {
    if (filePath) {
      execFileSync("tmux", ["set-option", "-t", session, "@preview_file", filePath], {
        stdio: "ignore",
      });
    } else {
      execFileSync("tmux", ["set-option", "-t", session, "-u", "@preview_file"], {
        stdio: "ignore",
      });
    }
  } catch {
    // tmux not available or session doesn't exist
  }
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();
    const ig = createIgnoreFilter(dir);
    const hasGit = isGitRepo(dir);

    const [gitMap, setGitMap] = createSignal(
      hasGit ? getGitStatusMap(dir) : new Map<string, string>(),
    );
    const [branch, setBranch] = createSignal(hasGit ? getGitBranch(dir) : null);
    const [currentDir, setCurrentDir] = createSignal(dir);
    const [history, setHistory] = createSignal<string[]>([]);
    const [showHidden, setShowHidden] = createSignal(
      getTmuxOption("@explorer_show_hidden") === "1",
    );
    const [showIgnored, setShowIgnored] = createSignal(
      getTmuxOption("@explorer_show_ignored") === "1",
    );
    const [rootNodes, setRootNodes] = createSignal(
      buildRootNodes(dir, dir, ig, gitMap(), showHidden(), showIgnored()),
    );
    const [selected, setSelected] = createSignal(0);
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");
    const [searchMode, setSearchMode] = createSignal(false);
    const [searchQuery, setSearchQuery] = createSignal("");

    const flatNodes = createMemo(() => flattenVisibleNodes(rootNodes()));

    const visibleNodes = createMemo(() => {
      const nodes = flatNodes();
      if (!searchMode() || !searchQuery()) return nodes;
      const q = searchQuery().toLowerCase();
      return nodes.filter((n) => n.entry.name.toLowerCase().includes(q));
    });

    // Set tmux session variable when selection changes
    createEffect(() => {
      const nodes = visibleNodes();
      const current = nodes[selected()];
      if (current && !current.entry.isDir) {
        setPreviewFile(current.entry.path);
      } else {
        setPreviewFile(null);
      }
    });

    // Navigation functions
    // Check if a directory is inside a gitignored path
    function isInsideIgnored(dirPath: string): boolean {
      const rel = relative(dir, dirPath);
      if (!rel || rel === ".") return false;
      // Check each parent segment
      const parts = rel.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? current + "/" + part : part;
        try {
          if (ig.ignores(current + "/")) return true;
        } catch {}
      }
      return false;
    }

    function effectiveShowIgnored(dirPath: string): boolean {
      return showIgnored() || isInsideIgnored(dirPath);
    }

    function navigateInto(dirPath: string): void {
      setHistory((h) => [...h, currentDir()]);
      setCurrentDir(dirPath);
      setSelected(0);
      setRootNodes(
        buildRootNodes(dirPath, dir, ig, gitMap(), showHidden(), effectiveShowIgnored(dirPath)),
      );
    }

    function navigateUp(): void {
      const h = history();
      if (h.length > 0) {
        const prev = h[h.length - 1]!;
        setHistory(h.slice(0, -1));
        setCurrentDir(prev);
        setSelected(0);
        setRootNodes(
          buildRootNodes(prev, dir, ig, gitMap(), showHidden(), effectiveShowIgnored(prev)),
        );
      }
    }

    function navigateTo(absolutePath: string): void {
      setHistory((h) => [...h, currentDir()]);
      setCurrentDir(absolutePath);
      setSelected(0);
      setRootNodes(
        buildRootNodes(
          absolutePath,
          dir,
          ig,
          gitMap(),
          showHidden(),
          effectiveShowIgnored(absolutePath),
        ),
      );
    }

    // File watcher
    let stopFileWatch: (() => Promise<void>) | null = null;
    let stopHeadWatch: (() => Promise<void>) | null = null;

    onMount(async () => {
      try {
        stopFileWatch = await watchDirectory(dir, () => {
          batch(() => {
            if (hasGit) setGitMap(getGitStatusMap(dir));
            setRootNodes(refreshExpandedNodes(rootNodes(), dir, ig, gitMap(), showHidden()));
          });
        });
      } catch {
        /* watcher unavailable */
      }

      if (hasGit) {
        try {
          stopHeadWatch = await watchGitHead(dir, () => {
            setBranch(getGitBranch(dir));
          });
        } catch {
          /* git head watcher unavailable */
        }
      }
    });

    onCleanup(async () => {
      await stopFileWatch?.();
      await stopHeadWatch?.();
    });

    function resolveTargetPane(): string | null {
      if (!session) return null;
      if (targetTitle) return findPaneByTitle(session, targetTitle);
      return findPaneByPattern(session, "claude");
    }

    function activateNode(node: TreeNode): void {
      if (node.entry.isDir) {
        navigateInto(node.entry.absolutePath);
      }
      // Files: do nothing on click/enter — preview updates via selection effect
    }

    // Keyboard navigation
    useKeyboard((evt) => {
      setInputMode("keyboard");

      // Search mode handling
      if (searchMode()) {
        if (evt.name === "escape") {
          setSearchMode(false);
          setSearchQuery("");
          evt.preventDefault();
          return;
        } else if (evt.name === "backspace") {
          setSearchQuery((q) => q.slice(0, -1));
          evt.preventDefault();
          return;
        } else if (evt.name === "return") {
          setSearchMode(false);
          evt.preventDefault();
          return;
        } else if (evt.name.length === 1 && !evt.ctrl && !evt.alt && !evt.meta) {
          const newQuery = searchQuery() + evt.name;
          setSearchQuery(newQuery);
          const q = newQuery.toLowerCase();
          const matchIdx = flatNodes().findIndex((n) => n.entry.name.toLowerCase().includes(q));
          if (matchIdx !== -1) setSelected(matchIdx);
          evt.preventDefault();
          return;
        }
      }

      const nodes = visibleNodes();
      const current = nodes[selected()];

      if (evt.name === "up" || evt.name === "k") {
        setSelected((i) => Math.max(0, i - 1));
        evt.preventDefault();
      } else if (evt.name === "down" || evt.name === "j") {
        setSelected((i) => Math.min(nodes.length - 1, i + 1));
        evt.preventDefault();
      } else if (evt.name === "return" || evt.name === "l" || evt.name === "right") {
        if (current) activateNode(current);
        evt.preventDefault();
      } else if (
        evt.name === "h" ||
        evt.name === "left" ||
        evt.name === "backspace" ||
        evt.name === "-"
      ) {
        navigateUp();
        evt.preventDefault();
      } else if (evt.name === "/") {
        setSearchMode(true);
        setSearchQuery("");
        evt.preventDefault();
      } else if (evt.name === "]") {
        // Jump to next changed file
        const allNodes = flatNodes();
        const start = selected() + 1;
        for (let i = 0; i < allNodes.length; i++) {
          const idx = (start + i) % allNodes.length;
          if (allNodes[idx]!.gitStatus && !allNodes[idx]!.entry.isDir) {
            setSelected(idx);
            break;
          }
        }
        evt.preventDefault();
      } else if (evt.name === "[") {
        // Jump to prev changed file
        const allNodes = flatNodes();
        const start = selected() - 1 + allNodes.length;
        for (let i = 0; i < allNodes.length; i++) {
          const idx = (start - i + allNodes.length) % allNodes.length;
          if (allNodes[idx]!.gitStatus && !allNodes[idx]!.entry.isDir) {
            setSelected(idx);
            break;
          }
        }
        evt.preventDefault();
      } else if (evt.name === "c" && current && !current.entry.isDir) {
        const targetId = resolveTargetPane();
        if (targetId) {
          sendCommand(session, targetId, `read ${current.entry.path}`);
        }
        evt.preventDefault();
      } else if (evt.name === "o" && current && !current.entry.isDir) {
        const targetId = resolveTargetPane();
        if (targetId) {
          openFileInEditor(session, targetId, current.entry.path);
        }
        evt.preventDefault();
      } else if (evt.shift && evt.name === "h") {
        const next = !showHidden();
        setShowHidden(next);
        setTmuxOption("@explorer_show_hidden", next ? "1" : "0");
        setRootNodes(
          buildRootNodes(currentDir(), dir, ig, gitMap(), next, effectiveShowIgnored(currentDir())),
        );
        setSelected(0);
        evt.preventDefault();
      } else if (evt.shift && evt.name === "i") {
        const next = !showIgnored();
        setShowIgnored(next);
        setTmuxOption("@explorer_show_ignored", next ? "1" : "0");
        setRootNodes(
          buildRootNodes(
            currentDir(),
            dir,
            ig,
            gitMap(),
            showHidden(),
            next || isInsideIgnored(currentDir()),
          ),
        );
        setSelected(0);
        evt.preventDefault();
      } else if (evt.name === "r") {
        batch(() => {
          if (hasGit) {
            setGitMap(getGitStatusMap(dir));
            setBranch(getGitBranch(dir));
          }
          setRootNodes(refreshExpandedNodes(rootNodes(), dir, ig, gitMap(), showHidden()));
        });
        evt.preventDefault();
      } else if (evt.name === "g" && !evt.shift) {
        setSelected(0);
        evt.preventDefault();
      } else if (evt.shift && evt.name === "g") {
        setSelected(nodes.length - 1);
        evt.preventDefault();
      } else if (evt.name === "q") {
        process.exit(0);
      }
    });

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        <Breadcrumbs
          projectRoot={dir}
          currentDir={currentDir()}
          branch={branch()}
          theme={theme}
          onNavigate={navigateTo}
        />
        <Show when={searchMode()}>
          <box flexShrink={0} paddingLeft={1} flexDirection="row" gap={1}>
            <text fg={toRGBA(theme.accent)}>/</text>
            <text fg={toRGBA(theme.fg)}>{searchQuery()}</text>
            <text fg={toRGBA(theme.fgMuted)}>_</text>
          </box>
        </Show>
        <FileTree
          nodes={visibleNodes()}
          selected={selected()}
          theme={theme}
          inputMode={inputMode()}
          onSelect={setSelected}
          onActivate={activateNode}
          onInputModeChange={setInputMode}
        />
        <Footer theme={theme} />
      </box>
    );
  },
  {
    targetFps: 60,
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    autoFocus: false,
  },
);
