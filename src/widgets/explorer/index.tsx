import "@opentui/solid/runtime-plugin-support";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, batch } from "solid-js";
import { Header } from "./header.tsx";
import { FileTree } from "./tree.tsx";
import { FilePreview } from "./preview.tsx";
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

const MAX_PREVIEW_LINES = 200;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".wasm",
  ".tgz",
]);

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function loadFilePreview(absolutePath: string, relativePath: string): string | null {
  const ext = extname(relativePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return null;
  try {
    const content = readFileSync(absolutePath, "utf-8");
    // Check for binary content (null bytes)
    if (content.includes("\0")) return null;
    return content.split("\n").slice(0, MAX_PREVIEW_LINES).join("\n");
  } catch {
    return null;
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
    const [rootNodes, setRootNodes] = createSignal(buildRootNodes(dir, ig, gitMap(), false));
    const [selected, setSelected] = createSignal(0);
    const [showHidden, setShowHidden] = createSignal(false);
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");
    const [previewContent, setPreviewContent] = createSignal<string | null>(null);
    const [previewPath, setPreviewPath] = createSignal<string | null>(null);
    const [focusArea, setFocusArea] = createSignal<"tree" | "preview">("tree");

    const flatNodes = createMemo(() => flattenVisibleNodes(rootNodes()));

    // Load file preview when selection changes
    createEffect(() => {
      const nodes = flatNodes();
      const current = nodes[selected()];
      if (current && !current.entry.isDir) {
        const content = loadFilePreview(current.entry.absolutePath, current.entry.path);
        if (content !== null) {
          setPreviewContent(content);
          setPreviewPath(current.entry.path);
        } else {
          setPreviewContent("(binary file)");
          setPreviewPath(current.entry.path);
        }
      } else {
        setPreviewContent(null);
        setPreviewPath(null);
      }
    });

    const treeHeight = createMemo(() => {
      const total = dimensions().height;
      // Header: 2, Footer: 2, Separator: 1
      const chrome = 5;
      const available = total - chrome;
      return previewContent() !== null ? Math.floor(available * 0.5) : available;
    });

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
        if (focusArea() === "tree") {
          setSelected((i) => Math.max(0, i - 1));
        }
        evt.preventDefault();
      } else if (evt.name === "down" || evt.name === "j") {
        if (focusArea() === "tree") {
          setSelected((i) => Math.min(nodes.length - 1, i + 1));
        }
        evt.preventDefault();
      } else if (evt.name === "return" || evt.name === "l" || evt.name === "right") {
        if (current?.entry.isDir) {
          toggleDir(current);
        } else if (current) {
          setFocusArea("preview");
        }
        evt.preventDefault();
      } else if (evt.name === "h" || evt.name === "left") {
        if (focusArea() === "preview") {
          setFocusArea("tree");
        } else if (current?.expanded) {
          collapseNode(current);
          setRootNodes([...rootNodes()]);
        }
        evt.preventDefault();
      } else if (evt.name === "tab") {
        setFocusArea((f) => (f === "tree" ? "preview" : "tree"));
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
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        <Header branch={branch()} fileCount={flatNodes().length} theme={theme} />
        <box maxHeight={treeHeight()}>
          <FileTree
            nodes={flatNodes()}
            selected={selected()}
            theme={theme}
            inputMode={inputMode()}
            onSelect={setSelected}
            onToggleDir={toggleDir}
            onInputModeChange={setInputMode}
          />
        </box>
        <FilePreview
          content={previewContent()}
          filePath={previewPath()}
          theme={theme}
          focused={focusArea() === "preview"}
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
