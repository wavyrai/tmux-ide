import "@opentui/solid/runtime-plugin-support";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, batch } from "solid-js";
import { Breadcrumbs } from "./breadcrumbs.tsx";
import { FileTree } from "./tree.tsx";
import { Footer } from "./footer.tsx";
import {
  buildRootNodes,
  expandNode,
  collapseNode,
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
    const [rootNodes, setRootNodes] = createSignal(buildRootNodes(dir, dir, ig, gitMap(), false));
    const [selected, setSelected] = createSignal(0);
    const [showHidden, setShowHidden] = createSignal(false);
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

    const flatNodes = createMemo(() => flattenVisibleNodes(rootNodes()));

    // Set tmux session variable when selection changes
    createEffect(() => {
      const nodes = flatNodes();
      const current = nodes[selected()];
      if (current && !current.entry.isDir) {
        setPreviewFile(current.entry.path);
      } else {
        setPreviewFile(null);
      }
    });

    // Navigation functions
    function navigateInto(dirPath: string): void {
      setHistory((h) => [...h, currentDir()]);
      setCurrentDir(dirPath);
      setSelected(0);
      setRootNodes(buildRootNodes(dirPath, dir, ig, gitMap(), showHidden()));
    }

    function navigateUp(): void {
      const h = history();
      if (h.length > 0) {
        const prev = h[h.length - 1]!;
        setHistory(h.slice(0, -1));
        setCurrentDir(prev);
        setSelected(0);
        setRootNodes(buildRootNodes(prev, dir, ig, gitMap(), showHidden()));
      }
    }

    function navigateTo(absolutePath: string): void {
      setHistory((h) => [...h, currentDir()]);
      setCurrentDir(absolutePath);
      setSelected(0);
      setRootNodes(buildRootNodes(absolutePath, dir, ig, gitMap(), showHidden()));
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

    function toggleDir(node: TreeNode): void {
      if (node.expanded) {
        collapseNode(node);
      } else {
        expandNode(node, dir, ig, gitMap(), showHidden());
      }
      setRootNodes([...rootNodes()]);
    }

    // Keyboard navigation
    useKeyboard((evt) => {
      setInputMode("keyboard");
      const nodes = flatNodes();
      const current = nodes[selected()];

      if (evt.name === "up" || evt.name === "k") {
        setSelected((i) => Math.max(0, i - 1));
        evt.preventDefault();
      } else if (evt.name === "down" || evt.name === "j") {
        setSelected((i) => Math.min(nodes.length - 1, i + 1));
        evt.preventDefault();
      } else if (evt.name === "return" || evt.name === "l" || evt.name === "right") {
        if (current?.entry.isDir) {
          navigateInto(current.entry.absolutePath);
        }
        evt.preventDefault();
      } else if (evt.name === "h" || evt.name === "left") {
        if (current?.expanded) {
          collapseNode(current);
          setRootNodes([...rootNodes()]);
        } else {
          navigateUp();
        }
        evt.preventDefault();
      } else if (evt.name === "backspace" || evt.name === "-") {
        navigateUp();
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
        setShowHidden((h) => !h);
        setRootNodes(buildRootNodes(currentDir(), dir, ig, gitMap(), !showHidden()));
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
        <FileTree
          nodes={flatNodes()}
          selected={selected()}
          theme={theme}
          inputMode={inputMode()}
          onSelect={setSelected}
          onToggleDir={toggleDir}
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
