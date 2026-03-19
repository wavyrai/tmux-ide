import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { extname, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, createMemo, onCleanup, Show, For } from "solid-js";
import { createTheme } from "../lib/theme.ts";

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

function loadFile(
  filePath: string,
): { content: string; totalLines: number; binary: boolean } | null {
  const fullPath = filePath.startsWith("/") ? filePath : resolve(dir, filePath);
  if (!existsSync(fullPath)) return null;
  if (BINARY_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    return { content: "(binary file)", totalLines: 1, binary: true };
  }
  try {
    const raw = readFileSync(fullPath, "utf-8");
    if (raw.includes("\0")) return { content: "(binary file)", totalLines: 1, binary: true };
    const allLines = raw.split("\n");
    return {
      content: allLines.slice(0, MAX_PREVIEW_LINES).join("\n"),
      totalLines: allLines.length,
      binary: false,
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

    // Poll tmux session variable for file path changes
    const interval = setInterval(() => {
      const newPath = getPreviewFile();
      if (newPath !== filePath()) {
        setFilePath(newPath);
        if (newPath) {
          const result = loadFile(newPath);
          if (result) {
            setFileContent(result.content);
            setTotalLines(result.totalLines);
          } else {
            setFileContent(null);
            setTotalLines(0);
          }
        } else {
          setFileContent(null);
          setTotalLines(0);
        }
      }
    }, 200);

    onCleanup(() => clearInterval(interval));

    const lines = createMemo(() => {
      const content = fileContent();
      if (!content) return [];
      return content.split("\n");
    });

    const lineNumWidth = createMemo(() => Math.max(3, String(totalLines()).length));

    useKeyboard((evt) => {
      if (evt.name === "q") process.exit(0);
      // r: reload current file
      if (evt.name === "r" && filePath()) {
        const result = loadFile(filePath()!);
        if (result) {
          setFileContent(result.content);
          setTotalLines(result.totalLines);
        }
        evt.preventDefault();
      }
    });

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        {/* Header */}
        <box flexShrink={0} paddingLeft={1} paddingBottom={0} flexDirection="row" gap={1}>
          <Show
            when={filePath()}
            fallback={<text fg={toRGBA(theme.fgMuted)}>No file selected</text>}
          >
            <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
              {basename(filePath()!)}
            </text>
            <text fg={toRGBA(theme.fgMuted)}>{filePath()}</text>
            <Show when={totalLines() > MAX_PREVIEW_LINES}>
              <text fg={toRGBA(theme.fgMuted)}>
                ({totalLines()} lines, showing first {MAX_PREVIEW_LINES})
              </text>
            </Show>
          </Show>
        </box>

        {/* Separator */}
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(dimensions().width)}
          </text>
        </box>

        {/* File content */}
        <Show
          when={fileContent()}
          fallback={
            <box flexGrow={1} paddingLeft={2} paddingTop={2}>
              <text fg={toRGBA(theme.fgMuted)}>
                Select a file in the explorer to preview it here
              </text>
            </box>
          }
        >
          <scrollbox flexGrow={1}>
            <For each={lines()}>
              {(line, lineNum) => (
                <box flexDirection="row">
                  <text fg={toRGBA(theme.diffLineNumber)} flexShrink={0} wrapMode="none">
                    {String(lineNum() + 1).padStart(lineNumWidth())}
                    {" │ "}
                  </text>
                  <text fg={toRGBA(theme.fg)} wrapMode="none">
                    {line || " "}
                  </text>
                </box>
              )}
            </For>
          </scrollbox>
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
