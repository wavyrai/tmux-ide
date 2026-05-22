/**
 * Detects file-link hrefs in chat markdown and resolves them to a
 * canonical workspace-relative path. Adapted from t3code's
 * `apps/web/src/markdown-links.ts` but trimmed to the chat surface:
 *  - No Windows path handling (chat-solid runs in a browser pointed at
 *    a daemon that's almost always POSIX; we can re-add Windows shape
 *    when the electron app lands).
 *  - No external dependency on terminal-link parsing — the few helpers
 *    we need (path/line split, cwd-relative format) are inlined.
 *
 * Public API:
 *  - resolveMarkdownFileLinkTarget(href, cwd?) → canonical target string
 *    (e.g. "src/main.ts:42") or null if the href isn't a file link.
 *  - resolveMarkdownFileLinkMeta(href, cwd?)   → richer object with
 *    basename + displayPath + line/column for tooltip rendering.
 *  - rewriteMarkdownFileUriHref(href)          → strips the `file://`
 *    scheme so the marked renderer can inject the bare path into the
 *    `<a href>`.
 */

const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
// Relative path with at least one "/" and optional :line[:col] suffix.
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
// Bare filename like "main.ts" or "README.md:42".
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  basename: string;
  line?: number;
  column?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;
    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;
    return {
      path: options?.decodePath === false ? rawPath : safeDecode(rawPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

/**
 * Strips the `file://` scheme so `<a href>` is a bare path. Used by the
 * marked renderer override before sanitization — DOMPurify only allows
 * known schemes, so a bare path is safest.
 */
export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(href.trim(), { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function isLikelyPathCandidate(path: string): boolean {
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return RELATIVE_PATH_PREFIX_PATTERN.test(path) || !path.startsWith("/");
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  // Distinguish "https://..." from "main.ts:42" — the latter's rest is a
  // bare line/col, which isn't a URL scheme content.
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function joinPosix(left: string, right: string): string {
  const normalizedLeft = left.replace(/\/+$/, "");
  if (right.startsWith("./")) return joinPosix(normalizedLeft, right.slice(2));
  if (right.startsWith("../")) {
    const parent = normalizedLeft.slice(0, Math.max(0, normalizedLeft.lastIndexOf("/")));
    return joinPosix(parent, right.slice(3));
  }
  if (right.startsWith("~/")) return right; // `~` resolution is host-owned.
  return `${normalizedLeft}/${right}`;
}

function splitPathAndPosition(value: string): {
  path: string;
  line?: string;
  column?: string;
} {
  const match = value.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  if (!match?.[1]) return { path: value };
  const out: { path: string; line?: string; column?: string } = { path: match[1] };
  if (match[2]) out.line = match[2];
  if (match[3]) out.column = match[3];
  return out;
}

function basenameOfPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function formatWorkspaceRelativePath(target: string, cwd?: string): string {
  if (!cwd) return target;
  const normalizedCwd = cwd.replace(/\/+$/, "");
  if (target.startsWith(`${normalizedCwd}/`)) {
    const cwdName = normalizedCwd.slice(normalizedCwd.lastIndexOf("/") + 1);
    return `${cwdName}/${target.slice(normalizedCwd.length + 1)}`;
  }
  return target;
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = href.trim();
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim());
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (hasExternalScheme(decodedPath)) return null;

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }
  if (!cwd) {
    // No cwd: keep the relative path so the host can resolve it. The
    // dashboard's openFile helper already accepts both shapes.
    return pathWithPosition;
  }
  return joinPosix(cwd, pathWithPosition);
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;

  const { path, line, column } = splitPathAndPosition(targetPath);
  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;
  const lineNumber = Number.isFinite(parsedLine) ? parsedLine : undefined;
  const columnNumber = Number.isFinite(parsedColumn) ? parsedColumn : undefined;

  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    basename: basenameOfPath(path),
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
  };
}
