import {
  accessSync,
  constants,
  openSync,
  closeSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
  linkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfo,
  probeCanonicalDaemonIdentity,
  releaseCanonicalDaemonSupervision,
  reserveCanonicalDaemonSupervision,
  type CanonicalDaemonInfoState,
} from "./canonical-daemon.ts";
import { createDaemonServiceManager } from "./daemon-service-manager.ts";
import { planDaemonService, type DaemonServicePlan } from "./daemon-service-plan.ts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import { IdeError } from "./errors.ts";
import { acquirePrivateOperationLock } from "./private-operation-lock.ts";

const RecordSchema = z.strictObject({
  version: z.literal(1),
  removing: z.boolean().optional(),
  executable: z.string().min(1),
  contents: z
    .string()
    .min(1)
    .max(64 * 1024),
});

export interface DaemonServiceDependencies {
  plan(executable: string): DaemonServicePlan;
  manager: typeof createDaemonServiceManager;
  inspect: typeof inspectCanonicalDaemonInfo;
  reserve: typeof reserveCanonicalDaemonSupervision;
  release: typeof releaseCanonicalDaemonSupervision;
  probe: typeof probeCanonicalDaemonIdentity;
  recordPath: string;
  waitMs: number;
}

function defaults(): DaemonServiceDependencies {
  const namespace = resolveRuntimeNamespace();
  return {
    plan: (executable) =>
      planDaemonService({
        platform: process.platform,
        uid: process.getuid?.() ?? 0,
        home: homedir(),
        configHome: process.env.XDG_CONFIG_HOME || undefined,
        executable,
        path: process.env.PATH || "/usr/bin:/bin",
        namespace,
      }),
    manager: createDaemonServiceManager,
    inspect: inspectCanonicalDaemonInfo,
    reserve: reserveCanonicalDaemonSupervision,
    release: releaseCanonicalDaemonSupervision,
    probe: probeCanonicalDaemonIdentity,
    recordPath: join(dirname(getCanonicalDaemonInfoPath()), "service.json"),
    waitMs: 30_000,
  };
}

function refused(message: string): never {
  throw new IdeError(message, { code: "DAEMON_SERVICE_REFUSED" });
}

function ownedFile(path: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 128 * 1024
    )
      refused(`Service file is not a bounded, user-owned regular file: ${path}`);
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function boundTo(state: CanonicalDaemonInfoState, id: string): boolean {
  return state.status === "reserved"
    ? state.reservation.supervisionId === id
    : state.status === "valid" && state.info.supervisionId === id;
}

/** Explicit OS supervision. Never starts a detached daemon or signals a guessed PID. */
export async function manageDaemonService(
  action: "install" | "status" | "restart" | "remove",
  executable?: string,
  deps: DaemonServiceDependencies = defaults(),
) {
  const previousRecord = ownedFile(deps.recordPath);
  const record = previousRecord === null ? null : RecordSchema.parse(JSON.parse(previousRecord));
  if (record?.removing && action !== "remove" && action !== "status")
    refused("Service removal is incomplete; finish remove before installing or restarting");
  if (!record && action !== "install") {
    if (action === "status") return { status: "not-installed" as const };
    refused("No managed service is installed in this daemon namespace");
  }
  if (action === "install" && !executable)
    refused("Service installation requires an absolute stable CLI launcher path");
  if (record && executable && record.executable !== executable)
    refused(
      "A different launcher is already registered; remove the stopped service before changing it",
    );
  const plan = deps.plan(record?.executable ?? executable!);
  if (plan.recordPath !== deps.recordPath) refused("Service namespace changed during resolution");
  const contents = record?.contents ?? plan.contents;
  const manager = deps.manager(plan);
  const assertFiles = (allowMissingUnit = false) => {
    const unit = ownedFile(plan.unitPath);
    if (unit !== contents && !((record?.removing || allowMissingUnit) && unit === null))
      refused("Service definition is missing or modified; refusing to control it");
    if (record && ownedFile(plan.recordPath) !== previousRecord)
      refused("Service ownership record changed");
  };
  const inspectManager = async () => {
    const state = await manager.inspect();
    const canonicalPath = (path: string) => join(realpathSync(dirname(path)), basename(path));
    if (
      state.loaded &&
      (!state.definitionPath ||
        canonicalPath(state.definitionPath) !== canonicalPath(plan.unitPath))
    )
      refused("The service manager loaded a different definition; refusing to control it");
    return state;
  };
  const ready = async (previousInstance?: string) => {
    const deadline = Date.now() + deps.waitMs;
    do {
      const state = deps.inspect();
      if (!boundTo(state, plan.supervisionId))
        refused("Service reservation changed during startup");
      if (state.status === "valid" && state.info.instanceId !== previousInstance) {
        const identity = await deps.probe(state.info);
        const service = await inspectManager();
        if (
          identity &&
          service.active &&
          service.pid === state.info.pid &&
          identity.pid === state.info.pid &&
          identity.instanceId === state.info.instanceId &&
          identity.startedAt === state.info.startedAt &&
          identity.protocolVersion === state.info.protocolVersion
        )
          return {
            status: "running" as const,
            manager: plan.manager,
            target: plan.target,
            pid: state.info.pid,
            instanceId: state.info.instanceId,
          };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    refused(
      "Service did not publish a verified daemon before the deadline; inspect service logs, then retry restart or remove",
    );
  };
  await manager.available();
  const service = await inspectManager();
  const allowMissingUnit = action === "remove" && !service.loaded;
  if (record) assertFiles(allowMissingUnit);
  if (action === "status") {
    const state = deps.inspect();
    const identity =
      service.active && state.status === "valid" && boundTo(state, plan.supervisionId)
        ? await deps.probe(state.info)
        : null;
    const verified =
      identity !== null &&
      state.status === "valid" &&
      service.pid === state.info.pid &&
      identity.pid === state.info.pid &&
      identity.instanceId === state.info.instanceId &&
      identity.startedAt === state.info.startedAt &&
      identity.protocolVersion === state.info.protocolVersion;
    return {
      status: verified
        ? ("running" as const)
        : service.active
          ? ("active-unverified" as const)
          : ("stopped" as const),
      manager: plan.manager,
      target: plan.target,
      pid: service.pid,
      reservationMatches: boundTo(state, plan.supervisionId),
      unitPath: plan.unitPath,
    };
  }
  if (!record && (service.loaded || ownedFile(plan.unitPath) !== null))
    refused("A service definition already exists without this namespace's ownership record");
  if (
    record &&
    !boundTo(deps.inspect(), plan.supervisionId) &&
    !(record.removing && action === "remove" && deps.inspect().status === "missing")
  )
    refused("Service reservation is missing or belongs to another owner");
  if (!record) {
    accessSync(plan.executable, constants.X_OK);
    // Canonical reservation admission rejects live, uncertain and foreign owners.
    deps.reserve(plan.supervisionId);
  }
  const lock = `${plan.recordPath}.lock`;
  const releaseLock = await acquirePrivateOperationLock(lock, 1000);
  let wroteRecord = false;
  let wroteUnit = false;
  let activationAttempted = false;
  try {
    if (record) assertFiles(allowMissingUnit);
    if (action === "install" && !record) {
      writeFileSync(
        plan.recordPath,
        JSON.stringify({ version: 1, executable: plan.executable, contents }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      wroteRecord = true;
      mkdirSync(dirname(plan.unitPath), { recursive: true, mode: 0o700 });
      const unitStage = `${plan.unitPath}.${randomUUID()}.tmp`;
      writeFileSync(unitStage, contents, { flag: "wx", mode: 0o600 });
      try {
        linkSync(unitStage, plan.unitPath);
      } finally {
        unlinkSync(unitStage);
      }
      wroteUnit = true;
      activationAttempted = true;
      await manager.install();
      return await ready();
    }
    if (action === "remove") {
      if (service.loaded) await manager.stop();
      let stopped = await inspectManager();
      const stopDeadline = Date.now() + deps.waitMs;
      while ((stopped.active || stopped.pid !== null) && Date.now() < stopDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        stopped = await inspectManager();
      }
      if (stopped.active || stopped.pid !== null)
        refused("Service manager has not confirmed the daemon stopped; reservation retained");
      assertFiles(allowMissingUnit);
      const removalRecord = JSON.stringify({ ...record!, removing: true }) + "\n";
      const temporaryRecord = `${plan.recordPath}.${randomUUID()}.tmp`;
      writeFileSync(temporaryRecord, removalRecord, { flag: "wx", mode: 0o600 });
      try {
        if (ownedFile(plan.recordPath) !== previousRecord)
          refused("Service ownership record changed during removal");
        renameSync(temporaryRecord, plan.recordPath);
      } finally {
        rmSync(temporaryRecord, { force: true });
      }
      if (ownedFile(plan.unitPath) !== null) unlinkSync(plan.unitPath);
      await manager.reload();
      if ((await inspectManager()).loaded)
        refused("Service remains loaded after removal; reservation retained");
      if (deps.inspect().status !== "missing") deps.release(plan.supervisionId);
      unlinkSync(plan.recordPath);
      return { status: "removed" as const, target: plan.target };
    }
    const before = deps.inspect();
    if (action === "install" && service.active) return await ready();
    if (service.loaded) await manager.restart(service.pid !== null);
    else await manager.install();
    return await ready(before.status === "valid" ? before.info.instanceId : undefined);
  } catch (error) {
    // Never discard ownership after an uncertain OS activation. The retained
    // record/reservation gives the explicit remove/restart commands a recovery path.
    if (!activationAttempted && wroteRecord) {
      if (wroteUnit && ownedFile(plan.unitPath) === contents) unlinkSync(plan.unitPath);
      unlinkSync(plan.recordPath);
      deps.release(plan.supervisionId);
    }
    throw error;
  } finally {
    releaseLock();
  }
}
