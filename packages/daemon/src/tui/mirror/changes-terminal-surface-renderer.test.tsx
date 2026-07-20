/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { testRender, useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "bun:test";
import { RGBA } from "@opentui/core";
import { buildDiffRows, classifyDiff, type DiffEntry } from "./diff-model.ts";
import { ChangesSurface } from "./changes-surface.tsx";
import { changesHitTest, projectChangesSurface } from "./changes-surface.ts";
import { TerminalPaneChrome } from "./terminal-surface.tsx";
import { projectTerminalPaneChrome, terminalChromeHitTest } from "./terminal-surface.ts";
import { createSemanticThemeSnapshot } from "./theme.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { actionChipWidth } from "./recipes.ts";

type TestSetup = Awaited<ReturnType<typeof testRender>>;

let setup: TestSetup | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

const THEME = createSemanticThemeSnapshot({ mode: "dark" });
const COLORS = {
  gutterBg: RGBA.fromInts(24, 26, 34, 255),
  gutterFg: RGBA.fromInts(120, 124, 140, 255),
  statusLetterFg: {
    M: RGBA.fromInts(235, 200, 100, 255),
    "?": RGBA.fromInts(150, 150, 170, 255),
  },
  diffFg: {
    add: RGBA.fromInts(120, 200, 140, 255),
    del: RGBA.fromInts(240, 120, 120, 255),
    hunk: RGBA.fromInts(120, 170, 255, 255),
    meta: RGBA.fromInts(120, 120, 140, 255),
    context: RGBA.fromInts(170, 170, 185, 255),
  },
  diffLineBg: {
    add: RGBA.fromInts(20, 60, 30, 255),
    del: RGBA.fromInts(60, 20, 20, 255),
  },
};

function frameLines(frame: string): string[] {
  const lines = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n");
  return lines.map((line) => line.replace(/\r$/u, ""));
}

function stableFrame(frame: string): string {
  return frameLines(frame)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

function expectFrameBounds(frame: string, width: number, height: number): void {
  const lines = frameLines(frame);
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(width);
}

function expectPaintedChip(
  frame: string,
  x: number,
  y: number,
  width: number,
  label: string,
): void {
  const text = (frameLines(frame)[y] ?? "").slice(x, x + width);
  expect(terminalDisplayWidth(text)).toBe(width);
  expect(text).toContain(label);
  expect(width).toBe(actionChipWidth(label));
}

const entry = (over: Partial<DiffEntry>): DiffEntry => ({
  group: "unstaged",
  status: "M",
  path: "src/app.ts",
  additions: 12,
  deletions: 3,
  ...over,
});

function fixtureRows() {
  return buildDiffRows([
    entry({ group: "staged", path: "README.md", additions: 2, deletions: 0 }),
    entry({ group: "unstaged", path: "src/app.ts", additions: 12, deletions: 3 }),
    entry({ group: "untracked", path: "notes/todo.md", status: "?", additions: 4, deletions: 0 }),
  ]);
}

function changesProjection(
  width: number,
  height: number,
  selected: number,
  hovered: number | null,
) {
  const rows = fixtureRows();
  return projectChangesSurface({
    width,
    height,
    dir: "/repo/workspace",
    fileCount: rows.files.length,
    totals: { additions: 18, deletions: 3 },
    filterQuery: "app",
    message: "ready",
    listRows: rows.rows.map((row, rowIndex) => ({ row, rowIndex })),
    selectedFileIndex: selected,
    diffLines: classifyDiff(
      "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n context",
    ),
    hovered: hovered === null ? null : { region: "diff", index: hovered },
    footerHint: "]/[ hunk · ^e edit · / filter · r refresh · ^g home · ^q quit",
  });
}

async function renderChanges(width: number, height: number) {
  const calls: string[] = [];
  let latest = "";
  function Harness() {
    const [selected, setSelected] = createSignal(1);
    const projection = () => changesProjection(width, height, selected(), null);
    useKeyboard((event) => {
      if (event.name === "down") setSelected(Math.min(2, selected() + 1));
      if (event.name === "r") calls.push("keyboard:refresh");
    });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = changesHitTest(projection(), event.x, event.y);
          if ((hit?.area === "header" || hit?.area === "footer") && hit.actionId)
            calls.push(`mouse:${hit.actionId}`);
          else if (hit?.area === "list" && hit.actionId) calls.push(`mouse:${hit.actionId}`);
          else if (hit?.area === "list" && hit.fileIndex !== undefined) {
            setSelected(hit.fileIndex);
            calls.push(`mouse:select:${hit.fileIndex}`);
          }
        }}
      >
        <ChangesSurface theme={THEME} projection={projection()} colors={COLORS} />
      </box>
    );
  }
  setup = await testRender(() => <Harness />, { width, height });
  await setup.renderOnce();
  latest = setup.captureCharFrame();
  return {
    calls,
    projection: () => changesProjection(width, height, 1, null),
    frame: () => {
      latest = setup!.captureCharFrame();
      return latest;
    },
  };
}

async function renderTerminal(width: number, height: number) {
  const calls: string[] = [];
  function Harness() {
    const projection = () =>
      projectTerminalPaneChrome({
        width,
        height,
        title: "api server",
        paneId: "%7",
        session: "workspace",
        focused: true,
        attention: true,
        scrollOffset: 12,
        scrollbackDepth: 120,
        selected: false,
        zoomed: true,
        sync: true,
        search: "error",
      });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = terminalChromeHitTest(projection(), event.x, event.y);
          if (hit?.area === "header" && hit.actionId) calls.push(`mouse:${hit.actionId}`);
        }}
      >
        <TerminalPaneChrome theme={THEME} projection={projection()}>
          <text fg={THEME.colors.foreground}>framebuffer body stays opaque</text>
        </TerminalPaneChrome>
      </box>
    );
  }
  setup = await testRender(() => <Harness />, { width, height });
  await setup.renderOnce();
  return {
    calls,
    projection: () =>
      projectTerminalPaneChrome({
        width,
        height,
        title: "api server",
        paneId: "%7",
        session: "workspace",
        focused: true,
        attention: true,
        scrollOffset: 12,
        scrollbackDepth: 120,
        selected: false,
        zoomed: true,
        sync: true,
        search: "error",
      }),
    frame: () => setup!.captureCharFrame(),
  };
}

describe("Changes and terminal surfaces OpenTUI renderer", () => {
  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)("renders Changes %sx%s with projected chip parity", async (width, height) => {
    const harness = await renderChanges(width, height);
    const frame = harness.frame();
    const projection = harness.projection();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("Changes");
    for (const action of projection.headerActions)
      expectPaintedChip(frame, action.start, 0, action.width, action.label);
    for (const action of projection.footerActions)
      expectPaintedChip(frame, action.start, projection.footer.y, action.width, action.label);
    const selected = projection.listRows.find((row) => row.kind === "file" && row.selected);
    if (selected?.kind === "file" && selected.action) {
      expectPaintedChip(
        frame,
        selected.action.start,
        selected.y,
        selected.action.width,
        selected.action.label,
      );
    }
  });

  it("routes Changes mouse and keyboard through one action boundary", async () => {
    const harness = await renderChanges(120, 40);
    const projection = harness.projection();
    const refresh = projection.headerActions[0]!;
    await setup!.mockMouse.click(refresh.start + 1, 0, MouseButtons.LEFT);
    await setup!.mockInput.pressKey("r");
    const selected = projection.listRows.find((row) => row.kind === "file" && row.selected);
    if (selected?.kind === "file" && selected.action) {
      await setup!.mockMouse.click(selected.action.start + 1, selected.y, MouseButtons.LEFT);
    }
    expect(harness.calls).toEqual(["mouse:refresh", "keyboard:refresh", "mouse:row-stage"]);
  });

  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)(
    "renders terminal chrome %sx%s without expanding body cells",
    async (width, height) => {
      const harness = await renderTerminal(width, height);
      const frame = harness.frame();
      const projection = harness.projection();
      expectFrameBounds(frame, width, height);
      expect(stableFrame(frame)).toMatchSnapshot();
      expect(stableFrame(frame)).toContain("api server");
      expect(stableFrame(frame)).toContain("framebuffer body");
      expect(projection.body.y).toBe(1);
      const zoom = projection.actions[0]!;
      expectPaintedChip(frame, zoom.start, 0, zoom.width, zoom.label);
      await setup!.mockMouse.click(zoom.start + 1, 0, MouseButtons.LEFT);
      expect(harness.calls).toEqual(["mouse:zoom"]);
    },
  );
});
