import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
  WORKSPACE_FILES_CATALOG_RESOURCE_VERSION,
  WorkspaceFileEntrySchemaZ,
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogResourceV1SchemaZ,
} from "../workspace-files-resource.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T12:00:00.000Z",
};

const fileId = (token: string) => `file.${token.padEnd(16, "0")}`;
const filesRev = (token: string) => `files-rev.${token.padEnd(16, "0")}`;

const rootId = fileId("root");
const srcId = fileId("src");
const readmeId = fileId("readme");

const srcEntry = {
  id: srcId,
  parentId: rootId,
  name: "src",
  relativePath: "src",
  kind: "directory" as const,
  hidden: false,
  ignored: false,
  hasChildren: true,
  gitStatus: null,
};

const readmeEntry = {
  id: readmeId,
  parentId: rootId,
  name: "README.md",
  relativePath: "README.md",
  kind: "file" as const,
  hidden: false,
  ignored: false,
  hasChildren: false,
  gitStatus: "modified" as const,
};

const rootCatalog = {
  status: "ready" as const,
  workspaceName: "tmux-ide",
  revision: filesRev("gen1"),
  rootId,
  directory: { id: rootId, name: "tmux-ide", relativePath: null, parentId: null },
  breadcrumbs: [{ id: rootId, label: "tmux-ide" }],
  entries: [srcEntry, readmeEntry],
  totalEntries: 2,
  truncated: false,
};

describe("workspace files catalog resource", () => {
  it("accepts a well-formed root listing and its envelope", () => {
    expect(WorkspaceFilesCatalogResourceV1SchemaZ.safeParse(rootCatalog).success).toBe(true);
    expect(
      WorkspaceFilesCatalogEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_FILES_CATALOG_RESOURCE_VERSION,
        daemon,
        resource: rootCatalog,
      }).success,
    ).toBe(true);
  });

  it("accepts a nested directory listing with canonical child paths", () => {
    const nested = {
      ...rootCatalog,
      rootId,
      directory: { id: srcId, name: "src", relativePath: "src", parentId: rootId },
      breadcrumbs: [
        { id: rootId, label: "tmux-ide" },
        { id: srcId, label: "src" },
      ],
      entries: [
        {
          id: fileId("index"),
          parentId: srcId,
          name: "index.ts",
          relativePath: "src/index.ts",
          kind: "file" as const,
          hidden: false,
          ignored: false,
          hasChildren: false,
          gitStatus: null,
        },
      ],
      totalEntries: 1,
    };
    expect(WorkspaceFilesCatalogResourceV1SchemaZ.safeParse(nested).success).toBe(true);
  });

  it("rejects entries that lie about their path, parent, or children", () => {
    expect(
      WorkspaceFileEntrySchemaZ.safeParse({ ...readmeEntry, relativePath: "docs/OTHER.md" })
        .success,
    ).toBe(false);
    expect(WorkspaceFileEntrySchemaZ.safeParse({ ...readmeEntry, hasChildren: true }).success).toBe(
      false,
    );
    // A file cannot advertise children even when its path and name agree.
    expect(
      WorkspaceFileEntrySchemaZ.safeParse({ ...readmeEntry, kind: "file", hasChildren: true })
        .success,
    ).toBe(false);
    // Extra keys — including a reserved record key held as an own property — are
    // refused by the strict object. A computed key avoids the prototype-setter form.
    expect(
      WorkspaceFileEntrySchemaZ.safeParse({ ...readmeEntry, ["__proto__"]: "polluted" }).success,
    ).toBe(false);
  });

  it("enforces catalog-wide invariants", () => {
    // A child that is not parented by the listed directory.
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        ...rootCatalog,
        entries: [{ ...readmeEntry, parentId: fileId("other") }],
        totalEntries: 1,
      }).success,
    ).toBe(false);
    // Duplicate ids.
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        ...rootCatalog,
        entries: [srcEntry, { ...readmeEntry, id: srcId }],
      }).success,
    ).toBe(false);
    // truncated must describe the omission implied by totalEntries.
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        ...rootCatalog,
        totalEntries: 9,
        truncated: false,
      }).success,
    ).toBe(false);
    // The first breadcrumb must be the workspace root.
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        ...rootCatalog,
        breadcrumbs: [{ id: srcId, label: "src" }],
      }).success,
    ).toBe(false);
    // Only the root may omit relative path and parent identity.
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        ...rootCatalog,
        directory: { id: srcId, name: "src", relativePath: null, parentId: null },
      }).success,
    ).toBe(false);
  });

  it("rejects an unavailable catalog missing its reason", () => {
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        status: "unavailable",
        workspaceName: "tmux-ide",
        reason: "directory-not-found",
        message: "gone",
        retryable: true,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceFilesCatalogResourceV1SchemaZ.safeParse({
        status: "unavailable",
        workspaceName: "tmux-ide",
        reason: "not-a-real-reason",
        message: "gone",
        retryable: true,
      }).success,
    ).toBe(false);
  });
});

describe("workspace file preview resource", () => {
  const base = {
    workspaceName: "tmux-ide",
    catalogRevision: filesRev("gen1"),
    fileId: readmeId,
    name: "README.md",
    relativePath: "README.md",
  };

  it("accepts a complete text preview whose line count matches its content", () => {
    const preview = {
      status: "ready" as const,
      ...base,
      encoding: "utf-8" as const,
      languageHint: "markdown",
      content: "line one\nline two\nline three",
      totalBytes: 28,
      totalLines: 3,
      truncated: false,
    };
    expect(
      WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
        daemon,
        resource: preview,
      }).success,
    ).toBe(true);

    // A complete preview must report its rendered line count honestly.
    expect(
      WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
        daemon,
        resource: { ...preview, totalLines: 99 },
      }).success,
    ).toBe(false);
  });

  it("rejects NUL bytes inside a text preview", () => {
    const preview = {
      status: "ready" as const,
      ...base,
      encoding: "utf-8" as const,
      languageHint: null,
      content: `has${String.fromCharCode(0)}nul`,
      totalBytes: 7,
      totalLines: 1,
      truncated: false,
    };
    expect(
      WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
        daemon,
        resource: preview,
      }).success,
    ).toBe(false);
  });

  it("accepts binary and too-large previews", () => {
    expect(
      WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
        daemon,
        resource: { status: "binary", ...base, totalBytes: 4096, mediaType: "image/png" },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse({
        version: WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
        daemon,
        resource: {
          status: "too-large",
          ...base,
          totalBytes: 5_000_000,
          limitBytes: 524_288,
        },
      }).success,
    ).toBe(true);
  });
});
