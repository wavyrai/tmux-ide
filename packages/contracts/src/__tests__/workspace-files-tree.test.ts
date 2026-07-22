import { describe, expect, it } from "vitest";
import type { WorkspaceFileEntry } from "../workspace-files-resource.ts";
import {
  flattenWorkspaceFileTree,
  moveWorkspaceFileSelection,
  sortWorkspaceFileEntries,
  toggleWorkspaceFileExpansion,
  type WorkspaceFileTreeCatalog,
} from "../workspace-files-tree.ts";

const fileId = (token: string) => `file.${token.padEnd(16, "0")}`;
const rootId = fileId("root");
const srcId = fileId("src");
const assetsId = fileId("assets");

const entry = (
  over: Partial<WorkspaceFileEntry> & Pick<WorkspaceFileEntry, "id" | "name">,
): WorkspaceFileEntry => ({
  parentId: rootId,
  relativePath: over.name,
  kind: "file",
  hidden: false,
  ignored: false,
  hasChildren: false,
  gitStatus: null,
  ...over,
});

const rootEntries: WorkspaceFileEntry[] = [
  entry({ id: srcId, name: "src", kind: "directory", hasChildren: true, relativePath: "src" }),
  entry({
    id: assetsId,
    name: "Assets",
    kind: "directory",
    hasChildren: true,
    relativePath: "Assets",
  }),
  entry({ id: fileId("readme"), name: "README.md", relativePath: "README.md" }),
  entry({ id: fileId("app"), name: "app.ts", relativePath: "app.ts" }),
];

const srcCatalog: WorkspaceFileTreeCatalog = {
  directoryId: srcId,
  entries: [
    entry({
      id: fileId("index"),
      parentId: srcId,
      name: "index.ts",
      relativePath: "src/index.ts",
    }),
  ],
};

const catalogs: WorkspaceFileTreeCatalog[] = [
  { directoryId: rootId, entries: rootEntries },
  srcCatalog,
];

describe("workspace file tree projection", () => {
  it("orders directories before files, case-insensitively", () => {
    const names = sortWorkspaceFileEntries(rootEntries).map((e) => e.name);
    expect(names).toEqual(["Assets", "src", "app.ts", "README.md"]);
  });

  it("flattens only expanded, loaded directories", () => {
    const collapsed = flattenWorkspaceFileTree({ rootId, catalogs });
    expect(collapsed.rows.map((r) => r.name)).toEqual(["Assets", "src", "app.ts", "README.md"]);
    const srcRow = collapsed.rows.find((r) => r.id === srcId)!;
    expect(srcRow.expandable).toBe(true);
    expect(srcRow.expanded).toBe(false);
    expect(srcRow.childrenLoaded).toBe(true);
    // The Assets directory has no loaded catalog yet.
    expect(collapsed.rows.find((r) => r.id === assetsId)!.childrenLoaded).toBe(false);

    const expanded = flattenWorkspaceFileTree({ rootId, catalogs, expandedIds: [srcId] });
    const indexRow = expanded.rows.find((r) => r.name === "index.ts");
    expect(indexRow?.depth).toBe(1);
    expect(expanded.rows.find((r) => r.id === srcId)!.expanded).toBe(true);
  });

  it("reports and preserves the selection through the flatten", () => {
    const view = flattenWorkspaceFileTree({ rootId, catalogs, selectedId: srcId });
    expect(view.selectedId).toBe(srcId);
    expect(view.rows[view.selectedIndex]!.id).toBe(srcId);
    // A selection that is not visible collapses to none.
    const gone = flattenWorkspaceFileTree({ rootId, catalogs, selectedId: fileId("ghost") });
    expect(gone.selectedId).toBeNull();
    expect(gone.selectedIndex).toBe(-1);
  });

  it("guards against a catalog cycle instead of looping forever", () => {
    const loopId = fileId("loop");
    const cyclic: WorkspaceFileTreeCatalog[] = [
      {
        directoryId: rootId,
        entries: [
          entry({
            id: loopId,
            name: "loop",
            kind: "directory",
            hasChildren: true,
            relativePath: "loop",
          }),
        ],
      },
      {
        directoryId: loopId,
        entries: [
          entry({
            id: rootId,
            parentId: loopId,
            name: "back",
            kind: "directory",
            hasChildren: true,
            relativePath: "loop/back",
          }),
        ],
      },
    ];
    const view = flattenWorkspaceFileTree({
      rootId,
      catalogs: cyclic,
      expandedIds: [loopId, rootId],
    });
    expect(view.truncated).toBe(true);
    // The walk stops when it revisits the root rather than recursing endlessly.
    expect(view.rows.length).toBeLessThan(5);
  });

  it("toggles expansion immutably", () => {
    const source = new Set([srcId]);
    const expanded = toggleWorkspaceFileExpansion(source, assetsId);
    expect(expanded.has(assetsId)).toBe(true);
    expect(source.has(assetsId)).toBe(false);
    expect(toggleWorkspaceFileExpansion(expanded, srcId, false).has(srcId)).toBe(false);
    expect(toggleWorkspaceFileExpansion(source, srcId).has(srcId)).toBe(false);
  });

  it("moves the selection and clamps at the ends", () => {
    const rows = flattenWorkspaceFileTree({ rootId, catalogs }).rows;
    const first = rows[0]!.id;
    expect(moveWorkspaceFileSelection(rows, null, "down")).toBe(first);
    expect(moveWorkspaceFileSelection(rows, first, "up")).toBe(first);
    expect(moveWorkspaceFileSelection(rows, first, "down")).toBe(rows[1]!.id);
    expect(moveWorkspaceFileSelection([], null, "down")).toBeNull();
  });
});
