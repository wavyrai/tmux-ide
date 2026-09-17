import { requireDevelopmentNotSuspended } from "./development-suspension.ts";
import { verifyDevelopmentRuntimeOwner } from "./development-runtime-owner.ts";
/** Manager-owned app admission. A pre-spawn receipt closes reset's child-registration gap. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, opendirSync, rmSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { type DevelopmentInstance, validateDevelopmentDirectory } from "./development-instance.ts";
import { withDevelopmentLock } from "./development-lock.ts";
import { developmentAppLaunch, statusDevelopmentInstance } from "./development-lifecycle.ts";
import {
  DevelopmentOperationError,
  readDevelopmentIdentity,
  developmentProcessIdentity,
  readPrivateDevelopmentRecord,
  readPrivateDevelopmentFile,
  writeDevelopmentRecord,
} from "./development-state.ts";
export interface DevelopmentAppRemote {
  alias: string;
  controlRoot: string;
  configHash: string;
  directory: string;
}
const remoteHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function remoteWrapper(config: string) {
  return `#!/bin/sh\nexec /usr/bin/ssh -F '${config.replaceAll("'", "'\"'\"'")}' "$@"\n`;
}
function remotePaths(remote: Omit<DevelopmentAppRemote, "directory">) {
  if (
    !isAbsolute(remote.controlRoot) ||
    resolve(remote.controlRoot) !== remote.controlRoot ||
    !/^ti-dev-[a-f0-9]{24}$/u.test(remote.alias) ||
    !/^[a-f0-9]{64}$/u.test(remote.configHash) ||
    [...remote.controlRoot].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    /[:%"\\]/u.test(remote.controlRoot)
  )
    throw new Error("Private SSH path or alias is not representable");
  if (realpathSync(remote.controlRoot) !== remote.controlRoot)
    throw new Error("Private SSH directory is not canonical");
  validateDevelopmentDirectory(remote.controlRoot, remote.controlRoot);
  const directory = join(remote.controlRoot, "native-ssh"),
    config = join(remote.controlRoot, "ssh_config");
  return { directory, config, path: join(directory, "ssh") };
}
function remoteInventory(directory: string, required: boolean) {
  const reader = opendirSync(directory);
  try {
    const first = reader.readSync();
    if ((required && !first) || (first && first.name !== "ssh") || reader.readSync())
      throw new Error("Private SSH wrapper directory has unexpected entries");
  } finally {
    reader.closeSync();
  }
}
/** Called only inside verified project admission; creates no host owner or app. */
export function prepareDevelopmentAppRemote(
  remote: Omit<DevelopmentAppRemote, "directory">,
): DevelopmentAppRemote {
  const { directory, config, path } = remotePaths(remote);
  validateDevelopmentDirectory(directory, remote.controlRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  remoteInventory(directory, false);
  const expected = remoteWrapper(config);
  const existing = readPrivateDevelopmentFile(path);
  if (existing) {
    if (existing.bytes.toString("utf8") !== expected)
      throw new Error("Private SSH wrapper changed");
  } else writeFileSync(path, expected, { flag: "wx", mode: 0o700 });
  const result = { ...remote, directory };
  validateDevelopmentAppRemote(result);
  return result;
}
export function validateDevelopmentAppRemote(remote: DevelopmentAppRemote) {
  const { directory, config, path } = remotePaths(remote);
  if (remote.directory !== directory) throw new Error("Private SSH wrapper directory changed");
  validateDevelopmentDirectory(directory, remote.controlRoot);
  remoteInventory(directory, true);
  const wrapper = readPrivateDevelopmentFile(path),
    configuration = readPrivateDevelopmentFile(config);
  const system = lstatSync("/usr/bin/ssh");
  if (
    !system.isFile() ||
    system.uid !== 0 ||
    system.mode & 0o022 ||
    !wrapper ||
    wrapper.bytes.toString("utf8") !== remoteWrapper(config) ||
    !(lstatSync(path).mode & 0o100) ||
    !configuration ||
    remoteHash(configuration.bytes) !== remote.configHash
  )
    throw new Error("Private SSH admission changed");
}
export function developmentRemoteAppLaunch<T extends { args: string[]; env: NodeJS.ProcessEnv }>(
  launch: T,
  remote?: DevelopmentAppRemote,
): T {
  if (!remote) return launch;
  validateDevelopmentAppRemote(remote);
  return {
    ...launch,
    args: [...launch.args, `--ssh=${remote.alias}`],
    env: { ...launch.env, PATH: `${remote.directory}:${launch.env.PATH ?? ""}` },
  };
}
/** Capture at spawn, before asynchronous receipt work, so fast exits cannot be missed. */
export function waitDevelopmentAppExit(
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "once">,
): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1);
      return;
    }
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
}
type AppReceipt = {
  version: 1;
  attempt: string;
  managerPid: number;
  managerIncarnation: string;
  pid: number | null;
  incarnation: string | null;
  generation: string;
};
function readApp(path: string): AppReceipt | null {
  const value = readPrivateDevelopmentRecord<AppReceipt>(path);
  if (
    value &&
    (value.version !== 1 ||
      !/^[a-f0-9-]{36}$/u.test(value.attempt) ||
      !Number.isSafeInteger(value.managerPid) ||
      value.managerPid <= 0 ||
      typeof value.managerIncarnation !== "string" ||
      !value.managerIncarnation ||
      !/^build-[a-f0-9-]{36}$/u.test(value.generation) ||
      (value.pid !== null &&
        (!Number.isSafeInteger(value.pid) ||
          value.pid <= 0 ||
          typeof value.incarnation !== "string" ||
          !value.incarnation)))
  )
    throw new DevelopmentOperationError("app-unknown", "Unverified app process receipt");
  return value;
}
/** Caller holds lifecycle lock. Unknown interrupted admissions are deliberately protected. */
export async function requireStoppedDevelopmentApps(instance: DevelopmentInstance) {
  const directory = join(instance.root, "apps");
  validateDevelopmentDirectory(directory, instance.store);
  let reader;
  try {
    reader = opendirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    for (let count = 0; ; count++) {
      const entry = reader.readSync();
      if (!entry) break;
      if (count >= 256 || !/^[a-f0-9-]{36}\.json$/u.test(entry.name))
        throw new DevelopmentOperationError("app-unknown", "Unverified app receipt inventory");
      const path = join(directory, entry.name);
      const app = readApp(path);
      if (!app || `${app.attempt}.json` !== entry.name || app.pid === null)
        throw new DevelopmentOperationError(
          "app-unknown",
          "Interrupted app admission is protected; app ownership is unknown",
        );
      const current = await developmentProcessIdentity(app.pid);
      if (current !== null)
        throw new DevelopmentOperationError(
          current === app.incarnation ? "app-live" : "app-pid-reused",
          current === app.incarnation
            ? "Close the managed app before reset"
            : "App PID was reused; replacement is protected",
        );
      rmSync(path);
    }
  } finally {
    reader.closeSync();
  }
}
export async function launchDevelopmentApp(
  instance: DevelopmentInstance,
  remote?: DevelopmentAppRemote,
) {
  const launch = await developmentAppLaunch(instance);
  return withDevelopmentLock(instance, "lifecycle", async () => {
    requireDevelopmentNotSuspended(instance);
    const current = await statusDevelopmentInstance(instance);
    if (
      current.state !== "ready" ||
      current.activeBuild?.generation !== launch.env.TMUX_IDE_DEVELOPMENT_BUILD
    )
      throw new Error("Managed owner changed before app admission");
    const identity = await readDevelopmentIdentity(instance);
    if (!identity || !verifyDevelopmentRuntimeOwner(instance, identity))
      throw new DevelopmentOperationError(
        "owner-unverified",
        "App runtime ownership is unavailable",
      );
    validateDevelopmentDirectory(launch.cwd, instance.runtimeDir);
    mkdirSync(launch.cwd, { recursive: true, mode: 0o700 });
    const directory = join(instance.root, "apps");
    validateDevelopmentDirectory(directory, instance.store);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const admittedLaunch = developmentRemoteAppLaunch(launch, remote);
    const attempt = randomUUID();
    const path = join(directory, `${attempt}.json`);
    const managerIncarnation = await developmentProcessIdentity(process.pid);
    if (!managerIncarnation) throw new Error("Cannot verify app launcher");
    const receipt: AppReceipt = {
      version: 1,
      attempt,
      managerPid: process.pid,
      managerIncarnation,
      pid: null,
      incarnation: null,
      generation: current.activeBuild!.generation,
    };
    writeDevelopmentRecord(path, receipt);
    const child = spawn(admittedLaunch.bin, admittedLaunch.args, {
      cwd: launch.cwd,
      env: admittedLaunch.env,
      stdio: "inherit",
    });
    const completion = waitDevelopmentAppExit(child);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const incarnation = await developmentProcessIdentity(child.pid!);
      if (!incarnation) throw new Error("App exited during admission");
      writeDevelopmentRecord(path, { ...receipt, pid: child.pid, incarnation });
    } catch (error) {
      if (!child.pid || (await developmentProcessIdentity(child.pid)) === null)
        rmSync(path, { force: true });
      throw error;
    }
    return {
      child,
      completion,
      release: () =>
        withDevelopmentLock(instance, "lifecycle", async () => {
          const record = readApp(path);
          if (
            record?.attempt === attempt &&
            record.pid !== null &&
            (await developmentProcessIdentity(record.pid)) === null
          )
            rmSync(path);
        }),
    };
  });
}
