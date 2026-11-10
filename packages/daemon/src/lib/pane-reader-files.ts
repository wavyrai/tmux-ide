import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PANE_READER_ASSET_MAX_BYTES,
  PANE_READER_MAX_BYTES,
  PANE_READER_PAGE_BYTES,
  hasControlCharacter,
  type PaneReaderPage,
} from "@tmux-ide/contracts";
import { isMarkdownPath } from "../terminal/protocol/reader-option.ts";

/**
 * File access for the native Markdown reader (card #756). Pure of tmux: the
 * caller has already proven which pane and which file. Nothing here touches
 * the network; a URL is always refused.
 */
export type ReaderPageResult =
  | { state: "unchanged"; revision: string }
  | { state: "ok"; revision: string; size: number; offset: number; chunk: string }
  | { state: "changed" }
  | { state: "too_large"; revision: string; size: number }
  | { state: "missing" };

export type ReaderAssetMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/svg+xml";
export type ReaderAssetResult =
  | {
      state: "ok";
      mime: ReaderAssetMime;
      revision: string;
      size: number;
      offset: number;
      chunk: string;
    }
  | { state: "changed" | "refused" | "missing" | "too_large" };

const IMAGE_MIME: Readonly<Record<string, ReaderAssetMime>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function revisionOf(stat: BigIntStats): string {
  return createHash("sha256")
    .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
    .digest("hex")
    .slice(0, 32);
}

function missingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EISDIR";
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if (missingError(error)) return null;
    throw error;
  }
}

/** Equal to or below `root`, compared by path segments rather than by string prefix. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** The nearest ancestor of `directory` holding a `.git` entry; no git process is run. */
export function gitRoot(directory: string): string | null {
  for (let current = directory; ; ) {
    try {
      lstatSync(join(current, ".git"));
      return current;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

type Opened = { fd: number; stat: BigIntStats };

/** Opens `real` (already resolved) without following a swapped-in final symlink. */
function openRegular(real: string): Opened | null {
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missingError(error)) return null;
    throw error;
  }
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile()) {
    closeSync(fd);
    return null;
  }
  return { fd, stat };
}

function readChunk(fd: number, offset: number, size: number): Buffer {
  const length = Math.max(0, Math.min(PANE_READER_PAGE_BYTES, size - offset));
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, offset + done);
    if (read === 0) break;
    done += read;
  }
  return buffer.subarray(0, done);
}

type Paged =
  | { state: "ok"; revision: string; size: number; offset: number; chunk: string }
  | { state: "changed" }
  | { state: "too_large"; revision: string; size: number }
  | { state: "unchanged"; revision: string };

/** One page of `opened`, re-checking after the read that the file did not change. */
function page(
  opened: Opened,
  limit: number,
  have: string | null,
  request: PaneReaderPage | null,
): Paged {
  const revision = revisionOf(opened.stat);
  const size = Number(opened.stat.size);
  if (size > limit) return { state: "too_large", revision, size };
  if (request) {
    if (request.revision !== revision || request.offset > size) return { state: "changed" };
  } else if (have === revision) return { state: "unchanged", revision };
  const offset = request?.offset ?? 0;
  const bytes = readChunk(opened.fd, offset, size);
  const after = fstatSync(opened.fd, { bigint: true });
  if (
    revisionOf(after) !== revision ||
    bytes.length !== Math.min(PANE_READER_PAGE_BYTES, size - offset)
  )
    return { state: "changed" };
  return { state: "ok", revision, size, offset, chunk: bytes.toString("base64") };
}

/** A page of the Markdown file at `path`; its real path must still be Markdown. */
export function readReaderPage(
  path: string,
  have: string | null,
  request: PaneReaderPage | null,
): ReaderPageResult {
  // A whole-file read retries once if the file changed underneath it.
  for (let attempt = 0; ; attempt++) {
    const real = realpathOrNull(path);
    if (!real || !isMarkdownPath(real)) return { state: "missing" };
    const opened = openRegular(real);
    if (!opened) return { state: "missing" };
    try {
      const result = page(opened, PANE_READER_MAX_BYTES, have, request);
      if (result.state !== "changed" || request || attempt > 0) return result;
    } finally {
      closeSync(opened.fd);
    }
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** The decoded relative path `src` names, or null when the reader must not follow it. */
export function localImageReference(src: string): string | null {
  if (src.includes("\0") || SCHEME.test(src) || src.startsWith("//") || src.startsWith("\\"))
    return null;
  const bare = src.split(/[?#]/u, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  if (
    !decoded ||
    hasControlCharacter(decoded) ||
    decoded.startsWith("/") ||
    decoded.startsWith("~") ||
    decoded.startsWith("\\") ||
    isAbsolute(decoded)
  )
    return null;
  return decoded;
}

function imageMime(path: string): ReaderAssetMime | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null;
}

/**
 * A page of the image `src` names, relative to the Markdown file at `markdown`.
 * Allowed only inside the file's git repository, or its folder when there is
 * none, after every symlink is resolved.
 */
export function readReaderAssetPage(
  markdown: string,
  src: string,
  request: PaneReaderPage | null,
): ReaderAssetResult {
  const reference = localImageReference(src);
  if (reference === null) return { state: "refused" };
  const document = realpathOrNull(markdown);
  if (!document || !isMarkdownPath(document)) return { state: "missing" };
  const base = dirname(document);
  const root = gitRoot(base) ?? base;
  const candidate = resolve(base, reference);
  // Refuse outside paths before touching the file system, so the answer never
  // says whether a file outside the root exists.
  if (!isInside(root, candidate) || !imageMime(candidate)) return { state: "refused" };
  const real = realpathOrNull(candidate);
  if (!real) return { state: "missing" };
  const mime = imageMime(real);
  if (!isInside(root, real) || !mime) return { state: "refused" };
  const opened = openRegular(real);
  if (!opened) return { state: "missing" };
  try {
    // A path swapped between realpath and open is refused rather than served.
    if (realpathOrNull(candidate) !== real) return { state: "refused" };
    const result = page(opened, PANE_READER_ASSET_MAX_BYTES, null, request);
    if (result.state === "unchanged") return { state: "changed" };
    if (result.state === "too_large") return { state: "too_large" };
    if (result.state === "changed") return result;
    return { ...result, mime };
  } finally {
    closeSync(opened.fd);
  }
}
