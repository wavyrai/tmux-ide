/**
 * File access for paths a plugin's programs might have touched. Nothing
 * here follows a symlink at the final path component, and writes never go
 * through a name someone else could have created first.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export class UnsafeFileError extends Error {}

/**
 * Read `path` as UTF-8 if it is a regular file of at most `maxBytes`.
 * Returns null when it does not exist; throws when it is a symlink, not a
 * regular file, or too large.
 */
export function readRegularFile(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK")
      throw new UnsafeFileError(`${path} is a symlink; refusing to read it`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new UnsafeFileError(`${path} is not a regular file`);
    if (stat.size > maxBytes) throw new UnsafeFileError(`${path} is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) throw new UnsafeFileError(`${path} is larger than ${maxBytes} bytes`);
    }
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace `path` with `text`: written to a fresh, randomly named file that
 * must not exist yet (O_EXCL, O_NOFOLLOW), then renamed over `path`. A
 * symlink at `path` is replaced, never followed.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      const data = Buffer.from(text, "utf8");
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Make sure `path` is a real directory (not a symlink to one), creating it
 * if needed. Throws if something else is there.
 */
export function ensureRealDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new UnsafeFileError(`${path} is not a real directory`);
}
