import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceFileResourceIdSchemaZ,
  WorkspaceFilesCatalogResourceV1SchemaZ,
  WorkspaceFilePreviewResourceV1SchemaZ,
} from "@tmux-ide/contracts";

import {
  FilesAuthority,
  boundPreviewText,
  isWithin,
  looksBinary,
} from "./workspace-files-authority.ts";
import { WorkspaceFileIdTable, fileResourceId } from "./workspace-resource-ids.ts";

const scratch: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "files-authority-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("pure helpers", () => {
  it("detects binary content by NUL byte and invalid UTF-8", () => {
    expect(looksBinary(Buffer.from("plain text", "utf8"))).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(true);
  });

  it("bounds preview text to the line cap and reports the true total", () => {
    const small = boundPreviewText("a\nb\nc");
    expect(small).toEqual({ content: "a\nb\nc", totalLines: 3, truncated: false });
    const big = "line\n".repeat(10_001);
    const bounded = boundPreviewText(big);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totalLines).toBe(10_002);
    expect(bounded.content.split("\n")).toHaveLength(10_000);
  });

  it("confines only the root and its descendants", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(isWithin("/a/b", "/a")).toBe(false);
  });
});

describe("WorkspaceFileIdTable", () => {
  it("interns deterministically and resolves back to the path", () => {
    const table = new WorkspaceFileIdTable();
    const id = table.intern("src/a.ts");
    expect(id).toBe(fileResourceId("src/a.ts"));
    expect(table.intern("src/a.ts")).toBe(id);
    expect(table.resolve(id)).toBe("src/a.ts");
    expect(table.resolve("file.unknownunknownunknownun")).toBeNull();
    expect(table.resolve(table.rootId())).toBe("");
  });
});

describe("FilesAuthority.catalog", () => {
  it("lists the workspace root as a valid catalog", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "readme.md"), "# hi\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "ignored.txt"), "nope\n");

    const authority = new FilesAuthority(root, "alpha");
    const catalog = WorkspaceFilesCatalogResourceV1SchemaZ.parse(authority.catalog());
    expect(catalog.status).toBe("ready");
    if (catalog.status !== "ready") throw new Error("unreachable");

    expect(catalog.directory.relativePath).toBeNull();
    expect(catalog.breadcrumbs[0]!.id).toBe(catalog.rootId);
    const names = catalog.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("readme.md");
    const src = catalog.entries.find((e) => e.name === "src")!;
    expect(src.kind).toBe("directory");
    expect(src.hasChildren).toBe(true);
    const ignored = catalog.entries.find((e) => e.name === "ignored.txt")!;
    expect(ignored.ignored).toBe(true);
  });

  it("navigates into a subdirectory and issues resolvable child ids", () => {
    const root = makeRoot();
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "a.ts"), "1\n");

    const authority = new FilesAuthority(root, "alpha");
    const rootCatalog = authority.catalog();
    if (rootCatalog.status !== "ready") throw new Error("root not ready");
    const pkg = rootCatalog.entries.find((e) => e.name === "pkg")!;

    const sub = authority.catalog(pkg.id);
    if (sub.status !== "ready") throw new Error("sub not ready");
    expect(sub.directory.relativePath).toBe("pkg");
    expect(sub.breadcrumbs.map((b) => b.label)).toEqual([sub.breadcrumbs[0]!.label, "pkg"]);
    expect(sub.entries.map((e) => e.name)).toEqual(["a.ts"]);
    expect(sub.entries[0]!.relativePath).toBe("pkg/a.ts");
  });

  it("returns directory-not-found for an unknown id", () => {
    const root = makeRoot();
    const authority = new FilesAuthority(root, "alpha");
    const result = authority.catalog("file.aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toBe("directory-not-found");
  });

  it("rejects a symlinked directory that escapes the workspace root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, "secret.txt"), "top secret\n");
    symlinkSync(outside, join(root, "escape"));

    const authority = new FilesAuthority(root, "alpha");
    const rootCatalog = authority.catalog();
    if (rootCatalog.status !== "ready") throw new Error("root not ready");
    const escape = rootCatalog.entries.find((e) => e.name === "escape")!;
    expect(escape.kind).toBe("symlink");

    // The id was issued for the symlink; asking to list it must not escape.
    const result = authority.catalog(escape.id);
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toBe("outside-workspace");
  });
});

describe("FilesAuthority.preview", () => {
  it("returns bounded UTF-8 text for a small file", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
    const authority = new FilesAuthority(root, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("not ready");
    const file = catalog.entries.find((e) => e.name === "a.ts")!;

    const preview = WorkspaceFilePreviewResourceV1SchemaZ.parse(authority.preview(file.id));
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("unreachable");
    expect(preview.content).toBe("export const x = 1;\n");
    expect(preview.languageHint).toBe("typescript");
    expect(preview.totalLines).toBe(2);
  });

  it("classifies binary files", () => {
    const root = makeRoot();
    writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const authority = new FilesAuthority(root, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("not ready");
    const file = catalog.entries.find((e) => e.name === "logo.png")!;
    const preview = authority.preview(file.id);
    expect(preview.status).toBe("binary");
    if (preview.status !== "binary") throw new Error("unreachable");
    expect(preview.mediaType).toBe("image/png");
  });

  it("reports too-large files without reading them", () => {
    const root = makeRoot();
    const big = Buffer.alloc(600 * 1024, 0x61);
    writeFileSync(join(root, "big.txt"), big);
    const authority = new FilesAuthority(root, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("not ready");
    const file = catalog.entries.find((e) => e.name === "big.txt")!;
    const preview = authority.preview(file.id);
    expect(preview.status).toBe("too-large");
  });

  it("refuses to follow a symlinked file", () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    const authority = new FilesAuthority(root, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("not ready");
    const link = catalog.entries.find((e) => e.name === "link.txt")!;
    const preview = authority.preview(link.id);
    expect(preview.status).toBe("unavailable");
    if (preview.status !== "unavailable") throw new Error("unreachable");
    expect(preview.reason).toBe("symlink-unsupported");
  });

  it("rejects a fabricated file id", () => {
    const root = makeRoot();
    const authority = new FilesAuthority(root, "alpha");
    const fabricated = fileResourceId("../../etc/passwd");
    expect(WorkspaceFileResourceIdSchemaZ.safeParse(fabricated).success).toBe(true);
    const preview = authority.preview(fabricated);
    expect(preview.status).toBe("unavailable");
    if (preview.status !== "unavailable") throw new Error("unreachable");
    expect(preview.reason).toBe("file-not-found");
  });
});
