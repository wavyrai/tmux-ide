import {
  DevelopmentOperationError,
  developmentProcessIdentity,
  readPrivateDevelopmentRecord,
} from "./development-state.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, lstatSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateDevelopmentDirectory, type DevelopmentInstance } from "./development-instance.ts";
type LockOwner = { pid: number; incarnation: string; token: string; acquiredAt?: string };
function ownerAt(path: string): LockOwner | null {
  const owner = readPrivateDevelopmentRecord<LockOwner>(join(path, "owner.json"));
  if (
    owner &&
    (!Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.incarnation !== "string" ||
      !owner.incarnation ||
      !/^[a-f0-9-]{36}$/u.test(owner.token))
  )
    throw new Error("Invalid development lock owner");
  return owner;
}
function identity(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("Unsafe development lock directory");
  return `${stat.dev}:${stat.ino}`;
}
function publishDirectory(path: string, owner: LockOwner): boolean {
  const candidate = `${path}.${owner.token}.candidate`;
  mkdirSync(candidate, { mode: 0o700 });
  try {
    writeFileSync(join(candidate, "owner.json"), JSON.stringify(owner), {
      flag: "wx",
      mode: 0o600,
    });
    // Never replace an observed incomplete legacy directory, even when it is empty.
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      renameSync(candidate, path);
      return true;
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return false;
      throw error;
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}
/** Recover a crashed recovery owner. Capture first, validate the captured inode,
 * then delete; a racing replacement is restored and never recursively removed. */
async function recoverMarker(path: string): Promise<void> {
  let captured: string;
  try {
    captured = identity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prior = ownerAt(path);
  if (!prior || (await developmentProcessIdentity(prior.pid)) !== null) return;
  const retired = `${path}.${randomUUID()}.retired`;
  if (identity(path) !== captured || ownerAt(path)?.token !== prior.token) return;
  try {
    renameSync(path, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    identity(retired) !== captured ||
    ownerAt(retired)?.token !== prior.token ||
    (await developmentProcessIdentity(prior.pid)) !== null
  ) {
    try {
      renameSync(retired, path);
    } catch {
      /* Preserve captured evidence; never delete it. */
    }
    throw new Error("Recovery marker changed during retirement");
  }
  rmSync(retired, { recursive: true });
}
/** Only complete, proven-dead lock ownership is retired. No age or PID-reuse inference. */
export async function recoverDevelopmentLock(
  instance: DevelopmentInstance,
  kind: "build" | "lifecycle",
): Promise<boolean> {
  const parent = join(instance.root, "locks");
  validateDevelopmentDirectory(parent, instance.store);
  const path = join(parent, kind);
  let captured: string;
  try {
    captured = identity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const prior = ownerAt(path);
  if (!prior || (await developmentProcessIdentity(prior.pid)) !== null) return false;
  const token = randomUUID();
  const incarnation = await developmentProcessIdentity(process.pid);
  if (!incarnation) throw new Error("Cannot establish recovery owner");
  const marker = join(path, "recovery");
  await recoverMarker(marker);
  try {
    if (!publishDirectory(marker, { pid: process.pid, incarnation, token })) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const retired = join(parent, `${kind}.${token}.retired`);
  try {
    if (
      ownerAt(marker)?.token !== token ||
      identity(path) !== captured ||
      ownerAt(path)?.token !== prior.token ||
      (await developmentProcessIdentity(prior.pid)) !== null
    )
      return false;
    renameSync(path, retired);
    if (
      identity(retired) !== captured ||
      ownerAt(retired)?.token !== prior.token ||
      (await developmentProcessIdentity(prior.pid)) !== null
    ) {
      try {
        renameSync(retired, path);
      } catch {
        /* Preserve captured evidence, never delete a replacement. */
      }
      throw new Error("Development lock changed during retirement");
    }
    rmSync(retired, { recursive: true });
    return true;
  } finally {
    // The exclusive marker prevents concurrent retirees from touching this inode.
    try {
      if (identity(path) === captured && ownerAt(marker)?.token === token)
        rmSync(marker, { recursive: true });
    } catch {
      /* Never clean a replacement lock. */
    }
  }
}
export async function withDevelopmentLock<T>(
  instance: DevelopmentInstance,
  kind: "build" | "lifecycle",
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const parent = join(instance.root, "locks");
  validateDevelopmentDirectory(parent, instance.store);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const incarnation = await developmentProcessIdentity(process.pid);
  if (!incarnation) throw new Error("Cannot establish lock owner process");
  const path = join(parent, kind);
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  while (true) {
    signal?.throwIfAborted();
    if (
      publishDirectory(path, {
        pid: process.pid,
        incarnation,
        token,
        acquiredAt: new Date().toISOString(),
      })
    )
      break;
    try {
      if (await recoverDevelopmentLock(instance, kind)) continue;
    } catch {
      throw new DevelopmentOperationError(
        "lock-unavailable",
        `Development ${kind} lock ownership cannot be verified; inspect ${path}`,
      );
    }
    if (Date.now() >= deadline)
      throw new DevelopmentOperationError(
        "lock-unavailable",
        `Development ${kind} lock busy or unverified; inspect ${path}. Live, incomplete and unknown owners are protected.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    return await action();
  } finally {
    try {
      if (ownerAt(path)?.token === token) rmSync(path, { recursive: true });
    } catch {
      /* Never remove an unverified replacement lock. */
    }
  }
}
