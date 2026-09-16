import {
  claimDevelopmentRuntimeOwner,
  verifyDevelopmentRuntimeOwner,
} from "./development-runtime-owner.ts";
import { WorkspaceAdmissionResourceSchemaZ } from "@tmux-ide/contracts";
/** Explicit manager API. No development lifecycle is reachable from production namespace getters. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DevelopmentInstance, validateDevelopmentDirectory } from "./development-instance.ts";
import {
  readDevelopmentBuild,
  developmentBuildLaunch,
  type DevelopmentBuildManifest,
} from "./development-build.ts";
import { withDevelopmentLock } from "./development-lock.ts";
import {
  developmentNamespaceEnvironment,
  developmentChildEnvironment,
  resolveRuntimeNamespace,
} from "./runtime-namespace.ts";
import {
  inspectCanonicalDaemonInfoPath,
  inspectCanonicalDaemonClaimPath,
  probeCanonicalDaemonIdentity,
  probeCanonicalDaemonHealth,
  canonicalDaemonUrl,
} from "./canonical-daemon.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
  type UnixSocketIdentity,
} from "./unix-socket-authority.ts";
import { boundedTmuxRead } from "./bounded-tmux-read.ts";
import {
  DevelopmentOperationError,
  readDevelopmentActivation,
  type DevelopmentActivationReceipt,
  cleanManagerEnvironment,
  developmentProcessIdentity,
  developmentWorktreeIdentity,
  readDevelopmentIdentity,
  readDevelopmentOwner,
  readPrivateDevelopmentRecord,
  writeDevelopmentRecord,
  ownerBuildEnvironment,
  type DevelopmentIdentityRecord,
} from "./development-state.ts";

const KEEPER = "tmux-ide-dev-keeper";
function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface TmuxRecord {
  version: 1;
  pid: number;
  incarnation: string;
  capability: string;
  executable: string;
  socket: { path: string; dev: number; ino: number; mtimeNs: string; birthtimeNs: string };
  keeper: string;
  generation: string;
  manifestHash: string;
}
export const socketIdentity = (record: TmuxRecord): UnixSocketIdentity => ({
  ...record.socket,
  mtimeNs: BigInt(record.socket.mtimeNs),
  birthtimeNs: BigInt(record.socket.birthtimeNs),
});
export function developmentOwnerEnvironment(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
  build: DevelopmentBuildManifest,
) {
  const namespace = resolveRuntimeNamespace({
    env: developmentNamespaceEnvironment(instance, identity.capability),
  });
  return {
    ...developmentChildEnvironment(namespace, cleanManagerEnvironment()),
    ...developmentBuildLaunch(build).environment,
    TMUX_IDE_CWD: instance.worktree,
    TMUX_IDE_DEVELOPMENT_BUILD_DIRTY: build.source.dirty ? "1" : "0",
  };
}
export function readTmux(instance: DevelopmentInstance): TmuxRecord | null {
  const record = readPrivateDevelopmentRecord<TmuxRecord>(join(instance.root, "tmux.json"));
  if (
    record &&
    (record.version !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.incarnation !== "string" ||
      typeof record.capability !== "string" ||
      record.socket?.path !== join(instance.runtimeDir, "tmux.sock") ||
      record.keeper !== KEEPER)
  )
    throw new Error("Invalid development tmux owner");
  return record;
}
export async function verifyTmux(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
  record: TmuxRecord,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    record.capability !== identity.capability ||
    (await developmentProcessIdentity(record.pid)) !== record.incarnation
  )
    throw new Error("Development tmux process ownership changed");
  const build = readDevelopmentBuild(instance, {
    TMUX_IDE_DEVELOPMENT_BUILD: record.generation,
    TMUX_IDE_DEVELOPMENT_BUILD_HASH: record.manifestHash,
  });
  if (
    record.executable !== join(build.assets, "tmux", `${process.platform}-${process.arch}`, "tmux")
  )
    throw new Error("Development tmux executable changed");
  const socket = revalidateUnixSocketIdentity(socketIdentity(record));
  const state = (
    await boundedTmuxRead(
      record.executable,
      ["-S", socket, "-N", "display-message", "-p", "#{pid}|#{@tmux_ide_development_owner}"],
      { env, timeoutMs: 1000, maxBuffer: 8192 },
    )
  ).trim();
  if (state !== `${record.pid}|${identity.capability}`)
    throw new Error("Development tmux server ownership changed");
}
export interface DevelopmentStatus {
  version: 1;
  instance: { id: string; worktree: string; name: string };
  state: "missing" | "stopped" | "starting" | "ready" | "blocked";
  reason: string | null;
  selectedBuild: { generation: string; sourceDigest: string } | null;
  activeBuild: { generation: string; sourceDigest: string } | null;
  daemon: { pid: number; instanceId: string; port: number; claimId: string } | null;
  tmux: { pid: number; socket: string; keeper: string; generation: string } | null;
  readiness: {
    identity: boolean;
    health: boolean;
    ownerAuthenticated: boolean;
    admission: unknown | null;
  };
  logs: { owner: string; startupReceipt: string };
  activation: DevelopmentActivationReceipt | null;
}
export async function statusDevelopmentInstance(
  instance: DevelopmentInstance,
  options: { allowOrphan?: boolean } = {},
): Promise<DevelopmentStatus> {
  const status: DevelopmentStatus = {
    version: 1,
    instance: { id: instance.id, worktree: instance.worktree, name: instance.name },
    state: "missing",
    reason: null,
    selectedBuild: null,
    activeBuild: null,
    daemon: null,
    tmux: null,
    readiness: { identity: false, health: false, ownerAuthenticated: false, admission: null },
    activation: null,
    logs: {
      owner: join(instance.root, "logs/owner.log"),
      startupReceipt: join(instance.root, "startup-receipt.json"),
    },
  };
  let phase = "activation-receipt-invalid";
  try {
    status.activation = readDevelopmentActivation(instance);
    phase = "instance-identity-invalid";
    let selected: DevelopmentBuildManifest | null = null;
    try {
      selected = readDevelopmentBuild(instance, {});
      status.selectedBuild = {
        generation: selected.generation,
        sourceDigest: selected.source.digest,
      };
    } catch {
      status.reason = "selected-build-unavailable";
    }
    const identity = await readDevelopmentIdentity(instance, options);
    if (!identity) return status;
    phase = "runtime-owner-invalid";
    verifyDevelopmentRuntimeOwner(instance, identity);
    phase = "process-owner-invalid";
    const publishedOwner = readDevelopmentOwner(instance);
    const startupOwner = readDevelopmentOwner(instance, "startup-process.json");
    const owner =
      startupOwner && (await developmentProcessIdentity(startupOwner.pid)) !== null
        ? startupOwner
        : publishedOwner;
    phase = "tmux-owner-invalid";
    const tmux = readTmux(instance);
    if (!tmux && pathPresent(join(instance.runtimeDir, "tmux.sock")))
      throw new Error("Unrecorded development tmux startup requires recovery");
    if (tmux) {
      if ((await developmentProcessIdentity(tmux.pid)) !== null) {
        await verifyTmux(instance, identity, tmux, cleanManagerEnvironment());
        status.tmux = {
          pid: tmux.pid,
          socket: tmux.socket.path,
          keeper: tmux.keeper,
          generation: tmux.generation,
        };
      } else if (pathPresent(tmux.socket.path)) {
        // Read-only status accepts only the exact dead owner's leftover socket.
        if (tmux.capability !== identity.capability) throw new Error("Tmux capability mismatch");
        revalidateUnixSocketIdentity(socketIdentity(tmux));
      }
    }
    phase = "canonical-owner-mismatch";
    const initialInfo = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
    const initialClaim = inspectCanonicalDaemonClaimPath(join(instance.stateHome, "daemon.claim"));
    if (initialInfo.status === "invalid" || initialClaim.status === "invalid")
      throw new Error("Unverified canonical metadata");
    for (const pid of [
      initialInfo.status === "valid" ? initialInfo.info.pid : null,
      initialClaim.status === "valid" ? initialClaim.claim.pid : null,
    ]) {
      if (pid !== null && pid !== owner?.pid && (await developmentProcessIdentity(pid)) !== null)
        throw new Error("Another canonical owner is protected");
    }
    if (!owner) {
      status.state = "stopped";
      return status;
    }
    phase = "process-incarnation-mismatch";
    const incarnation = await developmentProcessIdentity(owner.pid);
    if (incarnation === null) {
      status.state = "stopped";
      return status;
    }
    if (incarnation !== owner.incarnation) throw new Error("Managed process incarnation changed");
    phase = "active-build-unavailable";
    const active = readDevelopmentBuild(instance, ownerBuildEnvironment(owner));
    status.activeBuild = { generation: active.generation, sourceDigest: active.source.digest };
    status.state = "starting";
    phase = "canonical-owner-mismatch";
    const info = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
    const claim = inspectCanonicalDaemonClaimPath(join(instance.stateHome, "daemon.claim"));
    if (info.status === "missing" || claim.status === "missing") return status;
    if (
      info.status !== "valid" ||
      claim.status !== "valid" ||
      info.info.pid !== owner.pid ||
      claim.claim.pid !== owner.pid ||
      !info.info.authToken ||
      info.info.bindHostname !== "127.0.0.1" ||
      info.info.productVersion !== active.packageVersion
    )
      throw new Error("Canonical daemon does not match managed owner");
    const daemon = info.info;
    const signal = AbortSignal.timeout(1500);
    const [remote, health, admission] = await Promise.all([
      probeCanonicalDaemonIdentity(daemon, signal),
      probeCanonicalDaemonHealth(daemon, signal),
      fetch(
        canonicalDaemonUrl(
          "http",
          daemon.bindHostname,
          daemon.port,
          "/api/resources/workspace-admission",
        ),
        { headers: { Authorization: `Bearer ${daemon.authToken}` }, signal, redirect: "error" },
      )
        .then(async (response) => {
          if (!response.ok) return null;
          const parsed = WorkspaceAdmissionResourceSchemaZ.safeParse(await response.json());
          return parsed.success ? parsed.data : null;
        })
        .catch(() => null),
    ]);
    const finalClaim = inspectCanonicalDaemonClaimPath(join(instance.stateHome, "daemon.claim"));
    const final = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
    if (
      final.status !== "valid" ||
      JSON.stringify(final.info) !== JSON.stringify(daemon) ||
      finalClaim.status !== "valid" ||
      finalClaim.claim.claimId !== claim.claim.claimId ||
      (await developmentProcessIdentity(owner.pid)) !== owner.incarnation
    )
      return status;
    if (tmux) await verifyTmux(instance, identity, tmux, cleanManagerEnvironment());
    status.readiness.identity =
      remote !== null &&
      ["pid", "instanceId", "startedAt", "protocolVersion", "productVersion"].every(
        (key) => remote[key as keyof typeof remote] === daemon[key as keyof typeof daemon],
      );
    status.readiness.health =
      health?.ok === true &&
      health.protocolVersion === daemon.protocolVersion &&
      health.productVersion === daemon.productVersion;
    status.readiness.ownerAuthenticated =
      admission !== null &&
      ["instanceId", "startedAt", "protocolVersion", "productVersion"].every(
        (key) =>
          admission.daemon[key as keyof typeof admission.daemon] ===
          daemon[key as keyof typeof daemon],
      );
    if (status.readiness.ownerAuthenticated && admission)
      status.readiness.admission = { promotion: admission.promotion, open: admission.open };
    status.daemon = {
      pid: daemon.pid,
      instanceId: daemon.instanceId,
      port: daemon.port,
      claimId: claim.claim.claimId,
    };
    if (
      status.tmux &&
      status.readiness.identity &&
      status.readiness.health &&
      status.readiness.ownerAuthenticated
    ) {
      status.state = "ready";
      status.reason = selected ? null : "selected-build-unavailable";
    }
    if (status.state !== "ready")
      status.reason = !status.readiness.identity
        ? "identity-unavailable-or-mismatched"
        : !status.readiness.health
          ? "health-unavailable-or-mismatched"
          : !status.readiness.ownerAuthenticated
            ? "owner-auth-unavailable-or-mismatched"
            : "tmux-unavailable";
    return status;
  } catch {
    status.state = "blocked";
    status.reason = phase;
    return status;
  }
}
async function startTmux(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
  build: DevelopmentBuildManifest,
  env: NodeJS.ProcessEnv,
): Promise<{ record: TmuxRecord; created: boolean }> {
  const previous = readTmux(instance);
  if (previous) {
    if ((await developmentProcessIdentity(previous.pid)) !== null) {
      await verifyTmux(instance, identity, previous, env);
      return { record: previous, created: false };
    }
    if (pathPresent(previous.socket.path)) {
      if (previous.capability !== identity.capability) throw new Error("Tmux capability mismatch");
      // Only the lifecycle lock holder reclaims a proven dead owner's exact socket.
      const staleSocket = revalidateUnixSocketIdentity(socketIdentity(previous));
      unlinkSync(staleSocket);
    }
  }
  const socket = join(instance.runtimeDir, "tmux.sock");
  if (pathPresent(socket)) throw new Error("Unowned development tmux socket exists");
  const executable = join(build.assets, "tmux", `${process.platform}-${process.arch}`, "tmux");
  writeDevelopmentRecord(join(instance.root, "tmux-startup.json"), {
    version: 1,
    socket,
    executable,
    generation: build.generation,
    at: new Date().toISOString(),
  });
  await boundedTmuxRead(
    executable,
    [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      KEEPER,
      "-c",
      instance.worktree,
      "/bin/sh",
      "-c",
      "while :; do sleep 3600; done",
      ";",
      "set-option",
      "-g",
      "@tmux_ide_development_owner",
      identity.capability,
    ],
    { env, timeoutMs: 3000, maxBuffer: 8192 },
  );
  const socketStat = captureUnixSocketIdentity(socket);
  const pid = Number(
    (
      await boundedTmuxRead(executable, ["-S", socket, "-N", "display-message", "-p", "#{pid}"], {
        env,
        timeoutMs: 1000,
        maxBuffer: 8192,
      })
    ).trim(),
  );
  const incarnation = await developmentProcessIdentity(pid);
  if (!incarnation) throw new Error("Private tmux server did not survive startup");
  const record: TmuxRecord = {
    version: 1,
    pid,
    incarnation,
    capability: identity.capability,
    executable,
    socket: {
      ...socketStat,
      mtimeNs: String(socketStat.mtimeNs),
      birthtimeNs: String(socketStat.birthtimeNs),
    },
    keeper: KEEPER,
    generation: build.generation,
    manifestHash: developmentBuildLaunch(build).environment.TMUX_IDE_DEVELOPMENT_BUILD_HASH,
  };
  writeDevelopmentRecord(join(instance.root, "tmux.json"), record);
  return { record, created: true };
}
export async function upDevelopmentInstance(
  instance: DevelopmentInstance,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DevelopmentStatus> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30000)
  )
    throw new Error("timeoutMs must be between 100 and 30000");
  return withDevelopmentLock(
    instance,
    "lifecycle",
    () => startDevelopmentInstanceUnderLock(instance, options),
    options.signal,
  );
}
/** Internal transition primitive: caller MUST hold this instance lifecycle lock. */
export async function startDevelopmentInstanceUnderLock(
  instance: DevelopmentInstance,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    buildPin?: { generation: string; manifestHash: string };
  } = {},
): Promise<DevelopmentStatus> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30000)
  )
    throw new Error("timeoutMs must be between 100 and 30000");
  let phase = "instance-identity";
  return (async () => {
    phase = "instance-identity";
    let identity = await readDevelopmentIdentity(instance);
    if (!identity) {
      if (
        pathPresent(join(instance.stateHome, "daemon.json")) ||
        pathPresent(join(instance.runtimeDir, "tmux.sock"))
      )
        throw new Error("Unowned development resources exist");
      identity = {
        version: 1,
        id: instance.id,
        digest: instance.digest,
        worktree: instance.worktree,
        name: instance.name,
        capability: randomUUID(),
        ...(await developmentWorktreeIdentity(instance)),
      };
      writeDevelopmentRecord(join(instance.root, "instance.json"), identity);
    }
    phase = "runtime-ownership";
    claimDevelopmentRuntimeOwner(instance, identity);
    let current = await statusDevelopmentInstance(instance);
    const transitionDeadline = Date.now() + 3000;
    while (current.state === "starting" && Date.now() < transitionDeadline) {
      options.signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = await statusDevelopmentInstance(instance);
    }
    if (current.state === "ready") return current;
    phase = current.reason ?? "existing-owner-unavailable";
    if (current.state === "blocked" || current.state === "starting")
      throw new Error(
        "Existing development owner is unavailable; inspect status and logs before recovery",
      );
    phase = "build-validation";
    const build = readDevelopmentBuild(
      instance,
      options.buildPin
        ? {
            TMUX_IDE_DEVELOPMENT_BUILD: options.buildPin.generation,
            TMUX_IDE_DEVELOPMENT_BUILD_HASH: options.buildPin.manifestHash,
          }
        : {},
    );
    if (!build.capabilities?.includes("managed-development-owner-v1"))
      throw new Error(
        "Rebuild this instance: selected build predates the managed development owner",
      );
    for (const [path, root] of [
      [instance.stateHome, instance.store],
      [join(instance.root, "logs"), instance.store],
      [instance.runtimeDir, dirname(instance.runtimeDir)],
    ] as const) {
      validateDevelopmentDirectory(path, root);
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const env = developmentOwnerEnvironment(instance, identity, build);
    let createdTmux = false;
    let tmux: TmuxRecord | undefined;
    const attempt = randomUUID();
    const launch = developmentBuildLaunch(build);
    writeDevelopmentRecord(join(instance.root, "startup.json"), {
      attempt,
      generation: build.generation,
      manifestHash: launch.environment.TMUX_IDE_DEVELOPMENT_BUILD_HASH,
    });
    let child: ChildProcess | undefined;
    let startedIdentity: string | null = null;
    try {
      phase = "tmux-startup";
      const startedTmux = await startTmux(instance, identity, build, env);
      tmux = startedTmux.record;
      createdTmux = startedTmux.created;
      options.signal?.throwIfAborted();
      phase = "owner-spawn";
      child = spawn(launch.executable, [build.cli, "--development-owner"], {
        cwd: instance.root,
        env: { ...env, TMUX_IDE_DEVELOPMENT_ATTEMPT: attempt },
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("spawn", resolve);
      });
      child.unref();
      startedIdentity = await developmentProcessIdentity(child.pid!);
      if (!startedIdentity) throw new Error("Managed owner exited before its process receipt");
      writeDevelopmentRecord(join(instance.root, "startup-process.json"), {
        version: 1,
        attempt,
        pid: child.pid,
        incarnation: startedIdentity,
        generation: build.generation,
        manifestHash: launch.environment.TMUX_IDE_DEVELOPMENT_BUILD_HASH,
      });
      const deadline = Date.now() + Math.min(options.timeoutMs ?? 15000, 30000);
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        phase = "readiness";
        const status = await statusDevelopmentInstance(instance);
        if (status.reason) phase = status.reason;
        if (status.state === "ready") {
          if (status.daemon?.pid !== child.pid)
            throw new Error("Concurrent canonical winner is not this managed process");
          writeDevelopmentRecord(join(instance.root, "startup-receipt.json"), {
            version: 1,
            status: "ready",
            attempt,
            pid: child.pid,
            at: new Date().toISOString(),
          });
          return status;
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Managed development owner exited during startup");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Managed development readiness timed out");
    } catch (error) {
      if (
        child?.pid &&
        startedIdentity &&
        (await developmentProcessIdentity(child.pid)) === startedIdentity
      ) {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 300));
        if ((await developmentProcessIdentity(child.pid)) === startedIdentity)
          child.kill("SIGKILL");
      }
      if (createdTmux && tmux) {
        try {
          const canonical = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
          const claim = inspectCanonicalDaemonClaimPath(join(instance.stateHome, "daemon.claim"));
          if (canonical.status === "invalid" || claim.status === "invalid")
            throw new Error("Unverified canonical owner protects tmux", { cause: error });
          for (const pid of [
            canonical.status === "valid" ? canonical.info.pid : null,
            claim.status === "valid" ? claim.claim.pid : null,
          ]) {
            if (pid !== null && (await developmentProcessIdentity(pid)) !== null)
              throw new Error("Live canonical owner protects tmux", { cause: error });
          }
          await verifyTmux(instance, identity, tmux, env);
          await boundedTmuxRead(tmux.executable, ["-S", tmux.socket.path, "kill-server"], {
            env,
            timeoutMs: 1000,
          });
          // Retain the ownership receipt: tmux may leave its dead socket behind.
        } catch {
          /* Unknown replacements are never killed. */
        }
      }
      writeDevelopmentRecord(join(instance.root, "startup-receipt.json"), {
        version: 1,
        status: "failed",
        reason: options.signal?.aborted ? "cancelled" : phase,
        attempt,
        at: new Date().toISOString(),
      });
      throw new Error(
        `Development startup failed; inspect ${join(instance.root, "startup-receipt.json")} and logs/owner.log`,
        { cause: error },
      );
    }
  })().catch(() => {
    let receipt: string | undefined;
    if (phase !== "lifecycle-admission") {
      validateDevelopmentDirectory(instance.root, instance.store);
      writeDevelopmentRecord(join(instance.root, "startup-receipt.json"), {
        version: 1,
        status: "failed",
        reason: options.signal?.aborted ? "cancelled" : phase,
        at: new Date().toISOString(),
      });
    }
    if (phase !== "lifecycle-admission") receipt = join(instance.root, "startup-receipt.json");
    throw new DevelopmentOperationError(
      "startup-failed",
      `Development ${phase} failed; inspect private instance records and logs/owner.log`,
      receipt,
    );
  });
}
export async function developmentAppLaunch(instance: DevelopmentInstance) {
  const status = await upDevelopmentInstance(instance);
  const identity = await readDevelopmentIdentity(instance);
  const owner = readDevelopmentOwner(instance);
  if (!identity || !owner || status.daemon?.pid !== owner.pid)
    throw new Error("Development owner changed before app launch");
  const build = readDevelopmentBuild(instance, ownerBuildEnvironment(owner));
  const cwd = join(instance.runtimeDir, "compiled-tui");
  verifyDevelopmentRuntimeOwner(instance, identity);
  return {
    status,
    bin: build.tui,
    args: ["app"],
    cwd,
    env: developmentOwnerEnvironment(instance, identity, build),
  };
}
