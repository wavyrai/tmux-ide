/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { testRender, useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "bun:test";
import { RGBA } from "@opentui/core";
import { HomeSurface, homeActionAtProjection } from "./home-surface.tsx";
import { projectHomeSurface } from "./home-surface.ts";
import { FilesSurface } from "./files-surface.tsx";
import { filesHitTest, projectFilesSurface } from "./files-surface.ts";
import { createSemanticThemeSnapshot } from "./theme.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import type { HomeFleetProject, HomeItem } from "./home-model.ts";
import type { FileNode } from "./file-tree.ts";
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
  cursorBg: RGBA.fromInts(120, 170, 255, 255),
  modifiedFg: RGBA.fromInts(255, 210, 110, 255),
  statusLetterFg: {
    M: RGBA.fromInts(255, 190, 100, 255),
    A: RGBA.fromInts(120, 220, 150, 255),
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
  const line = frameLines(frame)[y] ?? "";
  const painted = line.slice(x, x + width);
  expect(terminalDisplayWidth(painted)).toBe(width);
  expect(painted).toContain(label);
  expect(width).toBe(actionChipWidth(label));
}

const fleetProject = (over: Partial<HomeFleetProject>): HomeFleetProject => ({
  name: "workspace",
  dir: "/repo/workspace",
  registered: true,
  running: true,
  sessions: [],
  ...over,
});

const homeItems: HomeItem[] = [
  {
    kind: "session",
    session: "workspace",
    project: "workspace",
    status: "working",
    windows: 2,
    dir: "/repo/workspace",
  },
  { kind: "project", name: "docs", dir: "/repo/docs" },
  { kind: "recent", name: "playground", dir: "/tmp/playground" },
];

const fileNode = (over: Partial<FileNode>): FileNode => ({
  name: "app.ts",
  path: "/repo/workspace/app.ts",
  isDir: false,
  depth: 0,
  expanded: false,
  ignored: false,
  ...over,
});

async function renderHomeHarness(
  width: number,
  height: number,
  variant: "first-run" | "populated",
  options: { items?: HomeItem[]; selectedIndex?: number } = {},
) {
  const calls: string[] = [];
  let latestFrame = "";

  function Harness() {
    const [selected, setSelected] = createSignal(options.selectedIndex ?? 0);
    const projects =
      variant === "first-run"
        ? []
        : [
            fleetProject({
              sessions: [{ name: "workspace", status: "working", windows: [{}, {}] }],
            }),
          ];
    const items = variant === "first-run" ? [] : (options.items ?? homeItems);
    const projection = () =>
      projectHomeSurface({
        width,
        height,
        projects,
        items,
        selectedIndex: selected(),
        hovered: null,
        rollup: {
          blocked: 0,
          working: variant === "first-run" ? 0 : 1,
          done: 0,
          idle: 0,
          unknown: 0,
          totalAgents: variant === "first-run" ? 0 : 1,
        },
        detail: variant === "first-run" ? "open a folder to start" : "workspace · 2 windows",
        footerHint: "enter open · n new session · ^q quit",
        pathPrompt: null,
        sessionPrompt: null,
        quitHint: "^q quit",
        welcomeLine: "Welcome to tmux-ide",
        welcomeActionLabel: "▸ open a folder — press f",
        welcomeTip: "press f to open",
      });
    const run = (id: string) => calls.push(id);
    useKeyboard((event) => {
      if (event.name === "down") setSelected(Math.min(items.length - 1, selected() + 1));
      else if (event.name === "enter") run(`keyboard:${items[selected()]?.kind ?? "none"}`);
    });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const action = homeActionAtProjection(projection(), event.x, event.y);
          if (action) run(`mouse:${action.source}:${action.id}`);
        }}
      >
        <HomeSurface
          theme={THEME}
          projection={projection()}
          rollup={{
            blocked: 0,
            working: variant === "first-run" ? 0 : 1,
            done: 0,
            idle: 0,
            unknown: 0,
            totalAgents: variant === "first-run" ? 0 : 1,
          }}
        />
      </box>
    );
  }

  setup = await testRender(() => <Harness />, { width, height });
  await setup.renderOnce();
  latestFrame = setup.captureCharFrame();
  return {
    calls,
    frame: () => {
      latestFrame = setup!.captureCharFrame();
      return latestFrame;
    },
    clickWelcome: async () => {
      const projection = projectHomeSurface({
        width,
        height,
        projects: [],
        items: [],
        selectedIndex: 0,
        hovered: null,
        rollup: { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0, totalAgents: 0 },
        detail: "open a folder to start",
        footerHint: "enter open · n new session · ^q quit",
        pathPrompt: null,
        sessionPrompt: null,
        quitHint: "^q quit",
        welcomeLine: "Welcome to tmux-ide",
        welcomeActionLabel: "▸ open a folder — press f",
        welcomeTip: "press f to open",
      });
      const action = projection.welcome!.action;
      await setup!.mockMouse.click(action.x + 1, action.y, MouseButtons.LEFT);
    },
    projection: () =>
      projectHomeSurface({
        width,
        height,
        projects:
          variant === "first-run"
            ? []
            : [
                fleetProject({
                  sessions: [{ name: "workspace", status: "working", windows: [{}, {}] }],
                }),
              ],
        items: variant === "first-run" ? [] : (options.items ?? homeItems),
        selectedIndex: options.selectedIndex ?? 0,
        hovered: null,
        rollup: {
          blocked: 0,
          working: variant === "first-run" ? 0 : 1,
          done: 0,
          idle: 0,
          unknown: 0,
          totalAgents: variant === "first-run" ? 0 : 1,
        },
        detail: variant === "first-run" ? "open a folder to start" : "workspace · 2 windows",
        footerHint: "enter open · n new session · ^q quit",
        pathPrompt: null,
        sessionPrompt: null,
        quitHint: "^q quit",
        welcomeLine: "Welcome to tmux-ide",
        welcomeActionLabel: "▸ open a folder — press f",
        welcomeTip: "press f to open",
      }),
  };
}

async function renderFilesHarness(
  width: number,
  height: number,
  variant: "filtered" | "empty" | "error",
) {
  const calls: string[] = [];
  let latestFrame = "";

  function Harness() {
    const [selected, setSelected] = createSignal(0);
    const rows =
      variant === "empty"
        ? []
        : [
            {
              node: fileNode({
                name: "src",
                path: "/repo/workspace/src",
                isDir: true,
                expanded: true,
              }),
              index: 0,
            },
            {
              node: fileNode({ name: "app.ts", path: "/repo/workspace/src/app.ts", depth: 1 }),
              index: 1,
            },
          ];
    const projection = () =>
      projectFilesSurface({
        width,
        height,
        workspaceDir: "/repo/workspace",
        editorPath: variant === "empty" ? null : "/repo/workspace/src/app.ts",
        editorModified: variant === "filtered",
        editorCursor: { row: 0, col: 7 },
        editorLineCount: variant === "empty" ? 0 : 2,
        editorMessage: variant === "error" ? "read failed" : "ready",
        readOnly: variant === "error" ? { kind: "outside-workspace", path: "/tmp/outside" } : null,
        filterQuery: variant === "filtered" ? "app" : null,
        focus: "list",
        showHidden: false,
        showIgnored: false,
        visibleRows: rows,
        totalRows: rows.length,
        fileSelection: selected(),
        fileTop: 0,
        editorVisible:
          variant === "empty"
            ? []
            : [
                {
                  num: 1,
                  text: "export const app = true;",
                  cursorCol: variant === "filtered" ? 7 : null,
                },
                { num: 2, text: "console.log(app);", cursorCol: null },
              ],
        editorTop: 0,
        editorTotalLines: variant === "empty" ? 0 : 2,
        hovered: null,
        statusFor: (node) => (node.name === "app.ts" ? "M" : null),
        readOnlyBanner: variant === "error" ? "outside workspace" : null,
        footerBase: "enter open · / filter · ^q quit",
      });
    useKeyboard((event) => {
      if (event.name === "down") setSelected(Math.min(rows.length - 1, selected() + 1));
      else if (event.name === "enter")
        calls.push(`keyboard:${rows[selected()]?.node.name ?? "none"}`);
      else if (event.name === "/") calls.push("keyboard:filter");
    });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = filesHitTest(projection(), event.x, event.y);
          if (hit?.area === "list" && hit.rowIndex !== undefined)
            calls.push(`mouse:open:${hit.rowIndex}`);
          else if (hit?.area === "header" && hit.actionId) calls.push(`mouse:${hit.actionId}`);
          else calls.push(`mouse:${hit?.area ?? "none"}`);
        }}
      >
        <FilesSurface theme={THEME} projection={projection()} colors={COLORS} />
      </box>
    );
  }

  setup = await testRender(() => <Harness />, { width, height });
  await setup.renderOnce();
  latestFrame = setup.captureCharFrame();
  return {
    calls,
    frame: () => {
      latestFrame = setup!.captureCharFrame();
      return latestFrame;
    },
    clickSelectedRow: async () => {
      const projection = projectFilesSurface({
        width,
        height,
        workspaceDir: "/repo/workspace",
        editorPath: "/repo/workspace/src/app.ts",
        editorModified: true,
        editorCursor: { row: 0, col: 7 },
        editorLineCount: 2,
        editorMessage: "ready",
        readOnly: null,
        filterQuery: "app",
        focus: "list",
        showHidden: false,
        showIgnored: false,
        visibleRows: [
          {
            node: fileNode({
              name: "src",
              path: "/repo/workspace/src",
              isDir: true,
              expanded: true,
            }),
            index: 0,
          },
          {
            node: fileNode({ name: "app.ts", path: "/repo/workspace/src/app.ts", depth: 1 }),
            index: 1,
          },
        ],
        totalRows: 2,
        fileSelection: 0,
        fileTop: 0,
        editorVisible: [
          { num: 1, text: "export const app = true;", cursorCol: 7 },
          { num: 2, text: "console.log(app);", cursorCol: null },
        ],
        editorTop: 0,
        editorTotalLines: 2,
        hovered: null,
        statusFor: (node) => (node.name === "app.ts" ? "M" : null),
        readOnlyBanner: null,
        footerBase: "enter open · / filter · ^q quit",
      });
      const row = projection.rows[0]!;
      await setup!.mockMouse.click(1, row.y, MouseButtons.LEFT);
    },
    clickHeaderAction: async (id: "save" | "reload" | "filter") => {
      const projection = projectFilesSurface({
        width,
        height,
        workspaceDir: "/repo/workspace",
        editorPath: "/repo/workspace/src/app.ts",
        editorModified: true,
        editorCursor: { row: 0, col: 7 },
        editorLineCount: 2,
        editorMessage: "ready",
        readOnly: null,
        filterQuery: "app",
        focus: "list",
        showHidden: false,
        showIgnored: false,
        visibleRows: [
          {
            node: fileNode({
              name: "src",
              path: "/repo/workspace/src",
              isDir: true,
              expanded: true,
            }),
            index: 0,
          },
          {
            node: fileNode({ name: "app.ts", path: "/repo/workspace/src/app.ts", depth: 1 }),
            index: 1,
          },
        ],
        totalRows: 2,
        fileSelection: 0,
        fileTop: 0,
        editorVisible: [
          { num: 1, text: "export const app = true;", cursorCol: 7 },
          { num: 2, text: "console.log(app);", cursorCol: null },
        ],
        editorTop: 0,
        editorTotalLines: 2,
        hovered: null,
        statusFor: (node) => (node.name === "app.ts" ? "M" : null),
        readOnlyBanner: null,
        footerBase: "enter open · / filter · ^q quit",
      });
      const action = projection.actions.find((candidate) => candidate.id === id);
      if (!action) throw new Error(`missing header action ${id}`);
      await setup!.mockMouse.click(
        action.start + Math.floor(action.width / 2),
        0,
        MouseButtons.LEFT,
      );
    },
    projection: () =>
      projectFilesSurface({
        width,
        height,
        workspaceDir: "/repo/workspace",
        editorPath: variant === "empty" ? null : "/repo/workspace/src/app.ts",
        editorModified: variant === "filtered",
        editorCursor: { row: 0, col: 7 },
        editorLineCount: variant === "empty" ? 0 : 2,
        editorMessage: variant === "error" ? "read failed" : "ready",
        readOnly: variant === "error" ? { kind: "outside-workspace", path: "/tmp/outside" } : null,
        filterQuery: variant === "filtered" ? "app" : null,
        focus: "list",
        showHidden: false,
        showIgnored: false,
        visibleRows:
          variant === "empty"
            ? []
            : [
                {
                  node: fileNode({
                    name: "src",
                    path: "/repo/workspace/src",
                    isDir: true,
                    expanded: true,
                  }),
                  index: 0,
                },
                {
                  node: fileNode({ name: "app.ts", path: "/repo/workspace/src/app.ts", depth: 1 }),
                  index: 1,
                },
              ],
        totalRows: variant === "empty" ? 0 : 2,
        fileSelection: 0,
        fileTop: 0,
        editorVisible:
          variant === "empty"
            ? []
            : [
                {
                  num: 1,
                  text: "export const app = true;",
                  cursorCol: variant === "filtered" ? 7 : null,
                },
                { num: 2, text: "console.log(app);", cursorCol: null },
              ],
        editorTop: 0,
        editorTotalLines: variant === "empty" ? 0 : 2,
        hovered: null,
        statusFor: (node) => (node.name === "app.ts" ? "M" : null),
        readOnlyBanner: variant === "error" ? "outside workspace" : null,
        footerBase: "enter open · / filter · ^q quit",
      }),
  };
}

describe("Home and Files surfaces OpenTUI renderer", () => {
  it.each([
    [80, 24, "first-run"],
    [120, 40, "populated"],
    [200, 60, "populated"],
  ] as const)("renders deterministic %sx%s home %s frame", async (width, height, variant) => {
    const harness = await renderHomeHarness(width, height, variant);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("Home");
    if (variant === "first-run") {
      expect(stableFrame(frame)).toContain("open a folder");
      const action = harness.projection().welcome!.action;
      expectPaintedChip(frame, action.x, action.y, action.width, action.label);
    } else {
      expect(stableFrame(frame)).toContain("workspace");
      expect(stableFrame(frame)).toContain("working");
      const projection = harness.projection();
      const rowAction = projection.rows[0]!.actionSpans.at(-1)!;
      expectPaintedChip(
        frame,
        rowAction.start,
        projection.rows[0]!.y,
        rowAction.width,
        rowAction.label,
      );
      for (const action of projection.footerActionSpans) {
        expectPaintedChip(
          frame,
          action.start,
          projection.footerActionY,
          action.width,
          action.label,
        );
      }
    }
  });

  it.each([
    [80, 24, "filtered"],
    [120, 40, "empty"],
    [200, 60, "error"],
  ] as const)("renders deterministic %sx%s files %s frame", async (width, height, variant) => {
    const harness = await renderFilesHarness(width, height, variant);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("Files");
    const projection = harness.projection();
    for (const action of projection.actions) {
      expectPaintedChip(frame, action.start, 0, action.width, action.label);
    }
    if (projection.previewVisible) {
      expect(filesHitTest(projection, projection.list.width - 1, projection.body.y)).toMatchObject({
        area: "list",
      });
      expect(filesHitTest(projection, projection.editor.x, projection.body.y)).toMatchObject({
        area: "editor",
      });
    }
    if (variant === "filtered") expect(stableFrame(frame)).toContain("/app");
    if (variant === "empty") expect(stableFrame(frame)).toContain("No files");
    if (variant === "error") expect(stableFrame(frame)).toContain("outside workspace");
  });

  it("renders compact Home focus-following selected row inside the frame", async () => {
    const many = Array.from(
      { length: 30 },
      (_, index): HomeItem => ({
        kind: "session",
        session: `session-${index}`,
        project: "workspace",
        status: "idle",
        windows: 1,
        dir: "/repo/workspace",
      }),
    );
    const harness = await renderHomeHarness(80, 24, "populated", {
      items: many,
      selectedIndex: 29,
    });
    const frame = harness.frame();
    const projection = harness.projection();
    const selected = projection.rows.find((row) => row.selected)!;
    expect(selected.itemIndex).toBe(29);
    expect(stableFrame(frame)).toContain("session-29");
    const action = selected.actionSpans.at(-1)!;
    expectPaintedChip(frame, action.start, selected.y, action.width, action.label);
  });

  it("routes Home keyboard and mouse through the same local action boundary", async () => {
    const harness = await renderHomeHarness(80, 24, "first-run");
    await harness.clickWelcome();
    await setup!.renderOnce();
    expect(harness.calls).toEqual(["mouse:welcome:open-folder"]);
  });

  it("routes Files keyboard and mouse through the same local action boundary", async () => {
    const harness = await renderFilesHarness(80, 24, "filtered");
    await setup!.mockInput.pressKey("/");
    await setup!.renderOnce();
    await harness.clickHeaderAction("save");
    await setup!.renderOnce();
    await harness.clickHeaderAction("reload");
    await setup!.renderOnce();
    await harness.clickSelectedRow();
    await setup!.renderOnce();
    expect(harness.calls).toEqual([
      "keyboard:filter",
      "mouse:save",
      "mouse:reload",
      "mouse:open:0",
    ]);
  });
});
