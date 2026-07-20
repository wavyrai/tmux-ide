import { describe, expect, it } from "vitest";
import type { HomeFleetProject, HomeItem } from "./home-model.ts";
import {
  homeActionAtProjection,
  homeItemIndexAtProjection,
  projectHomeSurface,
} from "./home-surface.ts";
import { filesHitTest, projectFilesSurface } from "./files-surface.ts";
import type { FileNode } from "./file-tree.ts";
import { actionChipWidth } from "./recipes.ts";

const project = (over: Partial<HomeFleetProject>): HomeFleetProject => ({
  name: "workspace",
  dir: "/repo/workspace",
  registered: false,
  running: true,
  sessions: [],
  ...over,
});

const homeItems: HomeItem[] = [
  {
    kind: "session",
    session: "app",
    project: "workspace",
    status: "working",
    windows: 2,
    dir: "/repo/workspace",
  },
  { kind: "project", name: "docs", dir: "/repo/docs" },
  { kind: "recent", name: "scratch", dir: "/tmp/scratch" },
];

const node = (over: Partial<FileNode>): FileNode => ({
  name: "file.ts",
  path: "/repo/file.ts",
  isDir: false,
  depth: 0,
  expanded: false,
  ignored: false,
  ...over,
});

describe("Home surface projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)(
    "projects bounded %sx%s %s layout and stable row actions",
    (width, height, variant) => {
      const projection = projectHomeSurface({
        width,
        height,
        projects: [project({ sessions: [{ name: "app", status: "working", windows: [{}] }] })],
        items: homeItems,
        selectedIndex: 0,
        hovered: null,
        rollup: { blocked: 0, working: 1, done: 0, idle: 0, unknown: 0, totalAgents: 1 },
        detail: "session app · 2 windows",
        footerHint: "enter open · ^q quit",
        pathPrompt: null,
        sessionPrompt: null,
        quitHint: "^q quit",
        welcomeLine: "Welcome to tmux-ide",
        welcomeActionLabel: "▸ open a folder — press f",
        welcomeTip: "press f to open",
      });

      expect(projection.variant).toBe(variant);
      expect(projection.width).toBe(width);
      expect(projection.height).toBe(height);
      expect(projection.rows.length).toBeGreaterThan(0);
      for (const row of projection.rows) {
        expect(row.y).toBeGreaterThanOrEqual(2);
        expect(row.y).toBeLessThan(projection.footer.y);
        expect(row.width).toBeLessThanOrEqual(width);
        for (const span of row.actionSpans) {
          expect(span.start).toBeGreaterThanOrEqual(0);
          expect(span.start + span.width).toBeLessThanOrEqual(width);
        }
      }

      const selected = projection.rows[0]!;
      const primary = selected.actionSpans.find((span) => span.id === "primary")!;
      expect(primary.width).toBe(actionChipWidth(primary.label));
      const hit = homeActionAtProjection(
        projection,
        primary.start + Math.floor(primary.width / 2),
        selected.y,
      );
      expect(hit).toMatchObject({ source: "row", itemIndex: 0, id: "primary" });
      expect(homeItemIndexAtProjection(projection, 1, selected.y)).toBe(0);
      expect(projection.footerActions.map((action) => action.id)).toEqual([
        "open-folder",
        "new-session",
        "new-agent",
        "open-file",
        "open-diff",
      ]);
      for (const span of projection.footerActionSpans) {
        expect(span.width).toBe(actionChipWidth(span.label));
        expect(span.start + span.width).toBeLessThanOrEqual(width);
      }
    },
  );

  it("keeps selected Home row visible in compact focus-following window", () => {
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
    const projection = projectHomeSurface({
      width: 80,
      height: 24,
      projects: [
        project({
          sessions: many.map((item) => ({ name: item.session, status: "idle", windows: [{}] })),
        }),
      ],
      items: many,
      selectedIndex: 29,
      hovered: null,
      rollup: { blocked: 0, working: 0, done: 0, idle: 30, unknown: 0, totalAgents: 0 },
      detail: "session-29",
      footerHint: "enter open · ^q quit",
      pathPrompt: null,
      sessionPrompt: null,
      quitHint: "^q quit",
      welcomeLine: "Welcome to tmux-ide",
      welcomeActionLabel: "▸ open a folder — press f",
      welcomeTip: "press f to open",
    });

    const selected = projection.rows.find((row) => row.selected);
    expect(selected?.itemIndex).toBe(29);
    expect(selected?.label).toContain("session-29");
    expect(projection.rows[0]!.itemIndex).toBeGreaterThan(0);
    expect(homeItemIndexAtProjection(projection, 1, selected!.y)).toBe(29);
  });

  it("keeps first-run welcome action and rows in one projection", () => {
    const projection = projectHomeSurface({
      width: 80,
      height: 24,
      projects: [],
      items: [],
      selectedIndex: 0,
      hovered: { region: "welcomeopen", index: 0 },
      rollup: { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0, totalAgents: 0 },
      detail: "no sessions yet",
      footerHint: "f open folder · ^q quit",
      pathPrompt: null,
      sessionPrompt: null,
      quitHint: "^q quit",
      welcomeLine: "Welcome to tmux-ide",
      welcomeActionLabel: "▸ open a folder — press f",
      welcomeTip: "press f to open",
    });

    expect(projection.welcome).not.toBeNull();
    expect(projection.rows).toEqual([]);
    const action = projection.welcome!.action;
    expect(homeActionAtProjection(projection, action.x + 1, action.y)).toMatchObject({
      source: "welcome",
      id: "open-folder",
    });
  });
});

describe("Files surface projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("projects bounded %sx%s %s files geometry", (width, height, variant) => {
    const projection = projectFilesSurface({
      width,
      height,
      workspaceDir: "/repo/workspace",
      editorPath: "/repo/workspace/src/app.ts",
      editorModified: true,
      editorCursor: { row: 4, col: 2 },
      editorLineCount: 9,
      editorMessage: "saved",
      readOnly: null,
      filterQuery: "app",
      focus: "list",
      showHidden: false,
      showIgnored: true,
      visibleRows: [
        {
          node: node({ name: "src", path: "/repo/workspace/src", isDir: true, expanded: true }),
          index: 0,
        },
        { node: node({ name: "app.ts", path: "/repo/workspace/src/app.ts", depth: 1 }), index: 1 },
      ],
      totalRows: 2,
      fileSelection: 1,
      fileTop: 0,
      editorVisible: [
        { num: 1, text: "export const app = true;", cursorCol: null },
        { num: 2, text: "console.log(app);", cursorCol: 7 },
      ],
      editorTop: 0,
      editorTotalLines: 2,
      hovered: { region: "files", index: 1 },
      statusFor: (file) => (file.name === "app.ts" ? "M" : null),
      readOnlyBanner: null,
      footerBase: "enter open · / filter · ^q quit",
    });

    expect(projection.variant).toBe(variant);
    expect(projection.list.x + projection.list.width).toBeLessThanOrEqual(width);
    expect(projection.editor.x + projection.editor.width).toBeLessThanOrEqual(width);
    expect(projection.body.y + projection.body.height).toBeLessThanOrEqual(projection.footer.y);
    for (const row of projection.rows) {
      expect(row.y).toBeGreaterThanOrEqual(projection.body.y);
      expect(row.y).toBeLessThan(projection.footer.y);
      expect(row.actions[0]?.id).toBe(row.role === "directory" ? "toggle-directory" : "open");
      expect(row.id).toMatch(/^file:/u);
    }

    const selected = projection.rows.find((row) => row.selected)!;
    for (const action of projection.actions) {
      expect(action.width).toBe(actionChipWidth(action.label));
      expect(action.start + action.width).toBeLessThanOrEqual(width);
    }
    const save = projection.actions.find((action) => action.id === "save");
    expect(save).toBeDefined();
    expect(filesHitTest(projection, save!.start + 1, 0)).toMatchObject({
      area: "header",
      actionId: "save",
    });
    expect(filesHitTest(projection, 1, selected.y)).toMatchObject({
      area: "list",
      rowIndex: 1,
    });
    expect(filesHitTest(projection, projection.editor.x + 2, projection.body.y)).toMatchObject({
      area: "editor",
    });
  });

  it("uses explicit empty and error state metadata", () => {
    const projection = projectFilesSurface({
      width: 80,
      height: 24,
      workspaceDir: "/repo/workspace",
      editorPath: null,
      editorModified: false,
      editorCursor: { row: 0, col: 0 },
      editorLineCount: 0,
      editorMessage: "read failed",
      readOnly: { kind: "outside-workspace", path: "/tmp/escape" },
      filterQuery: null,
      focus: "list",
      showHidden: false,
      showIgnored: false,
      visibleRows: [],
      totalRows: 0,
      fileSelection: 0,
      fileTop: 0,
      editorVisible: [],
      editorTop: 0,
      editorTotalLines: 0,
      hovered: null,
      statusFor: () => null,
      readOnlyBanner: "outside workspace",
      footerBase: "^g home · ^q quit",
    });

    expect(projection.state).toBe("error");
    expect(projection.stateMessage).toBe("outside workspace");
    expect(projection.rows).toEqual([]);
    expect(filesHitTest(projection, 1, projection.body.y)).toMatchObject({ area: "list" });
  });
});
