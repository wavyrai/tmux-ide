/* @jsxImportSource @opentui/solid */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CapturedFrame, CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/solid";

import {
  registerPaneSurface,
  type TerminalPaneRenderSource,
} from "../../packages/daemon/src/tui/mirror/pane-surface.tsx";
import {
  createSemanticThemeSnapshot,
  createTerminalPaletteProjection,
} from "../../packages/daemon/src/tui/mirror/theme.ts";
import { projectOpenTuiApplicationShell } from "../../packages/daemon/src/tui/mirror/workspace/application-shell-controller.ts";
import type { PaneScopedTerminalAdapter } from "../../packages/daemon/src/tui/mirror/runtime/pane-scoped-terminal-surface.tsx";
import { ApplicationShellView } from "../../packages/daemon/src/tui/mirror/runtime/application-shell-view.tsx";

const COLS = 160;
const ROWS = 44;
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 18;
const OUTPUT = resolve("docs/public/tui-demo.svg");

const panes = ["pane.claude", "pane.codex", "pane.release", "pane.docs"] as const;

function semantic() {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName: "tmux-ide-demo",
    activeMode: "terminals",
    dockMode: "collapsed",
    activeDockTool: "files",
    focusZone: "terminal",
    focusedPaneId: "pane.claude",
    terminalInputPaneId: "pane.claude",
    paletteOpen: false,
    sessions: [
      { name: "tmux-ide-demo", status: "working" },
      { name: "docs", status: "idle" },
    ],
    activeSession: "tmux-ide-demo",
    agents: [
      { paneId: "pane.claude", name: "talented-toucan", kind: "claude", status: "working" },
      { paneId: "pane.codex", name: "rapid-redwood", kind: "codex", status: "idle" },
    ],
    paneIdentities: panes.map((paneId) => ({ runtimePaneId: paneId, semanticPaneId: paneId })),
    notification: "Live tmux session discovered",
  });
}

function layout() {
  const current = {
    type: "layout" as const,
    semanticWindowId: "window.agents",
    windowName: "agents",
    currentWindow: true,
    cols: 132,
    rows: 41,
    zoomed: false,
    paneBorderStatus: "top" as const,
    panes: [
      { pane: "pane.claude", left: 0, top: 0, width: 76, height: 27, active: true },
      { pane: "pane.codex", left: 76, top: 0, width: 56, height: 27, active: false },
      { pane: "pane.release", left: 0, top: 27, width: 66, height: 14, active: false },
      { pane: "pane.docs", left: 66, top: 27, width: 66, height: 14, active: false },
    ],
  };
  return { current, windows: [current] };
}

const paneLines: Record<string, Array<{ text: string; color?: number; bold?: boolean }>> = {
  "pane.claude": [
    { text: "Claude Code", color: 0x5fd7d7, bold: true },
    { text: "", color: 0xdedee6 },
    { text: "Polishing the OpenTUI release.", color: 0xdedee6 },
    { text: "", color: 0xdedee6 },
    { text: "* Working on agent navigation", color: 0x72d49b },
    { text: "  and pane chrome...", color: 0x8b8b99 },
  ],
  "pane.codex": [
    { text: "Codex", color: 0xb4a1ff, bold: true },
    { text: "", color: 0xdedee6 },
    { text: "Release boundary reviewed.", color: 0xdedee6 },
    { text: "", color: 0xdedee6 },
    { text: "o idle - ready for work", color: 0x8b8b99 },
  ],
  "pane.release": [
    { text: "$ pnpm check", color: 0x5fd7d7, bold: true },
    { text: "", color: 0xdedee6 },
    { text: "check typecheck", color: 0x72d49b },
    { text: "check renderer", color: 0x72d49b },
    { text: "check packed install", color: 0x72d49b },
  ],
  "pane.docs": [
    { text: "$ pnpm docs", color: 0x5fd7d7, bold: true },
    { text: "", color: 0xdedee6 },
    { text: "ready on localhost:3000", color: 0x72d49b },
    { text: "watching for changes...", color: 0x8b8b99 },
  ],
};

function setColor(buffer: Uint16Array, cell: number, color: number): void {
  const offset = cell * 4;
  buffer[offset] = (color >> 16) & 0xff;
  buffer[offset + 1] = (color >> 8) & 0xff;
  buffer[offset + 2] = color & 0xff;
  buffer[offset + 3] = 0xff;
}

function terminalAdapter(): PaneScopedTerminalAdapter {
  const renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    blitPane: (paneId, buffers, width, height, _scroll, foreground, background, options) => {
      buffers.char.fill(32);
      buffers.attributes.fill(0);
      for (let cell = 0; cell < width * height; cell += 1) {
        setColor(buffers.fg, cell, foreground);
        setColor(buffers.bg, cell, background);
      }
      for (const [row, line] of (paneLines[paneId] ?? []).entries()) {
        if (row >= height) break;
        for (const [column, char] of [...line.text.slice(0, width)].entries()) {
          const cell = row * width + column;
          buffers.char[cell] = char.codePointAt(0) ?? 32;
          setColor(buffers.fg, cell, line.color ?? foreground);
          if (line.bold) buffers.attributes[cell] = 1;
        }
      }
      for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
      return null;
    },
  };
  return {
    renderSource,
    paneSelectionSnapshot: () => null,
    paneVersion: () => 1,
    paneSourceEpoch: () => 1,
    subscribePaneVersion: () => () => undefined,
  };
}

async function renderFrame(
  surface: "home" | "terminals",
  paletteOpen: boolean,
): Promise<CapturedFrame> {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const palette = createTerminalPaletteProjection(theme);
  const setup = await testRender(
    () => (
      <ApplicationShellView
        dimensions={() => ({ width: COLS, height: ROWS })}
        surface={() => surface}
        semantic={() => semantic()}
        generationStatus={() => "live"}
        sessions={["tmux-ide-demo", "docs"]}
        selectedSession={() => 0}
        bootstrapNote={() => null}
        paletteOpen={() => paletteOpen}
        terminalRendererSource={() =>
          surface === "terminals" ? { adapter: terminalAdapter(), rendererEpoch: 1 } : null
        }
        layout={layout}
        focusedPane={() => (surface === "terminals" ? "pane.claude" : null)}
        theme={theme}
        palette={palette}
        onOpenSurface={() => undefined}
        onOpenSession={() => undefined}
        onSetPaletteOpen={() => undefined}
        onCycleTheme={() => undefined}
        onSelectPane={() => undefined}
        onResizePreview={() => undefined}
        onResizePane={() => undefined}
      />
    ),
    { width: COLS, height: ROWS },
  );
  await setup.renderOnce();
  const frame = setup.captureSpans();
  setup.renderer.destroy();
  return frame;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rgb(span: CapturedSpan, channel: "fg" | "bg"): string {
  const [red, green, blue] = span[channel].toInts();
  return `rgb(${red} ${green} ${blue})`;
}

function svgFrame(frame: CapturedFrame, index: number): string {
  const rows: string[] = [];
  for (const [row, line] of frame.lines.entries()) {
    let column = 0;
    const backgrounds: string[] = [];
    const text: string[] = [];
    for (const span of line.spans) {
      const width = span.width * CELL_WIDTH;
      backgrounds.push(
        `<rect x="${(column * CELL_WIDTH).toFixed(2)}" y="${(row * CELL_HEIGHT).toFixed(2)}" width="${width.toFixed(2)}" height="${CELL_HEIGHT}" fill="${rgb(span, "bg")}"/>`,
      );
      if (span.text.trim().length > 0) {
        const attributes = span.attributes & 0xff;
        text.push(
          `<text x="${(column * CELL_WIDTH).toFixed(2)}" y="${(row * CELL_HEIGHT + 14).toFixed(2)}" fill="${rgb(span, "fg")}"${attributes & 1 ? ' font-weight="700"' : ""}${attributes & 4 ? ' font-style="italic"' : ""}>${escapeXml(span.text)}</text>`,
        );
      }
      column += span.width;
    }
    rows.push(...backgrounds, ...text);
  }
  return `<g class="demo-frame demo-frame-${index}">${rows.join("")}</g>`;
}

function document(frames: CapturedFrame[]): string {
  const width = COLS * CELL_WIDTH;
  const height = ROWS * CELL_HEIGHT;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description" viewBox="0 0 ${width} ${height}">
  <title id="title">tmux-ide OpenTUI demo</title>
  <desc id="description">An animated tour of the real Home, Terminals, and Commands OpenTUI surfaces.</desc>
  <style>
    text { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; white-space: pre; }
    .demo-frame { opacity: 0; animation: demo-cycle 12s steps(1, end) infinite; }
    .demo-frame-0 { opacity: 1; animation-delay: 0s; }
    .demo-frame-1 { animation-delay: -8s; }
    .demo-frame-2 { animation-delay: -4s; }
    @keyframes demo-cycle { 0%, 31% { opacity: 1; } 32%, 100% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) {
      .demo-frame { animation: none; opacity: 0; }
      .demo-frame-1 { opacity: 1; }
    }
  </style>
  <rect width="100%" height="100%" rx="8" fill="#0f0f14"/>
  ${frames.map(svgFrame).join("\n  ")}
</svg>
`;
}

registerPaneSurface();
const frames = await Promise.all([
  renderFrame("home", false),
  renderFrame("terminals", false),
  renderFrame("terminals", true),
]);
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, document(frames));
process.stdout.write(`Rendered ${OUTPUT} from ${frames.length} production OpenTUI frames.\n`);
