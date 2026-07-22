import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import {
  WorkspaceChangeResourceIdSchemaZ,
  WorkspaceChangesRevisionSchemaZ,
  WorkspaceRelativeDisplayPathSchemaZ,
  WorkspaceResourceNameSchemaZ,
  WorkspaceResourceWorkspaceNameSchemaZ,
} from "./workspace-resource-identity.ts";

export const WORKSPACE_CHANGES_CATALOG_RESOURCE_VERSION = 1 as const;
export const WORKSPACE_CHANGE_DIFF_RESOURCE_VERSION = 1 as const;
export const WORKSPACE_CHANGES_CATALOG_MAX_ENTRIES = 2_048;
export const WORKSPACE_CHANGE_MAX_LINE_DELTA = 10_000_000;
export const WORKSPACE_CHANGE_BRANCH_MAX_LENGTH = 255;
export const WORKSPACE_CHANGE_DIFF_MAX_HUNKS = 512;
export const WORKSPACE_CHANGE_DIFF_MAX_LINES = 20_000;
export const WORKSPACE_CHANGE_DIFF_MAX_LINE_LENGTH = 4_096;

/** Where a change lives relative to the git index. */
export const WorkspaceChangeGroupSchemaZ = z.enum(["staged", "unstaged", "untracked"]);

/** Porcelain-derived change kind. `untracked` is reserved for the untracked group. */
export const WorkspaceChangeStatusSchemaZ = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "conflicted",
  "untracked",
]);

const DiffCountSchemaZ = z.number().int().nonnegative().max(WORKSPACE_CHANGE_MAX_LINE_DELTA);

export const WorkspaceChangeEntrySchemaZ = z
  .strictObject({
    id: WorkspaceChangeResourceIdSchemaZ,
    group: WorkspaceChangeGroupSchemaZ,
    status: WorkspaceChangeStatusSchemaZ,
    name: WorkspaceResourceNameSchemaZ,
    relativePath: WorkspaceRelativeDisplayPathSchemaZ,
    /** Present only for renames and copies; the pre-change display path. */
    originPath: WorkspaceRelativeDisplayPathSchemaZ.nullable(),
    binary: z.boolean(),
    additions: DiffCountSchemaZ.nullable(),
    deletions: DiffCountSchemaZ.nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.relativePath.split("/").at(-1) !== entry.name) {
      ctx.addIssue({
        code: "custom",
        path: ["relativePath"],
        message: "entry display path must end with its resource name",
      });
    }
    const untrackedStatus = entry.status === "untracked";
    const untrackedGroup = entry.group === "untracked";
    if (untrackedGroup !== untrackedStatus) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "untracked status and untracked group must agree",
      });
    }
    const carriesOrigin = entry.status === "renamed" || entry.status === "copied";
    if (carriesOrigin && entry.originPath === null) {
      ctx.addIssue({
        code: "custom",
        path: ["originPath"],
        message: "renames and copies must carry an origin path",
      });
    }
    if (!carriesOrigin && entry.originPath !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["originPath"],
        message: "only renames and copies may carry an origin path",
      });
    }
    if (entry.originPath !== null && entry.originPath === entry.relativePath) {
      ctx.addIssue({
        code: "custom",
        path: ["originPath"],
        message: "origin path must differ from the current display path",
      });
    }
    if (entry.binary) {
      if (entry.additions !== null || entry.deletions !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["additions"],
          message: "binary changes cannot report line counts",
        });
      }
    } else if (entry.additions === null || entry.deletions === null) {
      ctx.addIssue({
        code: "custom",
        path: ["additions"],
        message: "text changes must report line counts",
      });
    }
  });

const WorkspaceChangesCatalogReadySchemaZ = z
  .strictObject({
    status: z.literal("ready"),
    workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
    revision: WorkspaceChangesRevisionSchemaZ,
    /** The current branch, or null when the workspace is detached or unborn. */
    branch: z.string().min(1).max(WORKSPACE_CHANGE_BRANCH_MAX_LENGTH).nullable(),
    detached: z.boolean(),
    entries: z.array(WorkspaceChangeEntrySchemaZ).max(WORKSPACE_CHANGES_CATALOG_MAX_ENTRIES),
    totalEntries: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .superRefine((resource, ctx) => {
    if (resource.detached && resource.branch !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["branch"],
        message: "a detached workspace cannot name a branch",
      });
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, entry] of resource.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "change ids must be unique",
        });
      }
      const pathKey = `${entry.group}\u0000${entry.relativePath}`;
      if (paths.has(pathKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "relativePath"],
          message: "a display path may appear once per change group",
        });
      }
      ids.add(entry.id);
      paths.add(pathKey);
    }
    if (resource.totalEntries < resource.entries.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalEntries"],
        message: "totalEntries cannot be smaller than the returned change count",
      });
    }
    if (resource.truncated !== resource.totalEntries > resource.entries.length) {
      ctx.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated must describe omitted changes",
      });
    }
  });

export const WorkspaceChangesCatalogUnavailableReasonSchemaZ = z.enum([
  "workspace-unavailable",
  "resource-changed",
  "not-a-git-repository",
  "permission-denied",
  "too-many-changes",
  "io-error",
]);

const WorkspaceChangesCatalogUnavailableSchemaZ = z.strictObject({
  status: z.literal("unavailable"),
  workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
  reason: WorkspaceChangesCatalogUnavailableReasonSchemaZ,
  message: z.string().min(1).max(240),
  retryable: z.boolean(),
});

export const WorkspaceChangesCatalogResourceV1SchemaZ = z.discriminatedUnion("status", [
  WorkspaceChangesCatalogReadySchemaZ,
  WorkspaceChangesCatalogUnavailableSchemaZ,
]);

export const WorkspaceChangesCatalogEnvelopeV1SchemaZ = z.strictObject({
  version: z.literal(WORKSPACE_CHANGES_CATALOG_RESOURCE_VERSION),
  daemon: DaemonInstanceIdentitySchemaZ,
  resource: WorkspaceChangesCatalogResourceV1SchemaZ,
});

export const WorkspaceDiffLineKindSchemaZ = z.enum(["context", "insert", "delete"]);

export const WorkspaceDiffLineSchemaZ = z
  .strictObject({
    kind: WorkspaceDiffLineKindSchemaZ,
    content: z.string().max(WORKSPACE_CHANGE_DIFF_MAX_LINE_LENGTH),
    oldLine: z.number().int().positive().nullable(),
    newLine: z.number().int().positive().nullable(),
  })
  .superRefine((line, ctx) => {
    if (/[\0\r\n]/u.test(line.content)) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "diff line content is a single line without control breaks",
      });
    }
    const expectsOld = line.kind !== "insert";
    const expectsNew = line.kind !== "delete";
    if (expectsOld !== (line.oldLine !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["oldLine"],
        message: "only context and delete lines carry an old line number",
      });
    }
    if (expectsNew !== (line.newLine !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["newLine"],
        message: "only context and insert lines carry a new line number",
      });
    }
  });

export const WorkspaceDiffHunkSchemaZ = z
  .strictObject({
    header: z.string().min(1).max(255),
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(WorkspaceDiffLineSchemaZ).min(1).max(WORKSPACE_CHANGE_DIFF_MAX_LINES),
  })
  .superRefine((hunk, ctx) => {
    if (hunk.oldLines > 0 && hunk.oldStart < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["oldStart"],
        message: "a non-empty old side starts at line 1",
      });
    }
    if (hunk.newLines > 0 && hunk.newStart < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["newStart"],
        message: "a non-empty new side starts at line 1",
      });
    }
    let oldCursor = hunk.oldLines > 0 ? hunk.oldStart : 0;
    let newCursor = hunk.newLines > 0 ? hunk.newStart : 0;
    let oldCount = 0;
    let newCount = 0;
    for (const [index, line] of hunk.lines.entries()) {
      if (line.kind !== "insert") {
        if (line.oldLine !== oldCursor) {
          ctx.addIssue({
            code: "custom",
            path: ["lines", index, "oldLine"],
            message: "old line numbers must run consecutively from the hunk start",
          });
        }
        oldCursor += 1;
        oldCount += 1;
      }
      if (line.kind !== "delete") {
        if (line.newLine !== newCursor) {
          ctx.addIssue({
            code: "custom",
            path: ["lines", index, "newLine"],
            message: "new line numbers must run consecutively from the hunk start",
          });
        }
        newCursor += 1;
        newCount += 1;
      }
    }
    if (oldCount !== hunk.oldLines) {
      ctx.addIssue({
        code: "custom",
        path: ["oldLines"],
        message: "oldLines must match the old-side line count",
      });
    }
    if (newCount !== hunk.newLines) {
      ctx.addIssue({
        code: "custom",
        path: ["newLines"],
        message: "newLines must match the new-side line count",
      });
    }
  });

const WorkspaceChangeDiffBase = {
  workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
  changesRevision: WorkspaceChangesRevisionSchemaZ,
  changeId: WorkspaceChangeResourceIdSchemaZ,
  group: WorkspaceChangeGroupSchemaZ,
  relativePath: WorkspaceRelativeDisplayPathSchemaZ,
  originPath: WorkspaceRelativeDisplayPathSchemaZ.nullable(),
} as const;

const WorkspaceChangeDiffReadySchemaZ = z
  .strictObject({
    status: z.literal("ready"),
    ...WorkspaceChangeDiffBase,
    hunks: z.array(WorkspaceDiffHunkSchemaZ).max(WORKSPACE_CHANGE_DIFF_MAX_HUNKS),
    totalHunks: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .superRefine((diff, ctx) => {
    if (diff.originPath !== null && diff.originPath === diff.relativePath) {
      ctx.addIssue({
        code: "custom",
        path: ["originPath"],
        message: "origin path must differ from the current display path",
      });
    }
    const renderedLines = diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
    if (diff.totalHunks < diff.hunks.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalHunks"],
        message: "totalHunks cannot be smaller than the returned hunk count",
      });
    }
    if (diff.totalLines < renderedLines) {
      ctx.addIssue({
        code: "custom",
        path: ["totalLines"],
        message: "totalLines cannot be smaller than the rendered line count",
      });
    }
    const omitted = diff.totalHunks > diff.hunks.length || diff.totalLines > renderedLines;
    if (diff.truncated !== omitted) {
      ctx.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated must describe omitted hunks or lines",
      });
    }
  });

const WorkspaceChangeDiffBinarySchemaZ = z.strictObject({
  status: z.literal("binary"),
  ...WorkspaceChangeDiffBase,
  oldBytes: z.number().int().nonnegative().nullable(),
  newBytes: z.number().int().nonnegative().nullable(),
});

const WorkspaceChangeDiffTooLargeSchemaZ = z.strictObject({
  status: z.literal("too-large"),
  ...WorkspaceChangeDiffBase,
  totalBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});

export const WorkspaceChangeDiffUnavailableReasonSchemaZ = z.enum([
  "workspace-unavailable",
  "resource-changed",
  "change-not-found",
  "not-a-git-repository",
  "permission-denied",
  "io-error",
]);

const WorkspaceChangeDiffUnavailableSchemaZ = z.strictObject({
  status: z.literal("unavailable"),
  workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
  changesRevision: WorkspaceChangesRevisionSchemaZ,
  changeId: WorkspaceChangeResourceIdSchemaZ,
  reason: WorkspaceChangeDiffUnavailableReasonSchemaZ,
  message: z.string().min(1).max(240),
  retryable: z.boolean(),
});

export const WorkspaceChangeDiffResourceV1SchemaZ = z.discriminatedUnion("status", [
  WorkspaceChangeDiffReadySchemaZ,
  WorkspaceChangeDiffBinarySchemaZ,
  WorkspaceChangeDiffTooLargeSchemaZ,
  WorkspaceChangeDiffUnavailableSchemaZ,
]);

export const WorkspaceChangeDiffEnvelopeV1SchemaZ = z.strictObject({
  version: z.literal(WORKSPACE_CHANGE_DIFF_RESOURCE_VERSION),
  daemon: DaemonInstanceIdentitySchemaZ,
  resource: WorkspaceChangeDiffResourceV1SchemaZ,
});

export type WorkspaceChangeGroup = z.infer<typeof WorkspaceChangeGroupSchemaZ>;
export type WorkspaceChangeStatus = z.infer<typeof WorkspaceChangeStatusSchemaZ>;
export type WorkspaceChangeEntry = z.infer<typeof WorkspaceChangeEntrySchemaZ>;
export type WorkspaceChangesCatalogResourceV1 = z.infer<
  typeof WorkspaceChangesCatalogResourceV1SchemaZ
>;
export type WorkspaceChangesCatalogEnvelopeV1 = z.infer<
  typeof WorkspaceChangesCatalogEnvelopeV1SchemaZ
>;
export type WorkspaceDiffLineKind = z.infer<typeof WorkspaceDiffLineKindSchemaZ>;
export type WorkspaceDiffLine = z.infer<typeof WorkspaceDiffLineSchemaZ>;
export type WorkspaceDiffHunk = z.infer<typeof WorkspaceDiffHunkSchemaZ>;
export type WorkspaceChangeDiffResourceV1 = z.infer<typeof WorkspaceChangeDiffResourceV1SchemaZ>;
export type WorkspaceChangeDiffEnvelopeV1 = z.infer<typeof WorkspaceChangeDiffEnvelopeV1SchemaZ>;
