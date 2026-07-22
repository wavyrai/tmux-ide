import { describe, expect, it } from "vitest";
import type { WorkspaceChangeEntry } from "../workspace-changes-resource.ts";
import {
  filterWorkspaceChanges,
  flattenWorkspaceChangesView,
  groupWorkspaceChanges,
  moveWorkspaceChangeSelection,
  summarizeWorkspaceChanges,
} from "../workspace-changes-view.ts";

const changeId = (token: string) => `change.${token.padEnd(16, "0")}`;

const entries: WorkspaceChangeEntry[] = [
  {
    id: changeId("b-unstaged"),
    group: "unstaged",
    status: "modified",
    name: "b.ts",
    relativePath: "src/b.ts",
    originPath: null,
    binary: false,
    additions: 4,
    deletions: 1,
  },
  {
    id: changeId("a-unstaged"),
    group: "unstaged",
    status: "modified",
    name: "a.ts",
    relativePath: "src/a.ts",
    originPath: null,
    binary: false,
    additions: 2,
    deletions: 2,
  },
  {
    id: changeId("staged"),
    group: "staged",
    status: "added",
    name: "new.ts",
    relativePath: "src/new.ts",
    originPath: null,
    binary: false,
    additions: 10,
    deletions: 0,
  },
  {
    id: changeId("binary"),
    group: "untracked",
    status: "untracked",
    name: "logo.png",
    relativePath: "assets/logo.png",
    originPath: null,
    binary: true,
    additions: null,
    deletions: null,
  },
];

describe("workspace changes view projection", () => {
  it("groups entries and sorts each group by path", () => {
    const grouped = groupWorkspaceChanges(entries);
    expect(grouped.staged.map((e) => e.name)).toEqual(["new.ts"]);
    expect(grouped.unstaged.map((e) => e.name)).toEqual(["a.ts", "b.ts"]);
    expect(grouped.untracked.map((e) => e.name)).toEqual(["logo.png"]);
  });

  it("summarizes counts and line totals, ignoring binary counts", () => {
    expect(summarizeWorkspaceChanges(entries)).toEqual({
      staged: 1,
      unstaged: 2,
      untracked: 1,
      total: 4,
      additions: 16,
      deletions: 3,
      binary: 1,
    });
  });

  it("filters by group and by case-insensitive path query", () => {
    expect(filterWorkspaceChanges(entries, { group: "unstaged" }).length).toBe(2);
    expect(filterWorkspaceChanges(entries, { query: "LOGO" }).map((e) => e.name)).toEqual([
      "logo.png",
    ]);
    expect(filterWorkspaceChanges(entries, { group: "staged", query: "b.ts" }).length).toBe(0);
    expect(filterWorkspaceChanges(entries, {}).length).toBe(entries.length);
  });

  it("flattens to group headers followed by their changes", () => {
    const view = flattenWorkspaceChangesView({ entries });
    expect(view.rows.map((r) => (r.kind === "group" ? `#${r.group}` : r.entry!.name))).toEqual([
      "#staged",
      "new.ts",
      "#unstaged",
      "a.ts",
      "b.ts",
      "#untracked",
      "logo.png",
    ]);
    // Header rows carry their group's count and are not selectable.
    const header = view.rows.find((r) => r.kind === "group" && r.group === "unstaged")!;
    expect(header.count).toBe(2);
    expect(header.selectable).toBe(false);
  });

  it("omits a group header when its filtered set is empty", () => {
    const view = flattenWorkspaceChangesView({ entries, filter: { group: "staged" } });
    expect(view.rows.every((r) => r.group === "staged")).toBe(true);
    expect(view.rows.filter((r) => r.kind === "group")).toHaveLength(1);
  });

  it("moves the selection across change rows, skipping headers", () => {
    const rows = flattenWorkspaceChangesView({ entries }).rows;
    const staged = changeId("staged");
    const firstUnstaged = changeId("a-unstaged");
    expect(moveWorkspaceChangeSelection(rows, null, "down")).toBe(staged);
    // Stepping down from the last staged change lands on the first unstaged one.
    expect(moveWorkspaceChangeSelection(rows, staged, "down")).toBe(firstUnstaged);
    expect(moveWorkspaceChangeSelection(rows, staged, "up")).toBe(staged);
    expect(moveWorkspaceChangeSelection([], null, "down")).toBeNull();
  });
});
