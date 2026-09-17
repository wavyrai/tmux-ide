import { requireDevelopmentNotSuspended } from "./development-suspension.ts";
import { verifyDevelopmentRuntimeOwner } from "./development-runtime-owner.ts";
/** Manager-owned app admission. A pre-spawn receipt closes reset's child-registration gap. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, opendirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type DevelopmentInstance, validateDevelopmentDirectory } from "./development-instance.ts";
import { withDevelopmentLock } from "./development-lock.ts";
import { developmentAppLaunch, statusDevelopmentInstance } from "./development-lifecycle.ts";
import {
  DevelopmentOperationError,
  readDevelopmentIdentity,
  developmentProcessIdentity,
  readPrivateDevelopmentRecord,
  writeDevelopmentRecord,
} from "./development-state.ts";
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
export async function launchDevelopmentApp(instance: DevelopmentInstance) {
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
    const child = spawn(launch.bin, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
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
