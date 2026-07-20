import { describe, expect, it } from "vitest";
import { buildDiffRows, classifyDiff, type DiffEntry } from "./diff-model.ts";
import { changesHitTest, projectChangesSurface } from "./changes-surface.ts";
import { projectTerminalPaneChrome, terminalChromeHitTest } from "./terminal-surface.ts";
import { actionChipWidth } from "./recipes.ts";

const entry = (over: Partial<DiffEntry>): DiffEntry => ({
  group: "unstaged",
  status: "M",
  path: "src/app.ts",
  additions: 12,
  deletions: 3,
  ...over,
});

function changes(width: number, height: number) {
  const data = buildDiffRows([
    entry({ group: "staged", path: "README.md", status: "M", additions: 2, deletions: 0 }),
    entry({ group: "unstaged", path: "src/app.ts", status: "M", additions: 12, deletions: 3 }),
    entry({
      group: "untracked",
      path: "notes/new file.md",
      status: "?",
      additions: 4,
      deletions: 0,
    }),
  ]);
  return projectChangesSurface({
    width,
    height,
    dir: "/repo/workspace",
    fileCount: data.files.length,
    totals: { additions: 18, deletions: 3 },
    filterQuery: "app",
    message: "ready",
    listRows: data.rows.map((row, rowIndex) => ({ row, rowIndex })),
    selectedFileIndex: 1,
    diffLines: classifyDiff(
      "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n context",
    ),
    hovered: { region: "diff", index: 3 },
    footerHint: "]/[ hunk · ^e edit · / filter · r refresh · ^g home · ^q quit",
  });
}

describe("Changes surface projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("keeps %sx%s %s geometry and action cells bounded", (width, height, variant) => {
    const projection = changes(width, height);
    expect(projection.variant).toBe(variant);
    expect(projection.list.x + projection.list.width).toBeLessThanOrEqual(width);
    expect(projection.diff.x + projection.diff.width).toBeLessThanOrEqual(width);
    for (const action of [...projection.headerActions, ...projection.footerActions]) {
      expect(action.width).toBe(actionChipWidth(action.label));
      expect(action.start).toBeGreaterThanOrEqual(0);
      expect(action.start + action.width).toBeLessThanOrEqual(width);
    }
    const selected = projection.listRows.find((row) => row.kind === "file" && row.selected);
    expect(selected?.kind).toBe("file");
    if (selected?.kind === "file" && selected.action) {
      expect(changesHitTest(projection, selected.action.start + 1, selected.y)).toMatchObject({
        area: "list",
        fileIndex: selected.fileIndex,
        actionId: "row-stage",
      });
    }
    const refresh = projection.headerActions[0]!;
    expect(changesHitTest(projection, refresh.start + 1, 0)).toMatchObject({
      area: "header",
      actionId: "refresh",
    });
  });

  it("reports empty state honestly without negative geometry", () => {
    const projection = projectChangesSurface({
      width: 20,
      height: 8,
      dir: "/repo",
      fileCount: 0,
      totals: { additions: 0, deletions: 0 },
      filterQuery: null,
      message: "working tree clean",
      listRows: [],
      selectedFileIndex: 0,
      diffLines: [],
      hovered: null,
      footerHint: "^q quit",
    });
    expect(projection.state).toBe("empty");
    expect(projection.list.width).toBeGreaterThanOrEqual(0);
    expect(projection.body.height).toBeGreaterThanOrEqual(0);
  });
});

describe("Terminal pane chrome projection", () => {
  it.each([
    [40, 10, "compact"],
    [80, 24, "standard"],
    [140, 40, "wide"],
  ] as const)(
    "projects %sx%s %s terminal chrome without touching body cells",
    (width, height, variant) => {
      const projection = projectTerminalPaneChrome({
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
      expect(projection.variant).toBe(variant);
      expect(projection.body.y).toBe(projection.header.height);
      expect(projection.body.height).toBe(
        height - projection.header.height - projection.footer.height,
      );
      for (const action of projection.actions) {
        expect(action.start + action.width).toBeLessThanOrEqual(width);
      }
      const first = projection.actions[0]!;
      expect(terminalChromeHitTest(projection, first.start + 1, 0)).toMatchObject({
        area: "header",
        actionId: first.id,
      });
      expect(terminalChromeHitTest(projection, 1, projection.body.y)).toMatchObject({
        area: "body",
      });
    },
  );
});
