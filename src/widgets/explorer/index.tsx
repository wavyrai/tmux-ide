import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, createMemo, onMount, onCleanup, batch } from "solid-js";
import { Header } from "./header.tsx";
import { FileTree } from "./tree.tsx";
import { Footer } from "./footer.tsx";
import {
  buildRootNodes,
  expandNode,
  collapseNode,
  flattenVisibleNodes,
  refreshExpandedNodes,
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

render(() => {
  const theme = createTheme(themeConfig);
  const dimensions = useTerminalDimensions();
  const ig = createIgnoreFilter(dir);
  const hasGit = isGitRepo(dir);

  const [gitMap, setGitMap] = createSignal(
    hasGit ? getGitStatusMap(dir) : new Map<string, string>(),
  );
  const [branch, setBranch] = createSignal(hasGit ? getGitBranch(dir) : null);
  const [rootNodes, setRootNodes] = createSignal(buildRootNodes(dir, ig, gitMap(), false));
  const [selected, setSelected] = createSignal(0);
  const [showHidden, setShowHidden] = createSignal(false);

  const flatNodes = createMemo(() => flattenVisibleNodes(rootNodes()));

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

  // Keyboard navigation
  useKeyboard((evt) => {
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
        if (current.expanded) {
          collapseNode(current);
        } else {
          expandNode(current, dir, ig, gitMap(), showHidden());
        }
        setRootNodes([...rootNodes()]);
      } else if (current) {
        const targetId = resolveTargetPane();
        if (targetId) {
          openFileInEditor(session, targetId, current.entry.path);
        }
      }
      evt.preventDefault();
    } else if (evt.name === "h" || evt.name === "left") {
      if (current?.expanded) {
        collapseNode(current);
        setRootNodes([...rootNodes()]);
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
      setShowHidden((h) => !h);
      setRootNodes(buildRootNodes(dir, ig, gitMap(), !showHidden()));
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
    <box width={dimensions().width} height={dimensions().height} backgroundColor={toRGBA(theme.bg)}>
      <Header branch={branch()} fileCount={flatNodes().length} theme={theme} />
      <FileTree nodes={flatNodes()} selected={selected()} theme={theme} />
      <Footer theme={theme} />
    </box>
  );
});
