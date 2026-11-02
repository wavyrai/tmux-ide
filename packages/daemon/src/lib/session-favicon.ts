import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import {
  TMUX_SERVER_SESSION_FAVICON_MAX_BYTES,
  type TmuxServerSessionFaviconMime,
} from "@tmux-ide/contracts";

/** Project-relative favicon locations, first match wins. */
export const SESSION_FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
  "public/favicon.svg",
  "public/favicon.png",
  "public/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "static/favicon.svg",
  "static/favicon.png",
  "static/favicon.ico",
  "assets/favicon.svg",
  "assets/favicon.png",
  "assets/favicon.ico",
  "apple-touch-icon.png",
  "public/apple-touch-icon.png",
  "icon.svg",
  "icon.png",
] as const;

const MIME_BY_EXTENSION: Readonly<Record<string, TmuxServerSessionFaviconMime>> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface SessionFavicon {
  readonly mime: TmuxServerSessionFaviconMime;
  /** Base64 of the raw file bytes. */
  readonly data: string;
  /** Raw byte count. */
  readonly size: number;
}

export interface SessionFaviconIo {
  lstat(path: string): Promise<Stats>;
  /** Reads a regular file without following a final symlink; null when refused or too large. */
  readNoFollow(path: string, maxBytes: number): Promise<Buffer | null>;
}

export const defaultSessionFaviconIo: SessionFaviconIo = {
  lstat: (path) => lstat(path),
  readNoFollow: async (path, maxBytes) => {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maxBytes) return null;
      const bytes = await handle.readFile();
      return bytes.byteLength > maxBytes ? null : bytes;
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
};

type CacheEntry =
  | {
      readonly kind: "hit";
      readonly file: string;
      readonly mtimeMs: number;
      readonly size: number;
      readonly favicon: SessionFavicon;
    }
  | { readonly kind: "miss"; readonly at: number };

export interface SessionFaviconResolverOptions {
  readonly io?: SessionFaviconIo;
  readonly now?: () => number;
  readonly missTtlMs?: number;
  readonly maxEntries?: number;
}

async function lstatOrNull(io: SessionFaviconIo, path: string): Promise<Stats | null> {
  try {
    return await io.lstat(path);
  } catch {
    return null;
  }
}

/**
 * Finds a session's project favicon from its working directory. Only regular
 * files and real directories inside the session path are considered; symlinks
 * are never followed. Hits are revalidated by mtime and size, misses are
 * remembered briefly, and the cache is bounded (least recently used first).
 */
export function createSessionFaviconResolver(options: SessionFaviconResolverOptions = {}) {
  const io = options.io ?? defaultSessionFaviconIo;
  const now = options.now ?? Date.now;
  const missTtlMs = options.missTtlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 256;
  const cache = new Map<string, CacheEntry>();

  const remember = (sessionPath: string, entry: CacheEntry) => {
    cache.delete(sessionPath);
    cache.set(sessionPath, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  };

  const scan = async (sessionPath: string): Promise<CacheEntry> => {
    const directories = new Map<string, boolean>();
    for (const candidate of SESSION_FAVICON_CANDIDATES) {
      const mime = MIME_BY_EXTENSION[extname(candidate)];
      if (!mime) continue;
      const slash = candidate.lastIndexOf("/");
      if (slash >= 0) {
        const parts = candidate.slice(0, slash).split("/");
        let real = true;
        for (let index = 1; index <= parts.length && real; index += 1) {
          const directory = parts.slice(0, index).join("/");
          let known = directories.get(directory);
          if (known === undefined) {
            const stats = await lstatOrNull(io, join(sessionPath, directory));
            known = stats !== null && stats.isDirectory() && !stats.isSymbolicLink();
            directories.set(directory, known);
          }
          real = known;
        }
        if (!real) continue;
      }
      const file = join(sessionPath, candidate);
      const stats = await lstatOrNull(io, file);
      if (!stats || !stats.isFile() || stats.size > TMUX_SERVER_SESSION_FAVICON_MAX_BYTES) continue;
      const bytes = await io.readNoFollow(file, TMUX_SERVER_SESSION_FAVICON_MAX_BYTES);
      if (!bytes) continue;
      return {
        kind: "hit",
        file,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        favicon: { mime, data: bytes.toString("base64"), size: bytes.byteLength },
      };
    }
    return { kind: "miss", at: now() };
  };

  return async (sessionPath: string): Promise<SessionFavicon | null> => {
    if (!sessionPath || !isAbsolute(sessionPath) || sessionPath.includes("\0")) return null;
    const cached = cache.get(sessionPath);
    if (cached?.kind === "miss" && now() - cached.at < missTtlMs) {
      remember(sessionPath, cached);
      return null;
    }
    if (cached?.kind === "hit") {
      const stats = await lstatOrNull(io, cached.file);
      if (
        stats &&
        stats.isFile() &&
        stats.mtimeMs === cached.mtimeMs &&
        stats.size === cached.size
      ) {
        remember(sessionPath, cached);
        return cached.favicon;
      }
    }
    const entry = await scan(sessionPath);
    remember(sessionPath, entry);
    return entry.kind === "hit" ? entry.favicon : null;
  };
}
