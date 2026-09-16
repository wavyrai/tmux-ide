/** Development identity and path policy. No processes are started or state created here. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface DevelopmentInstance {
  readonly id: string;
  readonly digest: string;
  readonly worktree: string;
  readonly name: string;
  readonly store: string;
  readonly root: string;
  readonly stateHome: string;
  readonly runtimeDir: string;
}

/** Read-only manager boundary; never called by ordinary namespace/state getters. */
export function discoverDevelopmentWorktree(cwd: string): string {
  return realpathSync(
    execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      timeout: 2000,
      maxBuffer: 64 * 1024,
    }).trim(),
  );
}

/** Validate existing path components, without creating or repairing anything. */
export function validateDevelopmentDirectory(path: string, privateRoot: string): void {
  const uid = process.getuid?.();
  if (uid === undefined || !["darwin", "linux"].includes(process.platform))
    throw new Error("Development instances require macOS or Linux");
  let cursor = resolve(path);
  while (true) {
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Unsafe development directory: ${cursor}`);
      const privatePart = cursor === privateRoot || cursor.startsWith(`${privateRoot}/`);
      if (privatePart && (info.uid !== uid || (info.mode & 0o077) !== 0))
        throw new Error(`Development directory must be owned and private: ${cursor}`);
      // System-owned sticky /tmp ancestors are deliberate; writable shared roots otherwise are not.
      if (info.mode & 0o022 && !(info.uid === 0 && info.mode & 0o1000))
        throw new Error(`Unsafe shared development ancestor: ${cursor}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

/** A canonical root is supplied by discovery; aliases canonicalize without invoking Git. */
export function resolveDevelopmentInstance(input: {
  worktree: string;
  name?: string;
  store?: string;
  userHome?: string;
}): DevelopmentInstance {
  const name = input.name ?? "";
  if (name && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/u.test(name))
    throw new Error("Invalid development instance name");
  if (!isAbsolute(input.worktree)) throw new Error("Development worktree must be absolute");
  const worktree = realpathSync(input.worktree);
  if (!lstatSync(worktree).isDirectory())
    throw new Error("Development worktree must be a directory");
  const userHome = input.userHome ?? homedir();
  const suppliedStore = resolve(input.store ?? join(userHome, ".local", "state", "tmux-ide-dev"));
  // Canonicalize existing parent aliases such as macOS /var -> /private/var,
  // but never accept a symlink as the application-owned store itself.
  let parent = suppliedStore;
  const suffix: string[] = [];
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    suffix.unshift(parent.slice(next.length + (next === "/" ? 0 : 1)));
    parent = next;
  }
  if (parent === suppliedStore && lstatSync(parent).isSymbolicLink())
    throw new Error("Development store cannot be a symlink");
  const store = join(realpathSync(parent), ...suffix);
  const canonicalHome = join(realpathSync(userHome), ".tmux-ide");
  const canonicalState = existsSync(canonicalHome) ? realpathSync(canonicalHome) : canonicalHome;
  if (
    suppliedStore === canonicalHome ||
    suppliedStore.startsWith(`${canonicalHome}/`) ||
    store === canonicalState ||
    store.startsWith(`${canonicalState}/`)
  )
    throw new Error("Development store cannot use canonical state");
  if (
    store === canonicalHome ||
    store.startsWith(`${canonicalHome}/`) ||
    /\/instances\/dev-[a-f0-9]{24}(?:\/|$)/u.test(store)
  )
    throw new Error("Development store cannot use canonical or sibling instance state");
  if (input.store && !isAbsolute(input.store))
    throw new Error("Development store must be absolute");
  const digest = createHash("sha256")
    .update(JSON.stringify(["tmux-ide-development-v1", worktree, name]))
    .digest("hex");
  const id = `dev-${digest.slice(0, 24)}`;
  const root = join(store, "instances", id);
  const runtimeRoot = join(realpathSync("/tmp"), `ti-dev-${process.getuid?.()}`);
  const runtimeDir = join(runtimeRoot, id);
  validateDevelopmentDirectory(root, store);
  validateDevelopmentDirectory(join(root, "state"), store);
  validateDevelopmentDirectory(runtimeDir, runtimeRoot);
  if (Buffer.byteLength(join(runtimeDir, "control.sock")) > 100)
    throw new Error("Development socket path exceeds portable limit");
  return Object.freeze({
    id,
    digest,
    worktree,
    name,
    store,
    root,
    stateHome: join(root, "state"),
    runtimeDir,
  });
}
