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
export function linuxDevelopmentProcessIdentity(
  pid: number,
  readStat = () => readFileSync(`/proc/${pid}/stat`, "utf8"),
  readExecutable = () => realpathSync(`/proc/${pid}/exe`),
): string | null {
  const parseStat = (stat: string) => {
    const end = stat.lastIndexOf(") ");
    const fields = stat.slice(end + 2).split(" ");
    if (
      !stat.startsWith(`${pid} (`) ||
      end < String(pid).length + 2 ||
      !/^[RSDZTtXxKWPI]$/.test(fields[0] ?? "") ||
      !/^\d+$/.test(fields[19] ?? "")
    )
      throw new Error("Invalid Linux process stat");
    return { state: fields[0]!, started: fields[19]! };
  };
  const dead = (state: string) => ["Z", "X", "x"].includes(state);
  const initial = parseStat(readStat());
  // A zombie has exited and cannot own resources, even before its parent reaps it.
  if (dead(initial.state)) return null;
  let executable: string;
  try {
    executable = readExecutable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Exit can occur between stat and exe. Only a confirmed dead state is safe;
      // unreadable, live or reused PIDs remain protected by the outer failure path.
      if (dead(parseStat(readStat()).state)) return null;
    }
    throw error;
  }
  const current = parseStat(readStat());
  if (dead(current.state)) return null;
  if (current.started !== initial.started) throw new Error("Linux process incarnation changed");
  return `linux:${initial.started}:${executable}`;
}
export async function developmentProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process identity");
  try {
    if (process.platform === "linux") {
      return linuxDevelopmentProcessIdentity(pid);
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
  options: { allowOrphan?: boolean; allowReset?: boolean } = {},
): Promise<DevelopmentIdentityRecord | null> {
  const record =
    readPrivateDevelopmentRecord<DevelopmentIdentityRecord>(join(instance.root, "instance.json")) ??
    (options.allowReset
      ? readPrivateDevelopmentRecord<DevelopmentIdentityRecord>(join(instance.root, "reset.json"))
      : null);
  if (!record) return null;
  const identity = options.allowOrphan ? null : await developmentWorktreeIdentity(instance);
  if (
    record.version !== 1 ||
    record.id !== instance.id ||
    record.digest !== instance.digest ||
    record.worktree !== instance.worktree ||
    record.name !== instance.name ||
    typeof record.capability !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(record.capability) ||
    !Number.isSafeInteger(record.tree?.dev) ||
    !Number.isSafeInteger(record.tree?.ino) ||
    !Number.isSafeInteger(record.git?.dev) ||
    !Number.isSafeInteger(record.git?.ino) ||
    typeof record.git?.path !== "string" ||
    (identity !== null &&
      (JSON.stringify(record.tree) !== JSON.stringify(identity.tree) ||
        JSON.stringify(record.git) !== JSON.stringify(identity.git)))
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
export function readDevelopmentOwner(
  instance: DevelopmentInstance,
  filename: "owner.json" | "startup-process.json" = "owner.json",
): DevelopmentOwnerRecord | null {
  const owner = readPrivateDevelopmentRecord<DevelopmentOwnerRecord>(join(instance.root, filename));
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

export type DevelopmentFailureReason =
  | "confirmation-required"
  | "app-live"
  | "app-unknown"
  | "app-pid-reused"
  | "owner-live"
  | "owner-unverified"
  | "lock-unavailable"
  | "unsupported-apply-build"
  | "identity-unavailable"
  | "startup-failed"
  | "activation-failed"
  | "previous-build-unavailable"
  | "tmux-restart-required"
  | "build-failed"
  | "operation-failed";
/** Only manager-authored error data may cross the public CLI boundary. */
export class DevelopmentOperationError extends Error {
  constructor(
    readonly reason: DevelopmentFailureReason,
    message: string,
    readonly receipt?: string,
  ) {
    super(message);
  }
}
export function developmentFailureResult(
  operation: string,
  error: unknown,
  instance?: DevelopmentInstance,
  fallback: DevelopmentFailureReason = "operation-failed",
) {
  const typed = error instanceof DevelopmentOperationError ? error : null;
  const receipt =
    instance &&
    ((operation === "up" && typed?.receipt === join(instance.root, "startup-receipt.json")) ||
      (operation === "restart" && typed?.receipt === join(instance.root, "activation.json")) ||
      (operation === "rebuild" && typed?.receipt === join(instance.root, "build-receipt.json")))
      ? typed!.receipt
      : undefined;
  return {
    ok: false as const,
    code: "DEVELOPMENT_INSTANCE_FAILED",
    operation,
    reason: typed?.reason ?? fallback,
    ...(instance ? { instanceId: instance.id } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

export interface DevelopmentBuildPin {
  generation: string;
  manifestHash: string;
}
export interface DevelopmentActivationReceipt {
  version: 1;
  operationId: string;
  phase: "prepared" | "stopping" | "starting" | "ready" | "failed";
  target: DevelopmentBuildPin;
  previous: DevelopmentBuildPin | null;
  previousRuntime: { pid: number; instanceId: string } | null;
  readyRuntime: { pid: number; instanceId: string } | null;
  tmux: { pid: number; generation: string } | null;
  failurePhase?: "stopping" | "starting" | "verification";
}
/** Only fixed fields leave the private transition record through status/support output. */
export function readDevelopmentActivation(
  instance: DevelopmentInstance,
): DevelopmentActivationReceipt | null {
  const value = readPrivateDevelopmentRecord<DevelopmentActivationReceipt>(
    join(instance.root, "activation.json"),
  );
  if (!value) return null;
  const pin = (x: DevelopmentBuildPin) => {
    if (!x || !/^build-[a-f0-9-]{36}$/.test(x.generation) || !/^[a-f0-9]{64}$/.test(x.manifestHash))
      throw new Error("Invalid activation build pin");
    return { generation: x.generation, manifestHash: x.manifestHash };
  };
  const runtime = (x: DevelopmentActivationReceipt["readyRuntime"]) => {
    if (x === null) return null;
    if (!x || !Number.isSafeInteger(x.pid) || x.pid <= 0 || !/^[a-f0-9-]{36}$/.test(x.instanceId))
      throw new Error("Invalid activation runtime");
    return { pid: x.pid, instanceId: x.instanceId };
  };
  if (
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.operationId) ||
    !["prepared", "stopping", "starting", "ready", "failed"].includes(value.phase) ||
    (value.failurePhase !== undefined &&
      !["stopping", "starting", "verification"].includes(value.failurePhase))
  )
    throw new Error("Invalid activation receipt");
  if (
    value.tmux !== null &&
    (!value.tmux ||
      !Number.isSafeInteger(value.tmux.pid) ||
      value.tmux.pid <= 0 ||
      !/^build-[a-f0-9-]{36}$/.test(value.tmux.generation))
  )
    throw new Error("Invalid activation tmux provenance");
  return {
    version: 1,
    operationId: value.operationId,
    phase: value.phase,
    target: pin(value.target),
    previous: value.previous === null ? null : pin(value.previous),
    previousRuntime: runtime(value.previousRuntime),
    readyRuntime: runtime(value.readyRuntime),
    tmux: value.tmux === null ? null : { pid: value.tmux.pid, generation: value.tmux.generation },
    ...(value.failurePhase ? { failurePhase: value.failurePhase } : {}),
  };
}
