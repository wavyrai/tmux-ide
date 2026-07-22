import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import {
  WorkspaceFileResourceIdSchemaZ,
  WorkspaceFilesRevisionSchemaZ,
  WorkspaceRelativeDisplayPathSchemaZ,
  WorkspaceResourceNameSchemaZ,
  WorkspaceResourceWorkspaceNameSchemaZ,
} from "./workspace-resource-identity.ts";

export const WORKSPACE_FILES_CATALOG_RESOURCE_VERSION = 1 as const;
export const WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION = 1 as const;
export const WORKSPACE_FILES_CATALOG_MAX_ENTRIES = 1_024;
export const WORKSPACE_FILES_MAX_BREADCRUMBS = 64;
export const WORKSPACE_FILE_PREVIEW_MAX_CHARACTERS = 512 * 1_024;
export const WORKSPACE_FILE_PREVIEW_MAX_LINES = 10_000;

export const WorkspaceFileGitStatusSchemaZ = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
]);

export const WorkspaceFileEntryKindSchemaZ = z.enum(["directory", "file", "symlink"]);

export const WorkspaceFileEntrySchemaZ = z
  .strictObject({
    id: WorkspaceFileResourceIdSchemaZ,
    parentId: WorkspaceFileResourceIdSchemaZ,
    name: WorkspaceResourceNameSchemaZ,
    relativePath: WorkspaceRelativeDisplayPathSchemaZ,
    kind: WorkspaceFileEntryKindSchemaZ,
    hidden: z.boolean(),
    ignored: z.boolean(),
    hasChildren: z.boolean(),
    gitStatus: WorkspaceFileGitStatusSchemaZ.nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.relativePath.split("/").at(-1) !== entry.name) {
      ctx.addIssue({
        code: "custom",
        path: ["relativePath"],
        message: "entry display path must end with its resource name",
      });
    }
    if (entry.kind !== "directory" && entry.hasChildren) {
      ctx.addIssue({
        code: "custom",
        path: ["hasChildren"],
        message: "only directories can advertise children",
      });
    }
  });

export const WorkspaceFileBreadcrumbSchemaZ = z.strictObject({
  id: WorkspaceFileResourceIdSchemaZ,
  label: WorkspaceResourceNameSchemaZ,
});

const WorkspaceFilesCatalogReadySchemaZ = z
  .strictObject({
    status: z.literal("ready"),
    workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
    revision: WorkspaceFilesRevisionSchemaZ,
    rootId: WorkspaceFileResourceIdSchemaZ,
    directory: z.strictObject({
      id: WorkspaceFileResourceIdSchemaZ,
      name: WorkspaceResourceNameSchemaZ,
      relativePath: WorkspaceRelativeDisplayPathSchemaZ.nullable(),
      parentId: WorkspaceFileResourceIdSchemaZ.nullable(),
    }),
    breadcrumbs: z
      .array(WorkspaceFileBreadcrumbSchemaZ)
      .min(1)
      .max(WORKSPACE_FILES_MAX_BREADCRUMBS),
    entries: z.array(WorkspaceFileEntrySchemaZ).max(WORKSPACE_FILES_CATALOG_MAX_ENTRIES),
    totalEntries: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .superRefine((resource, ctx) => {
    const breadcrumbIds = resource.breadcrumbs.map(({ id }) => id);
    if (new Set(breadcrumbIds).size !== breadcrumbIds.length) {
      ctx.addIssue({ code: "custom", path: ["breadcrumbs"], message: "breadcrumb ids must be unique" });
    }
    if (resource.breadcrumbs[0]?.id !== resource.rootId) {
      ctx.addIssue({
        code: "custom",
        path: ["breadcrumbs", 0, "id"],
        message: "the first breadcrumb must identify the workspace root",
      });
    }
    if (resource.breadcrumbs.at(-1)?.id !== resource.directory.id) {
      ctx.addIssue({
        code: "custom",
        path: ["breadcrumbs"],
        message: "the final breadcrumb must identify the listed directory",
      });
    }
    if (
      (resource.directory.id === resource.rootId) !==
      (resource.directory.relativePath === null && resource.directory.parentId === null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["directory"],
        message: "only the workspace root may omit relative path and parent identity",
      });
    }
    const entryIds = new Set<string>();
    const entryPaths = new Set<string>();
    for (const [index, entry] of resource.entries.entries()) {
      if (entryIds.has(entry.id)) {
        ctx.addIssue({ code: "custom", path: ["entries", index, "id"], message: "entry ids must be unique" });
      }
      if (entryPaths.has(entry.relativePath)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "relativePath"],
          message: "entry display paths must be unique",
        });
      }
      entryIds.add(entry.id);
      entryPaths.add(entry.relativePath);
      if (entry.id === resource.directory.id || entry.parentId !== resource.directory.id) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "parentId"],
          message: "catalog entries must be direct children of the listed directory",
        });
      }
      const expectedPath = resource.directory.relativePath
        ? `${resource.directory.relativePath}/${entry.name}`
        : entry.name;
      if (entry.relativePath !== expectedPath) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "relativePath"],
          message: "catalog entries must use canonical direct-child display paths",
        });
      }
    }
    if (resource.totalEntries < resource.entries.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalEntries"],
        message: "totalEntries cannot be smaller than the returned entry count",
      });
    }
    if (resource.truncated !== (resource.totalEntries > resource.entries.length)) {
      ctx.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated must describe omitted catalog entries",
      });
    }
  });

export const WorkspaceFilesCatalogUnavailableReasonSchemaZ = z.enum([
  "workspace-unavailable",
  "resource-changed",
  "directory-not-found",
  "permission-denied",
  "outside-workspace",
  "too-many-entries",
  "io-error",
]);

const WorkspaceFilesCatalogUnavailableSchemaZ = z.strictObject({
  status: z.literal("unavailable"),
  workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
  reason: WorkspaceFilesCatalogUnavailableReasonSchemaZ,
  message: z.string().min(1).max(240),
  retryable: z.boolean(),
});

export const WorkspaceFilesCatalogResourceV1SchemaZ = z.discriminatedUnion("status", [
  WorkspaceFilesCatalogReadySchemaZ,
  WorkspaceFilesCatalogUnavailableSchemaZ,
]);

export const WorkspaceFilesCatalogEnvelopeV1SchemaZ = z.strictObject({
  version: z.literal(WORKSPACE_FILES_CATALOG_RESOURCE_VERSION),
  daemon: DaemonInstanceIdentitySchemaZ,
  resource: WorkspaceFilesCatalogResourceV1SchemaZ,
});

const WorkspaceFilePreviewBase = {
  workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
  catalogRevision: WorkspaceFilesRevisionSchemaZ,
  fileId: WorkspaceFileResourceIdSchemaZ,
  name: WorkspaceResourceNameSchemaZ,
  relativePath: WorkspaceRelativeDisplayPathSchemaZ,
} as const;

const WorkspaceFilePreviewReadySchemaZ = z
  .strictObject({
    status: z.literal("ready"),
    ...WorkspaceFilePreviewBase,
    encoding: z.literal("utf-8"),
    languageHint: z.string().min(1).max(64).nullable(),
    content: z.string().max(WORKSPACE_FILE_PREVIEW_MAX_CHARACTERS),
    totalBytes: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .superRefine((preview, ctx) => {
    if (preview.content.includes("\0")) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "text previews cannot contain NUL bytes" });
    }
    const renderedLines = preview.content.length === 0 ? 0 : preview.content.split("\n").length;
    if (renderedLines > WORKSPACE_FILE_PREVIEW_MAX_LINES) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "file preview line limit exceeded",
      });
    }
    if (!preview.truncated && renderedLines !== preview.totalLines) {
      ctx.addIssue({
        code: "custom",
        path: ["totalLines"],
        message: "complete text previews must report their rendered line count",
      });
    }
    if (preview.truncated && renderedLines > preview.totalLines) {
      ctx.addIssue({
        code: "custom",
        path: ["totalLines"],
        message: "truncated text previews cannot render more lines than the source",
      });
    }
  });

const WorkspaceFilePreviewBinarySchemaZ = z.strictObject({
  status: z.literal("binary"),
  ...WorkspaceFilePreviewBase,
  totalBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1).max(160).nullable(),
});

const WorkspaceFilePreviewTooLargeSchemaZ = z.strictObject({
  status: z.literal("too-large"),
  ...WorkspaceFilePreviewBase,
  totalBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});

export const WorkspaceFilePreviewUnavailableReasonSchemaZ = z.enum([
  "workspace-unavailable",
  "resource-changed",
  "file-not-found",
  "not-a-file",
  "symlink-unsupported",
  "permission-denied",
  "outside-workspace",
  "unsupported-encoding",
  "io-error",
]);

const WorkspaceFilePreviewUnavailableSchemaZ = z.strictObject({
  status: z.literal("unavailable"),
  workspaceName: WorkspaceResourceWorkspaceNameSchemaZ,
  catalogRevision: WorkspaceFilesRevisionSchemaZ,
  fileId: WorkspaceFileResourceIdSchemaZ,
  reason: WorkspaceFilePreviewUnavailableReasonSchemaZ,
  message: z.string().min(1).max(240),
  retryable: z.boolean(),
});

export const WorkspaceFilePreviewResourceV1SchemaZ = z.discriminatedUnion("status", [
  WorkspaceFilePreviewReadySchemaZ,
  WorkspaceFilePreviewBinarySchemaZ,
  WorkspaceFilePreviewTooLargeSchemaZ,
  WorkspaceFilePreviewUnavailableSchemaZ,
]);

export const WorkspaceFilePreviewEnvelopeV1SchemaZ = z.strictObject({
  version: z.literal(WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION),
  daemon: DaemonInstanceIdentitySchemaZ,
  resource: WorkspaceFilePreviewResourceV1SchemaZ,
});

export type WorkspaceFileGitStatus = z.infer<typeof WorkspaceFileGitStatusSchemaZ>;
export type WorkspaceFileEntryKind = z.infer<typeof WorkspaceFileEntryKindSchemaZ>;
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchemaZ>;
export type WorkspaceFileBreadcrumb = z.infer<typeof WorkspaceFileBreadcrumbSchemaZ>;
export type WorkspaceFilesCatalogResourceV1 = z.infer<
  typeof WorkspaceFilesCatalogResourceV1SchemaZ
>;
export type WorkspaceFilesCatalogEnvelopeV1 = z.infer<
  typeof WorkspaceFilesCatalogEnvelopeV1SchemaZ
>;
export type WorkspaceFilePreviewResourceV1 = z.infer<
  typeof WorkspaceFilePreviewResourceV1SchemaZ
>;
export type WorkspaceFilePreviewEnvelopeV1 = z.infer<
  typeof WorkspaceFilePreviewEnvelopeV1SchemaZ
>;
