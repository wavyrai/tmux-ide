import { parseArgs } from "node:util";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, createMemo, onCleanup, Show, For } from "solid-js";
import { createTheme, type WidgetTheme } from "../lib/theme.ts";
import { getFileDiff } from "../lib/git.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    theme: { type: "string" },
  },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

const MAX_PREVIEW_LINES = 500;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
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
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".node",
  ".wasm",
  ".tgz",
]);

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function getPreviewFile(): string | null {
  if (!session) return null;
  try {
    return (
      execFileSync("tmux", ["show-option", "-t", session, "-v", "@preview_file"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const KEYWORD_RE =
  /^(import|export|from|const|let|var|function|return|if|else|for|while|class|interface|type|async|await|try|catch|throw|new|switch|case|default|break|continue|enum|extends|implements|public|private|protected|static|readonly|abstract|override|declare|module|namespace|def|fn|pub|mut|use|mod|struct|impl|trait|match|loop|where|yield)\b/;

function getLineColor(
  line: string,
  theme: WidgetTheme,
): { r: number; g: number; b: number; a: number } {
  const trimmed = line.trim();
  if (!trimmed) return theme.fg;

  // Comments
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  ) {
    return theme.fgMuted;
  }

  // Strings
  if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) {
    return theme.gitAdded;
  }

  // Keywords
  if (KEYWORD_RE.test(trimmed)) {
    return theme.accent;
  }

  return theme.fg;
}

interface FileData {
  content: string;
  totalLines: number;
  binary: boolean;
  size: string;
}

// Parse diff to get line-level change info for gutter markers
function parseDiffLineMap(diff: string): Map<number, "added" | "modified"> {
  const map = new Map<number, "added" | "modified">();
  if (!diff) return map;
  const lines = diff.split("\n");
  for (const line of lines) {
    // Parse hunk headers: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) continue;
  }
  // Simpler approach: track added lines from the diff
  let newLineNum = 0;
  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1]!, 10);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff")) continue;
    if (line.startsWith("+")) {
      map.set(newLineNum, "added");
      newLineNum++;
    } else if (line.startsWith("-")) {
      // Deleted line — mark the current position as modified
      if (!map.has(newLineNum)) map.set(newLineNum, "modified");
    } else {
      newLineNum++;
    }
  }
  return map;
}

function loadFile(filePath: string): FileData | null {
  const fullPath = filePath.startsWith("/") ? filePath : resolve(dir, filePath);
  if (!existsSync(fullPath)) return null;

  let size: string;
  try {
    size = formatSize(statSync(fullPath).size);
  } catch {
    size = "";
  }

  if (BINARY_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    return { content: "(binary file)", totalLines: 1, binary: true, size };
  }
  try {
    const raw = readFileSync(fullPath, "utf-8");
    if (raw.includes("\0")) {
      return { content: "(binary file)", totalLines: 1, binary: true, size };
    }
    const allLines = raw.split("\n");
    return {
      content: allLines.slice(0, MAX_PREVIEW_LINES).join("\n"),
      totalLines: allLines.length,
      binary: false,
      size,
    };
  } catch {
    return null;
  }
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();
    const [filePath, setFilePath] = createSignal<string | null>(null);
    const [fileContent, setFileContent] = createSignal<string | null>(null);
    const [totalLines, setTotalLines] = createSignal(0);
    const [fileSize, setFileSize] = createSignal("");
    const [isBinary, setIsBinary] = createSignal(false);
    const [fileDiff, setFileDiff] = createSignal<string | null>(null);
    const [viewMode, setViewMode] = createSignal<"content" | "diff">("content");

    // Poll tmux session variable for file path changes
    const interval = setInterval(() => {
      const newPath = getPreviewFile();
      if (newPath !== filePath()) {
        setFilePath(newPath);
        setViewMode("content");
        if (newPath) {
          const result = loadFile(newPath);
          if (result) {
            setFileContent(result.content);
            setTotalLines(result.totalLines);
            setFileSize(result.size);
            setIsBinary(result.binary);
          } else {
            setFileContent(null);
            setTotalLines(0);
            setFileSize("");
            setIsBinary(false);
          }
          // Check for git diff
          try {
            const diff = getFileDiff(dir, newPath, false);
            setFileDiff(diff || null);
          } catch {
            setFileDiff(null);
          }
        } else {
          setFileContent(null);
          setTotalLines(0);
          setFileSize("");
          setIsBinary(false);
          setFileDiff(null);
        }
      }
    }, 200);

    onCleanup(() => clearInterval(interval));

    const lines = createMemo(() => {
      const content = fileContent();
      if (!content) return [];
      return content.split("\n");
    });

    const fileExt = createMemo(() => {
      const fp = filePath();
      return fp ? extname(fp).toLowerCase() : "";
    });

    const lineNumWidth = createMemo(() => Math.max(3, String(totalLines()).length));

    const diffLineMap = createMemo(() => parseDiffLineMap(fileDiff() ?? ""));

    useKeyboard((evt) => {
      if (evt.name === "d") {
        if (fileDiff()) setViewMode((m) => (m === "content" ? "diff" : "content"));
        evt.preventDefault();
      } else if (evt.name === "r" && filePath()) {
        const result = loadFile(filePath()!);
        if (result) {
          setFileContent(result.content);
          setTotalLines(result.totalLines);
          setFileSize(result.size);
          setIsBinary(result.binary);
        }
        try {
          const diff = getFileDiff(dir, filePath()!, false);
          setFileDiff(diff || null);
        } catch {
          setFileDiff(null);
        }
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
        {/* Header */}
        <Show
          when={filePath()}
          fallback={
            <box flexGrow={1} paddingLeft={2} paddingTop={2}>
              <text fg={toRGBA(theme.fgMuted)}>Select a file in the explorer</text>
              <text fg={toRGBA(theme.border)} paddingTop={1}>
                Navigate with ↑↓ keys
              </text>
              <text fg={toRGBA(theme.border)}>Preview updates automatically</text>
            </box>
          }
        >
          <box flexShrink={0} paddingLeft={1} flexDirection="row" gap={2}>
            <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
              {basename(filePath()!)}
            </text>
            <Show when={!isBinary()}>
              <text fg={toRGBA(theme.fgMuted)}>{totalLines()} lines</text>
            </Show>
            <text fg={toRGBA(theme.fgMuted)}>{fileSize()}</text>
            <Show when={fileDiff()}>
              {(() => {
                const lines = fileDiff()!.split("\n");
                const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
                const removed = lines.filter(
                  (l) => l.startsWith("-") && !l.startsWith("---"),
                ).length;
                return (
                  <box flexDirection="row" gap={1}>
                    <Show when={added > 0}>
                      <text fg={toRGBA(theme.gitAdded)}>+{added}</text>
                    </Show>
                    <Show when={removed > 0}>
                      <text fg={toRGBA(theme.gitDeleted)}>-{removed}</text>
                    </Show>
                    <text fg={toRGBA(viewMode() === "diff" ? theme.gitModified : theme.fgMuted)}>
                      {viewMode() === "diff" ? "[diff]" : "[d:diff]"}
                    </text>
                  </box>
                );
              })()}
            </Show>
          </box>

          {/* Separator */}
          <box flexShrink={0} height={1}>
            <text fg={toRGBA(theme.border)} wrapMode="none">
              {"─".repeat(dimensions().width)}
            </text>
          </box>

          {/* Diff view */}
          <Show when={viewMode() === "diff" && fileDiff()}>
            <scrollbox flexGrow={1}>
              <For each={fileDiff()!.split("\n")}>
                {(line) => {
                  const color = line.startsWith("+")
                    ? theme.diffAdded
                    : line.startsWith("-")
                      ? theme.diffRemoved
                      : line.startsWith("@@")
                        ? theme.diffHunk
                        : theme.diffContext;
                  const bg = line.startsWith("+")
                    ? theme.diffAddedBg
                    : line.startsWith("-")
                      ? theme.diffRemovedBg
                      : theme.diffContextBg;
                  return (
                    <box backgroundColor={toRGBA(bg)}>
                      <text fg={toRGBA(color)} wrapMode="none">
                        {line || " "}
                      </text>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </Show>

          {/* Content view */}
          <Show when={viewMode() === "content" && fileContent()}>
            <scrollbox flexGrow={1}>
              <For each={lines()}>
                {(line, lineNum) => {
                  const color = isBinary() ? theme.fgMuted : getLineColor(line, theme);
                  const lineNumber = lineNum() + 1;
                  const changeType = diffLineMap().get(lineNumber);
                  const gutterColor =
                    changeType === "added"
                      ? theme.gitAdded
                      : changeType === "modified"
                        ? theme.gitModified
                        : null;
                  const gutterChar = gutterColor ? "│" : " ";
                  return (
                    <box flexDirection="row">
                      <Show when={!isBinary()}>
                        <text
                          fg={toRGBA(gutterColor ?? theme.diffLineNumber)}
                          flexShrink={0}
                          wrapMode="none"
                        >
                          {gutterChar}
                          {String(lineNumber).padStart(lineNumWidth())}{" "}
                        </text>
                      </Show>
                      <text fg={toRGBA(color)} wrapMode="none">
                        {line || " "}
                      </text>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </Show>

          {/* Footer */}
          <box flexShrink={0} paddingLeft={1}>
            <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
              d:diff view r:refresh q:quit
            </text>
          </box>
        </Show>
      </box>
    );
  },
  {
    targetFps: 30,
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    autoFocus: false,
  },
);
