import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  opendirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function trusted(path: string, directory: boolean) {
  const value = lstatSync(path);
  if (
    (directory ? !value.isDirectory() : !value.isFile()) ||
    value.uid !== process.getuid?.() ||
    (value.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (!directory && value.nlink !== 1)
  )
    throw new Error("unsafe TUI download lock");
  return value;
}
function readOwner(path: string): { pid: number; ino: number; dev: number } {
  const before = trusted(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (actual.ino !== before.ino || actual.dev !== before.dev || actual.size > 32) {
      throw new Error("unsafe TUI download lock");
    }
    const bytes = Buffer.alloc(33);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, length).toString("utf8");
    if (!/^[1-9][0-9]*\n$/.test(text)) throw new Error("invalid TUI download lock owner");
    const pid = Number(text.trim());
    if (!Number.isSafeInteger(pid) || pid > 2147483647)
      throw new Error("invalid TUI download lock owner");
    return { pid, ino: actual.ino, dev: actual.dev };
  } finally {
    closeSync(fd);
  }
}
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return code(error) === "ESRCH";
  }
}
function retire(directory: string, name: string, expected: { ino: number; dev: number }) {
  try {
    const current = trusted(directory, true);
    if (current.ino !== expected.ino || current.dev !== expected.dev) return;
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  // A successor has a different nonce. Never recursively delete the directory.
  try {
    unlinkSync(join(directory, name));
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(code(error)))) throw error;
  }
}

function cleanStaging(
  path: string,
  name: string,
  expected: { ino: number; dev: number },
  failed: boolean,
) {
  try {
    const current = trusted(path, true);
    if (current.ino !== expected.ino || current.dev !== expected.dev)
      throw new Error("TUI download staging lock changed");
    try {
      unlinkSync(join(path, name));
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    rmdirSync(path);
  } catch (error) {
    // Keep the primary acquisition failure and retain uncertain staging evidence.
    if (!failed) throw error;
  }
}

/** Publish a populated private directory atomically; age never proves owner death. */
export async function acquireTuiDownloadLock(lock: string, waitMs: number): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  const nonce = randomUUID();
  const name = `owner-${nonce}`;
  const staging = `${lock}.${nonce}.tmp`;
  mkdirSync(staging, { mode: 0o700 });
  const stagingWitness = trusted(staging, true);
  let published = false;
  let attempted = false;
  let failed = false;
  try {
    writeFileSync(join(staging, name), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    while (true) {
      if (attempted && Date.now() >= deadline)
        throw new Error("timed out waiting for another TUI download");
      attempted = true;
      try {
        const existing = lstatSync(lock);
        trusted(lock, existing.isDirectory());
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
      try {
        renameSync(staging, lock);
        published = true;
        let released = false;
        return () => {
          if (!released) {
            retire(lock, name, stagingWitness);
            released = true;
          }
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(String(code(error)))) throw error;
      }
      try {
        const entry = lstatSync(lock);
        if (entry.isDirectory()) {
          trusted(lock, true);
          const handle = opendirSync(lock);
          const names: string[] = [];
          try {
            for (let index = 0; index < 2; index++) {
              const entry = handle.readSync();
              if (!entry) break;
              names.push(entry.name);
            }
          } finally {
            handle.closeSync();
          }
          if (names.length !== 1 || !/^owner-[0-9a-f-]{36}$/.test(names[0]!)) {
            // Empty is only a retirement gap; the next atomic rename can claim it.
            if (names.length !== 0) throw new Error("invalid TUI download lock inventory");
          } else {
            const owner = readOwner(join(lock, names[0]!));
            if (dead(owner.pid)) {
              const current = readOwner(join(lock, names[0]!));
              if (
                current.ino !== owner.ino ||
                current.dev !== owner.dev ||
                current.pid !== owner.pid
              ) {
                throw new Error("TUI download lock changed");
              }
              retire(lock, names[0]!, entry);
            }
          }
        } else {
          // Compatibility with an interrupted older downloader. A new-format
          // successor is a directory, so this unlink cannot remove its lock.
          // Unmodified legacy downloaders do not implement this protocol: concurrent
          // legacy writers (including their TTL eviction) are not made race-safe.
          const owner = readOwner(lock);
          if (dead(owner.pid)) {
            const current = readOwner(lock);
            if (
              current.ino !== owner.ino ||
              current.dev !== owner.dev ||
              current.pid !== owner.pid
            ) {
              throw new Error("TUI download lock changed");
            }
            try {
              unlinkSync(lock);
            } catch (error) {
              if (!["ENOENT", "EISDIR", "EPERM"].includes(String(code(error)))) throw error;
            }
          }
        }
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for another TUI download");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
      );
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!published) cleanStaging(staging, name, stagingWitness, failed);
  }
}
