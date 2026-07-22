import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CHANGE_DIFF_RESOURCE_VERSION,
  WORKSPACE_CHANGES_CATALOG_RESOURCE_VERSION,
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangeDiffResourceV1SchemaZ,
  WorkspaceChangeEntrySchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogResourceV1SchemaZ,
  WorkspaceDiffHunkSchemaZ,
} from "../workspace-changes-resource.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T12:00:00.000Z",
};

const changeId = (token: string) => `change.${token.padEnd(16, "0")}`;
const changesRev = (token: string) => `changes-rev.${token.padEnd(16, "0")}`;

const modifiedUnstaged = {
  id: changeId("mod"),
  group: "unstaged" as const,
  status: "modified" as const,
  name: "app.tsx",
  relativePath: "apps/desktop-renderer/app.tsx",
  originPath: null,
  binary: false,
  additions: 12,
  deletions: 3,
};

describe("workspace change entry", () => {
  it("accepts modified, untracked, renamed, and binary entries", () => {
    expect(WorkspaceChangeEntrySchemaZ.safeParse(modifiedUnstaged).success).toBe(true);
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({
        id: changeId("unt"),
        group: "untracked",
        status: "untracked",
        name: "scratch.md",
        relativePath: "scratch.md",
        originPath: null,
        binary: false,
        additions: 5,
        deletions: 0,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({
        id: changeId("ren"),
        group: "staged",
        status: "renamed",
        name: "renamed.ts",
        relativePath: "src/renamed.ts",
        originPath: "src/original.ts",
        binary: false,
        additions: 0,
        deletions: 0,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({
        id: changeId("bin"),
        group: "staged",
        status: "modified",
        name: "logo.png",
        relativePath: "assets/logo.png",
        originPath: null,
        binary: true,
        additions: null,
        deletions: null,
      }).success,
    ).toBe(true);
  });

  it("rejects inconsistent group, status, origin, and count combinations", () => {
    // untracked status must ride in the untracked group.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({ ...modifiedUnstaged, status: "untracked" }).success,
    ).toBe(false);
    // renames must carry an origin path.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({ ...modifiedUnstaged, status: "renamed" }).success,
    ).toBe(false);
    // a non-rename must not carry one.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({ ...modifiedUnstaged, originPath: "src/other.ts" })
        .success,
    ).toBe(false);
    // origin path cannot equal the current path.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({
        ...modifiedUnstaged,
        status: "renamed",
        group: "staged",
        originPath: modifiedUnstaged.relativePath,
      }).success,
    ).toBe(false);
    // binary entries cannot report line counts.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({ ...modifiedUnstaged, binary: true }).success,
    ).toBe(false);
    // text entries must report line counts.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({ ...modifiedUnstaged, additions: null }).success,
    ).toBe(false);
    // the name must be the basename of the display path.
    expect(
      WorkspaceChangeEntrySchemaZ.safeParse({ ...modifiedUnstaged, name: "wrong.tsx" }).success,
    ).toBe(false);
  });
});

describe("workspace changes catalog resource", () => {
  const stagedTwin = {
    ...modifiedUnstaged,
    id: changeId("staged"),
    group: "staged" as const,
  };

  const catalog = {
    status: "ready" as const,
    workspaceName: "tmux-ide",
    revision: changesRev("gen1"),
    branch: "main",
    detached: false,
    entries: [modifiedUnstaged, stagedTwin],
    totalEntries: 2,
    truncated: false,
  };

  it("accepts a catalog where one path appears in two different groups", () => {
    expect(WorkspaceChangesCatalogResourceV1SchemaZ.safeParse(catalog).success).toBe(true);
    expect(
      WorkspaceChangesCatalogEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_CHANGES_CATALOG_RESOURCE_VERSION,
        daemon,
        resource: catalog,
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate ids and duplicate paths within one group", () => {
    expect(
      WorkspaceChangesCatalogResourceV1SchemaZ.safeParse({
        ...catalog,
        entries: [modifiedUnstaged, { ...stagedTwin, id: modifiedUnstaged.id }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceChangesCatalogResourceV1SchemaZ.safeParse({
        ...catalog,
        entries: [modifiedUnstaged, { ...modifiedUnstaged, id: changeId("dup") }],
      }).success,
    ).toBe(false);
  });

  it("rejects a detached workspace that also names a branch", () => {
    expect(
      WorkspaceChangesCatalogResourceV1SchemaZ.safeParse({ ...catalog, detached: true }).success,
    ).toBe(false);
    expect(
      WorkspaceChangesCatalogResourceV1SchemaZ.safeParse({
        ...catalog,
        branch: null,
        detached: true,
      }).success,
    ).toBe(true);
  });

  it("rejects a truncation flag inconsistent with totalEntries", () => {
    expect(
      WorkspaceChangesCatalogResourceV1SchemaZ.safeParse({
        ...catalog,
        totalEntries: 40,
        truncated: false,
      }).success,
    ).toBe(false);
  });
});

describe("workspace change diff resource", () => {
  const editHunk = {
    header: "@@ -1,3 +1,4 @@",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    lines: [
      { kind: "context" as const, content: "unchanged", oldLine: 1, newLine: 1 },
      { kind: "delete" as const, content: "removed", oldLine: 2, newLine: null },
      { kind: "insert" as const, content: "added one", oldLine: null, newLine: 2 },
      { kind: "insert" as const, content: "added two", oldLine: null, newLine: 3 },
      { kind: "context" as const, content: "tail", oldLine: 3, newLine: 4 },
    ],
  };

  const additionHunk = {
    header: "@@ -0,0 +1,2 @@",
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    lines: [
      { kind: "insert" as const, content: "first", oldLine: null, newLine: 1 },
      { kind: "insert" as const, content: "second", oldLine: null, newLine: 2 },
    ],
  };

  it("accepts hunks with consistent line numbering", () => {
    expect(WorkspaceDiffHunkSchemaZ.safeParse(editHunk).success).toBe(true);
    expect(WorkspaceDiffHunkSchemaZ.safeParse(additionHunk).success).toBe(true);
  });

  it("rejects hunks whose line numbers or counts do not line up", () => {
    expect(
      WorkspaceDiffHunkSchemaZ.safeParse({
        ...editHunk,
        lines: [{ ...editHunk.lines[0], oldLine: 5 }, ...editHunk.lines.slice(1)],
      }).success,
    ).toBe(false);
    // oldLines claims one more old-side line than the hunk actually carries.
    expect(WorkspaceDiffHunkSchemaZ.safeParse({ ...editHunk, oldLines: 4 }).success).toBe(false);
    // an insert line cannot carry an old line number.
    expect(
      WorkspaceDiffHunkSchemaZ.safeParse({
        ...additionHunk,
        lines: [{ kind: "insert", content: "x", oldLine: 1, newLine: 1 }],
        newLines: 1,
      }).success,
    ).toBe(false);
    // content is a single line without control breaks.
    expect(
      WorkspaceDiffHunkSchemaZ.safeParse({
        ...additionHunk,
        lines: [{ kind: "insert", content: "a\nb", oldLine: null, newLine: 1 }],
        newLines: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts a ready diff envelope and enforces truncation accounting", () => {
    const ready = {
      status: "ready" as const,
      workspaceName: "tmux-ide",
      changesRevision: changesRev("gen1"),
      changeId: changeId("mod"),
      group: "unstaged" as const,
      relativePath: "apps/desktop-renderer/app.tsx",
      originPath: null,
      hunks: [editHunk],
      totalHunks: 1,
      totalLines: 5,
      truncated: false,
    };
    expect(
      WorkspaceChangeDiffEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_CHANGE_DIFF_RESOURCE_VERSION,
        daemon,
        resource: ready,
      }).success,
    ).toBe(true);
    // More hunks omitted than reported, yet truncated stays false.
    expect(
      WorkspaceChangeDiffResourceV1SchemaZ.safeParse({ ...ready, totalHunks: 6 }).success,
    ).toBe(false);
    // truncated true is required when lines are omitted.
    expect(
      WorkspaceChangeDiffResourceV1SchemaZ.safeParse({
        ...ready,
        totalLines: 40,
        truncated: true,
      }).success,
    ).toBe(true);
  });

  it("accepts binary, too-large, and unavailable diff variants", () => {
    const base = {
      workspaceName: "tmux-ide",
      changesRevision: changesRev("gen1"),
      changeId: changeId("bin"),
      group: "staged" as const,
      relativePath: "assets/logo.png",
      originPath: null,
    };
    expect(
      WorkspaceChangeDiffResourceV1SchemaZ.safeParse({
        status: "binary",
        ...base,
        oldBytes: 100,
        newBytes: 220,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceChangeDiffResourceV1SchemaZ.safeParse({
        status: "too-large",
        ...base,
        totalBytes: 9_000_000,
        limitBytes: 1_048_576,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceChangeDiffResourceV1SchemaZ.safeParse({
        status: "unavailable",
        workspaceName: "tmux-ide",
        changesRevision: changesRev("gen1"),
        changeId: changeId("bin"),
        reason: "change-not-found",
        message: "stale",
        retryable: false,
      }).success,
    ).toBe(true);
  });
});
