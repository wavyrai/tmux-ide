/** Private development ownership records; runtime UUIDs are deliberately not process identities. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DevelopmentInstance } from "./development-instance.ts";
const execute = promisify(execFile);
export function cleanManagerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !key.startsWith("TMUX_IDE_") &&
        !key.startsWith("GIT_") &&
        !["TMUX", "TMUX_PANE", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key),
    ),
  );
}
export function readPrivateDevelopmentRecord<T>(path: string): T | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1
    )
      throw new Error("Unsafe development ownership record");
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function writeDevelopmentRecord(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export async function developmentProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process identity");
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return `linux:${fields[19]}:${realpathSync(`/proc/${pid}/exe`)}`;
    }
    const { stdout } = await execute(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      {
        env: cleanManagerEnvironment(),
        encoding: "utf8",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
      },
    );
    return stdout.trim() || null;
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (liveness) {
      if ((liveness as NodeJS.ErrnoException).code === "ESRCH") return null;
    }
    throw new Error("Cannot establish process incarnation", { cause: error });
  }
}
export interface DevelopmentIdentityRecord {
  version: 1;
  id: string;
  digest: string;
  worktree: string;
  name: string;
  capability: string;
  tree: { dev: number; ino: number };
  git: { path: string; dev: number; ino: number };
}
export async function developmentWorktreeIdentity(instance: DevelopmentInstance) {
  const tree = lstatSync(instance.worktree);
  const { stdout } = await execute(
    "git",
    ["-C", instance.worktree, "rev-parse", "--absolute-git-dir"],
    {
      env: cleanManagerEnvironment(),
      encoding: "utf8",
      timeout: 2000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
    },
  );
  const path = realpathSync(stdout.trim());
  const git = lstatSync(path);
  return { tree: { dev: tree.dev, ino: tree.ino }, git: { path, dev: git.dev, ino: git.ino } };
}
export async function readDevelopmentIdentity(
  instance: DevelopmentInstance,
): Promise<DevelopmentIdentityRecord | null> {
  const record = readPrivateDevelopmentRecord<DevelopmentIdentityRecord>(
    join(instance.root, "instance.json"),
  );
  if (!record) return null;
  const identity = await developmentWorktreeIdentity(instance);
  if (
    record.version !== 1 ||
    record.id !== instance.id ||
    record.digest !== instance.digest ||
    record.worktree !== instance.worktree ||
    record.name !== instance.name ||
    typeof record.capability !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(record.capability) ||
    JSON.stringify(record.tree) !== JSON.stringify(identity.tree) ||
    JSON.stringify(record.git) !== JSON.stringify(identity.git)
  )
    throw new Error("Development worktree/ownership identity changed");
  return record;
}
export interface DevelopmentOwnerRecord {
  version: 1;
  attempt: string;
  pid: number;
  incarnation: string;
  generation: string;
  manifestHash: string;
}
export function readDevelopmentOwner(instance: DevelopmentInstance): DevelopmentOwnerRecord | null {
  const owner = readPrivateDevelopmentRecord<DevelopmentOwnerRecord>(
    join(instance.root, "owner.json"),
  );
  if (
    owner &&
    (owner.version !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.incarnation !== "string" ||
      !owner.incarnation ||
      !/^[a-f0-9-]{36}$/u.test(owner.attempt) ||
      !/^build-[a-f0-9-]{36}$/u.test(owner.generation) ||
      !/^[a-f0-9]{64}$/u.test(owner.manifestHash))
  )
    throw new Error("Invalid development process owner");
  return owner;
}
export function ownerBuildEnvironment(owner: DevelopmentOwnerRecord): NodeJS.ProcessEnv {
  return {
    TMUX_IDE_DEVELOPMENT_BUILD: owner.generation,
    TMUX_IDE_DEVELOPMENT_BUILD_HASH: owner.manifestHash,
  };
}
