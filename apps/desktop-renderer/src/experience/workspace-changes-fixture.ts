import {
  flattenWorkspaceChangesView,
  type WorkspaceChangeEntry,
  type WorkspaceChangesView,
  type WorkspaceDiffHunk,
} from "@tmux-ide/contracts";

import type { ChangesDiffModel, ChangesSurfaceModel } from "./workspace-changes-surface.tsx";

/**
 * Illustrative changes fixtures. Entries are folded through the real
 * `flattenWorkspaceChangesView` projection so the surface renders exactly what
 * the store produces at runtime.
 */

export const CHANGES_SELECTED_ID = "change.stagedindex000000";

const ENTRIES: readonly WorkspaceChangeEntry[] = [
  {
    id: CHANGES_SELECTED_ID,
    group: "staged",
    status: "modified",
    name: "index.ts",
    relativePath: "src/index.ts",
    originPath: null,
    binary: false,
    additions: 12,
    deletions: 3,
  },
  {
    id: "change.stagedrename00000",
    group: "staged",
    status: "renamed",
    name: "surface.tsx",
    relativePath: "src/surface.tsx",
    originPath: "src/panel.tsx",
    binary: false,
    additions: 4,
    deletions: 4,
  },
  {
    id: "change.unstagedapp000000",
    group: "unstaged",
    status: "modified",
    name: "app.tsx",
    relativePath: "src/app.tsx",
    originPath: null,
    binary: false,
    additions: 5,
    deletions: 5,
  },
  {
    id: "change.unstagedlock00000",
    group: "unstaged",
    status: "modified",
    name: "pnpm-lock.yaml",
    relativePath: "pnpm-lock.yaml",
    originPath: null,
    binary: true,
    additions: null,
    deletions: null,
  },
  {
    id: "change.untrackednotes000",
    group: "untracked",
    status: "untracked",
    name: "notes.md",
    relativePath: "docs/notes.md",
    originPath: null,
    binary: false,
    additions: 18,
    deletions: 0,
  },
];

export function createChangesView(
  selectedId: string | null = CHANGES_SELECTED_ID,
): WorkspaceChangesView {
  return flattenWorkspaceChangesView({ entries: ENTRIES, selectedId });
}

export function createChangesReadyModel(): ChangesSurfaceModel {
  return {
    kind: "ready",
    branch: "main",
    detached: false,
    view: createChangesView(),
    truncated: false,
    totalEntries: ENTRIES.length,
  };
}

export function createChangesEmptyModel(): ChangesSurfaceModel {
  return {
    kind: "ready",
    branch: "main",
    detached: false,
    view: flattenWorkspaceChangesView({ entries: [] }),
    truncated: false,
    totalEntries: 0,
  };
}

export function createChangesDetachedModel(): ChangesSurfaceModel {
  return {
    kind: "ready",
    branch: null,
    detached: true,
    view: createChangesView(),
    truncated: true,
    totalEntries: 2_100,
  };
}

export function createChangesNoGitModel(): ChangesSurfaceModel {
  return {
    kind: "unavailable",
    reason: "This workspace is not a git repository.",
    retryable: false,
  };
}

const HUNKS: readonly WorkspaceDiffHunk[] = [
  {
    header: "@@ -1,3 +1,4 @@ export function main()",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    lines: [
      { kind: "context", content: "const a = 1;", oldLine: 1, newLine: 1 },
      { kind: "delete", content: "const b = 2;", oldLine: 2, newLine: null },
      { kind: "insert", content: "const b = 3;", oldLine: null, newLine: 2 },
      { kind: "insert", content: "const c = 4;", oldLine: null, newLine: 3 },
      { kind: "context", content: "return a;", oldLine: 3, newLine: 4 },
    ],
  },
];

export function createDiffReadyModel(): ChangesDiffModel {
  return {
    kind: "ready",
    relativePath: "src/index.ts",
    originPath: null,
    hunks: HUNKS,
    totalHunks: 1,
    totalLines: 5,
    truncated: false,
  };
}

export function createDiffTruncatedModel(): ChangesDiffModel {
  return {
    kind: "ready",
    relativePath: "src/index.ts",
    originPath: null,
    hunks: HUNKS,
    totalHunks: 42,
    totalLines: 19_800,
    truncated: true,
  };
}

export function createDiffBinaryModel(): ChangesDiffModel {
  return {
    kind: "binary",
    relativePath: "pnpm-lock.yaml",
    oldBytes: 210_004,
    newBytes: 211_120,
  };
}

export function createDiffUnavailableModel(): ChangesDiffModel {
  return {
    kind: "unavailable",
    relativePath: "src/index.ts",
    reason: "The working tree changed while the diff was loading.",
    retryable: true,
  };
}
