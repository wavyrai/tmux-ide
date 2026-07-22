import { lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";

import {
  WORKSPACE_FILE_PREVIEW_MAX_CHARACTERS,
  WORKSPACE_FILE_PREVIEW_MAX_LINES,
  WORKSPACE_FILES_CATALOG_MAX_ENTRIES,
  WORKSPACE_FILES_MAX_BREADCRUMBS,
  WorkspaceFilePreviewResourceV1SchemaZ,
  WorkspaceFilePreviewUnavailableReasonSchemaZ,
  WorkspaceFilesCatalogResourceV1SchemaZ,
  WorkspaceFilesCatalogUnavailableReasonSchemaZ,
  WorkspaceResourceNameSchemaZ,
  type WorkspaceFileEntry,
  type WorkspaceFileEntryKind,
  type WorkspaceFilePreviewResourceV1,
  type WorkspaceFilesCatalogResourceV1,
} from "@tmux-ide/contracts";
import type { z } from "zod";
import ignore, { type Ignore } from "ignore";

import { WorkspaceFileIdTable, filesRevision } from "./workspace-resource-ids.ts";

type CatalogReason = z.infer<typeof WorkspaceFilesCatalogUnavailableReasonSchemaZ>;
type PreviewReason = z.infer<typeof WorkspaceFilePreviewUnavailableReasonSchemaZ>;

/** Directories never surfaced as navigable content, only ever flagged ignored. */
const ALWAYS_IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  "coverage",
  ".nyc_output",
  "target",
  "vendor",
  "bower_components",
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json", "json"],
  ["md", "markdown"],
  ["css", "css"],
  ["scss", "scss"],
  ["html", "html"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["toml", "toml"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["py", "python"],
  ["rs", "rust"],
  ["go", "go"],
  ["rb", "ruby"],
  ["java", "java"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["sql", "sql"],
]);

const MEDIA_TYPE_BY_EXTENSION = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["ico", "image/x-icon"],
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["gz", "application/gzip"],
  ["wasm", "application/wasm"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["mp4", "video/mp4"],
  ["mp3", "audio/mpeg"],
]);

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

function languageHintFor(name: string): string | null {
  const ext = extensionOf(name);
  return ext ? (LANGUAGE_BY_EXTENSION.get(ext) ?? null) : null;
}

function mediaTypeFor(name: string): string | null {
  const ext = extensionOf(name);
  return ext ? (MEDIA_TYPE_BY_EXTENSION.get(ext) ?? null) : null;
}

/** True when the buffer is not decodable UTF-8 text (NUL byte or invalid). */
export function looksBinary(buffer: Buffer): boolean {
  const scanLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < scanLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

/**
 * Bound decoded UTF-8 text to the contract's line cap, reporting the true line
 * count. The byte cap is enforced before decoding, so `content.length` (chars)
 * is already within the character cap.
 */
export function boundPreviewText(content: string): {
  content: string;
  totalLines: number;
  truncated: boolean;
} {
  const totalLines = content.length === 0 ? 0 : content.split("\n").length;
  if (totalLines <= WORKSPACE_FILE_PREVIEW_MAX_LINES) {
    return { content, totalLines, truncated: false };
  }
  const kept = content.split("\n").slice(0, WORKSPACE_FILE_PREVIEW_MAX_LINES).join("\n");
  return { content: kept, totalLines, truncated: true };
}

type DirentKind = { kind: WorkspaceFileEntryKind } | null;

function direntKind(dirent: Dirent): DirentKind {
  if (dirent.isSymbolicLink()) return { kind: "symlink" };
  if (dirent.isDirectory()) return { kind: "directory" };
  if (dirent.isFile()) return { kind: "file" };
  return null;
}

/**
 * Serves per-directory catalogs and bounded file previews for one workspace
 * root. Confinement is enforced by canonicalizing every resolved path with
 * `realpath` and rejecting anything that is not the root or a descendant of
 * it, which defeats symlink escapes. Ids are opaque and never decode to a
 * path on the wire; a renderer-supplied id that was never issued resolves to
 * a typed not-found state rather than a filesystem read.
 */
export class FilesAuthority {
  private readonly ids = new WorkspaceFileIdTable();

  constructor(
    private readonly root: string,
    private readonly workspaceName: string,
  ) {}

  catalog(directoryId?: string | null): WorkspaceFilesCatalogResourceV1 {
    let realRoot: string;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      return this.catalogUnavailable(
        "workspace-unavailable",
        "Workspace root is unavailable.",
        true,
      );
    }

    const rootId = this.ids.rootId();
    const targetId = directoryId && directoryId.length > 0 ? directoryId : rootId;

    let relPath: string;
    if (targetId === rootId) {
      relPath = "";
    } else {
      const resolved = this.ids.resolve(targetId);
      if (resolved === null) {
        return this.catalogUnavailable(
          "directory-not-found",
          "The requested directory is unknown.",
        );
      }
      relPath = resolved;
    }

    const absCandidate = relPath === "" ? realRoot : resolvePath(realRoot, relPath);
    let absReal: string;
    try {
      absReal = realpathSync(absCandidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return this.catalogUnavailable("permission-denied", "The directory cannot be read.");
      }
      return this.catalogUnavailable(
        "directory-not-found",
        "The requested directory is unavailable.",
      );
    }
    if (!isWithin(realRoot, absReal)) {
      return this.catalogUnavailable(
        "outside-workspace",
        "The directory is outside the workspace.",
      );
    }

    let dirents: Dirent[];
    try {
      const stat = lstatSync(absReal);
      if (!stat.isDirectory()) {
        return this.catalogUnavailable("directory-not-found", "The resource is not a directory.");
      }
      dirents = readdirSync(absReal, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return this.catalogUnavailable("permission-denied", "The directory cannot be read.");
      }
      return this.catalogUnavailable("io-error", "The directory could not be listed.");
    }

    const ig = buildIgnore(realRoot);
    const sorted = [...dirents].sort(compareDirents);
    const totalEntries = sorted.length;
    const entries: WorkspaceFileEntry[] = [];

    for (const dirent of sorted) {
      if (entries.length >= WORKSPACE_FILES_CATALOG_MAX_ENTRIES) break;
      const kindInfo = direntKind(dirent);
      if (kindInfo === null) continue;
      const name = dirent.name;
      if (!WorkspaceResourceNameSchemaZ.safeParse(name).success) continue;

      const childRel = relPath === "" ? name : `${relPath}/${name}`;
      const childAbs = resolvePath(absReal, name);
      const ignorePath = kindInfo.kind === "directory" ? `${childRel}/` : childRel;
      const ignored =
        ALWAYS_IGNORED_NAMES.has(name) || safeIgnores(ig, ignorePath) || safeIgnores(ig, childRel);

      const entry: WorkspaceFileEntry = {
        id: this.ids.intern(childRel),
        parentId: targetId,
        name,
        relativePath: childRel,
        kind: kindInfo.kind,
        hidden: name.startsWith("."),
        ignored,
        hasChildren: kindInfo.kind === "directory" && directoryHasChildren(childAbs),
        gitStatus: null,
      };
      if (WorkspaceFileEntrySafe(entry)) entries.push(entry);
    }

    const truncated = totalEntries > entries.length;
    const rootLabel = safeName(basename(realRoot), "workspace");
    const revision = filesRevision(
      JSON.stringify({ dir: relPath, entries: entries.map((e) => `${e.name}:${e.kind}`) }),
    );

    const breadcrumbs = this.buildBreadcrumbs(rootId, rootLabel, relPath);
    if (breadcrumbs === null) {
      return this.catalogUnavailable("io-error", "The directory path is too deep to browse.");
    }

    const directory =
      relPath === ""
        ? { id: rootId, name: rootLabel, relativePath: null, parentId: null }
        : {
            id: targetId,
            name: safeName(basename(relPath), rootLabel),
            relativePath: relPath,
            parentId: this.parentId(rootId, relPath),
          };

    const candidate = {
      status: "ready" as const,
      workspaceName: this.workspaceName,
      revision,
      rootId,
      directory,
      breadcrumbs,
      entries,
      totalEntries,
      truncated,
    };
    const parsed = WorkspaceFilesCatalogResourceV1SchemaZ.safeParse(candidate);
    if (!parsed.success) {
      return this.catalogUnavailable("io-error", "The directory listing could not be produced.");
    }
    return parsed.data;
  }

  /**
   * A cheap bounded count of the workspace root's direct entries, for the dock
   * badge only. One `readdir` — no id interning, ignore parsing, or per-child
   * `hasChildren` probes. Returns null when the root cannot be listed so the
   * caller can fall back to a zero count rather than a fabricated one.
   */
  rootEntryCount(): number | null {
    let realRoot: string;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      return null;
    }
    let dirents: Dirent[];
    try {
      if (!lstatSync(realRoot).isDirectory()) return null;
      dirents = readdirSync(realRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    let count = 0;
    for (const dirent of dirents) {
      if (direntKind(dirent) === null) continue;
      if (!WorkspaceResourceNameSchemaZ.safeParse(dirent.name).success) continue;
      count += 1;
      if (count >= WORKSPACE_FILES_CATALOG_MAX_ENTRIES) break;
    }
    return count;
  }

  preview(fileId: string): WorkspaceFilePreviewResourceV1 {
    let realRoot: string;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      return this.previewWorkspaceUnavailable(fileId);
    }

    const relPath = this.ids.resolve(fileId);
    if (relPath === null || relPath === "") {
      return this.previewUnavailable(fileId, "file-not-found", "The requested file is unknown.");
    }

    const abs = resolvePath(realRoot, relPath);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return this.previewUnavailable(fileId, "permission-denied", "The file cannot be read.");
      }
      return this.previewUnavailable(
        fileId,
        "file-not-found",
        "The requested file is unavailable.",
      );
    }

    if (stat.isSymbolicLink()) {
      return this.previewUnavailable(
        fileId,
        "symlink-unsupported",
        "Symlinks cannot be previewed.",
      );
    }

    let realParent: string;
    try {
      realParent = realpathSync(dirname(abs));
    } catch {
      return this.previewUnavailable(
        fileId,
        "file-not-found",
        "The requested file is unavailable.",
      );
    }
    if (!isWithin(realRoot, resolvePath(realParent, basename(abs)))) {
      return this.previewUnavailable(
        fileId,
        "outside-workspace",
        "The file is outside the workspace.",
      );
    }

    if (stat.isDirectory() || !stat.isFile()) {
      return this.previewUnavailable(fileId, "not-a-file", "The resource is not a regular file.");
    }

    const name = basename(relPath);
    const catalogRevision = filesRevision(`${relPath}:${stat.size}:${stat.mtimeMs}`);
    const totalBytes = stat.size;

    if (totalBytes > WORKSPACE_FILE_PREVIEW_MAX_CHARACTERS) {
      return this.previewParse(fileId, {
        status: "too-large",
        workspaceName: this.workspaceName,
        catalogRevision,
        fileId,
        name,
        relativePath: relPath,
        totalBytes,
        limitBytes: WORKSPACE_FILE_PREVIEW_MAX_CHARACTERS,
      });
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return this.previewUnavailable(fileId, "permission-denied", "The file cannot be read.");
      }
      return this.previewUnavailable(fileId, "io-error", "The file could not be read.");
    }

    if (looksBinary(buffer)) {
      return this.previewParse(fileId, {
        status: "binary",
        workspaceName: this.workspaceName,
        catalogRevision,
        fileId,
        name,
        relativePath: relPath,
        totalBytes,
        mediaType: mediaTypeFor(name),
      });
    }

    const decoded = buffer.toString("utf8");
    const bounded = boundPreviewText(decoded);
    return this.previewParse(fileId, {
      status: "ready",
      workspaceName: this.workspaceName,
      catalogRevision,
      fileId,
      name,
      relativePath: relPath,
      encoding: "utf-8",
      languageHint: languageHintFor(name),
      content: bounded.content,
      totalBytes,
      totalLines: bounded.totalLines,
      truncated: bounded.truncated,
    });
  }

  private buildBreadcrumbs(
    rootId: string,
    rootLabel: string,
    relPath: string,
  ): { id: string; label: string }[] | null {
    const crumbs: { id: string; label: string }[] = [{ id: rootId, label: rootLabel }];
    if (relPath === "") return crumbs;
    const segments = relPath.split("/");
    if (segments.length + 1 > WORKSPACE_FILES_MAX_BREADCRUMBS) return null;
    let cumulative = "";
    for (const segment of segments) {
      cumulative = cumulative === "" ? segment : `${cumulative}/${segment}`;
      crumbs.push({ id: this.ids.intern(cumulative), label: safeName(segment, rootLabel) });
    }
    return crumbs;
  }

  private parentId(rootId: string, relPath: string): string {
    const segments = relPath.split("/");
    segments.pop();
    const parentRel = segments.join("/");
    return parentRel === "" ? rootId : this.ids.intern(parentRel);
  }

  private catalogUnavailable(
    reason: CatalogReason,
    message: string,
    retryable = false,
  ): WorkspaceFilesCatalogResourceV1 {
    return WorkspaceFilesCatalogResourceV1SchemaZ.parse({
      status: "unavailable",
      workspaceName: this.workspaceName,
      reason,
      message,
      retryable,
    });
  }

  private previewUnavailable(
    fileId: string,
    reason: PreviewReason,
    message: string,
    retryable = false,
  ): WorkspaceFilePreviewResourceV1 {
    return WorkspaceFilePreviewResourceV1SchemaZ.parse({
      status: "unavailable",
      workspaceName: this.workspaceName,
      catalogRevision: filesRevision(`unavailable:${fileId}`),
      fileId,
      reason,
      message,
      retryable,
    });
  }

  private previewWorkspaceUnavailable(fileId: string): WorkspaceFilePreviewResourceV1 {
    return this.previewUnavailable(
      fileId,
      "workspace-unavailable",
      "Workspace root is unavailable.",
      true,
    );
  }

  private previewParse(fileId: string, candidate: unknown): WorkspaceFilePreviewResourceV1 {
    const parsed = WorkspaceFilePreviewResourceV1SchemaZ.safeParse(candidate);
    if (!parsed.success) {
      return this.previewUnavailable(fileId, "io-error", "The file preview could not be produced.");
    }
    return parsed.data;
  }
}

function WorkspaceFileEntrySafe(entry: WorkspaceFileEntry): boolean {
  // Validate a single entry so one malformed name can never abort a listing.
  // Imported lazily to keep this module's hot path free of a second parse of
  // the whole catalog: the catalog schema re-validates the assembled resource.
  return (
    WorkspaceResourceNameSchemaZ.safeParse(entry.name).success && entry.relativePath.length > 0
  );
}

function compareDirents(a: Dirent, b: Dirent): number {
  const aDir = a.isDirectory() && !a.isSymbolicLink();
  const bDir = b.isDirectory() && !b.isSymbolicLink();
  if (aDir !== bDir) return aDir ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function directoryHasChildren(absDir: string): boolean {
  try {
    return readdirSync(absDir).length > 0;
  } catch {
    return false;
  }
}

function buildIgnore(root: string): Ignore {
  const ig = ignore();
  try {
    ig.add(readFileSync(resolvePath(root, ".gitignore"), "utf8"));
  } catch {
    // No root .gitignore (or unreadable) — proceed with the always-ignored set.
  }
  return ig;
}

function safeIgnores(ig: Ignore, relativePath: string): boolean {
  if (relativePath === "" || relativePath === "/") return false;
  try {
    return ig.ignores(relativePath.replace(/\/+$/, "") || relativePath);
  } catch {
    return false;
  }
}

function safeName(value: string, fallback: string): string {
  return WorkspaceResourceNameSchemaZ.safeParse(value).success ? value : fallback;
}

/** True when `candidate` is `root` itself or a descendant of it. */
export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}
