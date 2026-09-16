import {
  claimDevelopmentRuntimeOwner,
  verifyDevelopmentRuntimeOwner,
  releaseDevelopmentRuntimeOwner,
} from "./development-runtime-owner.ts";
import { requireStoppedDevelopmentApps } from "./development-app.ts";
/** Explicit lifecycle mutations, always under the existing per-instance lock protocol. */
import { readdirSync, rmSync, lstatSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DevelopmentInstance } from "./development-instance.ts";
import { validateDevelopmentDirectory } from "./development-instance.ts";
import { withDevelopmentLock } from "./development-lock.ts";
import {
  DevelopmentOperationError,
  readDevelopmentIdentity,
  readDevelopmentOwner,
  readPrivateDevelopmentRecord,
  developmentProcessIdentity,
  ownerBuildEnvironment,
  cleanManagerEnvironment,
  writeDevelopmentRecord,
  type DevelopmentOwnerRecord,
} from "./development-state.ts";
import { readDevelopmentBuild } from "./development-build.ts";
import {
  readTmux,
  verifyTmux,
  socketIdentity,
  statusDevelopmentInstance,
} from "./development-lifecycle.ts";
import { revalidateUnixSocketIdentity } from "./unix-socket-authority.ts";
import { boundedTmuxRead } from "./bounded-tmux-read.ts";
import {
  inspectCanonicalDaemonInfoPath,
  inspectCanonicalDaemonClaimPath,
  probeCanonicalDaemonIdentity,
  canonicalDaemonUrl,
} from "./canonical-daemon.ts";
import { restartCanonicalDaemon } from "./restart-canonical-daemon.ts";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function requireIdentity(instance: DevelopmentInstance) {
  const identity = await readDevelopmentIdentity(instance, { allowOrphan: true, allowReset: true });
  if (!identity)
    throw new DevelopmentOperationError(
      "identity-unavailable",
      "Verified stored development identity required",
    );
  return identity;
}
async function waitDead(pid: number, incarnation: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await developmentProcessIdentity(pid);
    if (current === null) return;
    if (current !== incarnation)
      throw new DevelopmentOperationError(
        "owner-unverified",
        "Process PID was reused; replacement is protected",
      );
    await delay(50);
  }
  throw new DevelopmentOperationError("owner-live", "Owned process did not stop before deadline");
}
/** Canonical records may change during an H04 reset but may never point at a foreign live PID. */
async function inspectOwner(instance: DevelopmentInstance, owner: DevelopmentOwnerRecord | null) {
  const info = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
  const claim = inspectCanonicalDaemonClaimPath(join(instance.stateHome, "daemon.claim"));
  if (info.status === "invalid" || claim.status === "invalid")
    throw new DevelopmentOperationError(
      "owner-unverified",
      "Unverified canonical records protect this instance",
    );
  for (const pid of [
    info.status === "valid" ? info.info.pid : null,
    claim.status === "valid" ? claim.claim.pid : null,
  ]) {
    if (pid !== null && (await developmentProcessIdentity(pid)) !== null && pid !== owner?.pid)
      throw new DevelopmentOperationError(
        "owner-unverified",
        "Foreign canonical owner is protected",
      );
  }
  return { info, claim };
}
async function ownedProcess(instance: DevelopmentInstance) {
  const records = [
    readDevelopmentOwner(instance),
    readDevelopmentOwner(instance, "startup-process.json"),
  ];
  let owner: DevelopmentOwnerRecord | null = null;
  for (const record of records) {
    if (!record) continue;
    const current = await developmentProcessIdentity(record.pid);
    if (current === null) continue;
    if (current !== record.incarnation)
      throw new DevelopmentOperationError(
        "owner-unverified",
        "Managed PID was reused; replacement is protected",
      );
    if (owner && JSON.stringify(owner) !== JSON.stringify(record))
      throw new DevelopmentOperationError(
        "owner-unverified",
        "Competing managed process receipts are protected",
      );
    owner = record;
  }
  await inspectOwner(instance, owner);
  if (!owner) return null;
  readDevelopmentBuild(instance, ownerBuildEnvironment(owner));
  const admitted = readPrivateDevelopmentRecord<{ version: number; attempt: string; pid: number }>(
    join(instance.root, `launch-${owner.attempt}.json`),
  );
  const pending = readPrivateDevelopmentRecord<{
    attempt: string;
    generation: string;
    manifestHash: string;
  }>(join(instance.root, "startup.json"));
  if (
    (admitted !== null &&
      (admitted.version !== 1 ||
        admitted.attempt !== owner.attempt ||
        admitted.pid !== owner.pid)) ||
    (!admitted &&
      JSON.stringify(readDevelopmentOwner(instance, "startup-process.json")) !==
        JSON.stringify(owner)) ||
    pending?.attempt !== owner.attempt ||
    pending.generation !== owner.generation ||
    pending.manifestHash !== owner.manifestHash
  )
    throw new DevelopmentOperationError(
      "owner-unverified",
      "Process launch admission is unverified",
    );
  return owner;
}
export async function restartDevelopmentInstance(
  instance: DevelopmentInstance,
  options: { applyBuild?: boolean } = {},
) {
  if (options.applyBuild)
    throw new DevelopmentOperationError(
      "unsupported-apply-build",
      "--apply-build is not implemented; restart resets the currently loaded runtime only",
    );
  return withDevelopmentLock(instance, "lifecycle", async () => {
    await requireIdentity(instance);
    const owner = await ownedProcess(instance);
    const before = await statusDevelopmentInstance(instance, { allowOrphan: true });
    if (!owner || before.state !== "ready")
      throw new Error(
        "A ready managed owner is required for restart; use up to start a stopped instance",
      );
    const restarted = await restartCanonicalDaemon(
      {},
      {
        inspect: () => inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json")),
        fetch,
        sleep: async (ms, signal) => {
          signal.throwIfAborted();
          await delay(ms);
          signal.throwIfAborted();
        },
      },
    );
    const after = await statusDevelopmentInstance(instance, { allowOrphan: true });
    if (
      restarted.pid !== owner.pid ||
      (await developmentProcessIdentity(owner.pid)) !== owner.incarnation ||
      after.state !== "ready" ||
      after.activeBuild?.generation !== before.activeBuild?.generation
    )
      throw new Error("Restart could not verify the same managed process/build");
    return { ...after, transition: "runtime-restarted" as const };
  });
}
async function stopOwner(instance: DevelopmentInstance) {
  const owner = await ownedProcess(instance);
  if (!owner) return;
  const { info, claim } = await inspectOwner(instance, owner);
  let requested = false;
  if (
    info.status === "valid" &&
    claim.status === "valid" &&
    info.info.pid === owner.pid &&
    claim.claim.pid === owner.pid &&
    info.info.authToken &&
    info.info.bindHostname === "127.0.0.1"
  ) {
    const record = info.info;
    const remote = await probeCanonicalDaemonIdentity(record);
    const again = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
    if (
      remote &&
      ["pid", "instanceId", "startedAt", "protocolVersion", "productVersion"].every(
        (key) => remote[key as keyof typeof remote] === record[key as keyof typeof record],
      ) &&
      again.status === "valid" &&
      JSON.stringify(again.info) === JSON.stringify(record) &&
      (await developmentProcessIdentity(owner.pid)) === owner.incarnation
    ) {
      const response = await fetch(
        canonicalDaemonUrl(
          "http",
          record.bindHostname,
          record.port,
          "/api/v2/action/daemon.shutdown",
        ),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${record.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expectedInstanceId: record.instanceId }),
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        },
      );
      if (!response.ok) throw new Error("Owned shutdown request was rejected");
      requested = true;
    }
  }
  if (!requested) {
    // Interrupted startup or unavailable HTTP: nonce + exact OS incarnation +
    // immutable build proof is still explicit ownership, never a PID-only kill.
    if (JSON.stringify(await ownedProcess(instance)) !== JSON.stringify(owner))
      throw new Error("Managed owner changed before stop");
    process.kill(owner.pid, "SIGTERM");
  }
  await waitDead(owner.pid, owner.incarnation);
}
async function stopTmux(instance: DevelopmentInstance) {
  const identity = await requireIdentity(instance);
  const tmux = readTmux(instance);
  const socket = join(instance.runtimeDir, "tmux.sock");
  if (!tmux) {
    if (present(socket))
      throw new DevelopmentOperationError(
        "owner-unverified",
        "Unrecorded tmux socket is protected",
      );
    return;
  }
  if (tmux.capability !== identity.capability)
    throw new DevelopmentOperationError("owner-unverified", "Tmux capability mismatch");
  const current = await developmentProcessIdentity(tmux.pid);
  if (current !== null) {
    await verifyTmux(instance, identity, tmux, cleanManagerEnvironment());
    await boundedTmuxRead(
      tmux.executable,
      [
        "-S",
        socket,
        "-N",
        "if-shell",
        "-F",
        `#{&&:#{==:#{pid},${tmux.pid}},#{==:#{@tmux_ide_development_owner},${identity.capability}}}`,
        "kill-server",
      ],
      {
        env: cleanManagerEnvironment(),
        timeoutMs: 1000,
      },
    );
    await waitDead(tmux.pid, tmux.incarnation);
  }
  if (present(socket)) rmSync(revalidateUnixSocketIdentity(socketIdentity(tmux)));
}
function retireAdmission(instance: DevelopmentInstance) {
  // No owner survives here. Remove admission first so consumed attempts are no longer eligible.
  for (const name of ["startup.json", "startup-process.json"])
    rmSync(join(instance.root, name), { force: true });
  for (const name of readdirSync(instance.root)) {
    if (!/^launch-[a-f0-9-]{36}\.json$/u.test(name)) continue;
    const record = readPrivateDevelopmentRecord<{ attempt: string }>(join(instance.root, name));
    if (record && `launch-${record.attempt}.json` === name) rmSync(join(instance.root, name));
  }
}
export async function downDevelopmentInstance(
  instance: DevelopmentInstance,
  options: { daemonOnly?: boolean } = {},
) {
  return withDevelopmentLock(instance, "lifecycle", async () => {
    const identity = await requireIdentity(instance);
    verifyDevelopmentRuntimeOwner(instance, identity);
    await stopOwner(instance);
    await inspectOwner(instance, null);
    if (!options.daemonOnly) await stopTmux(instance);
    retireAdmission(instance);
    return {
      instanceId: instance.id,
      status: "stopped" as const,
      scope: options.daemonOnly ? "daemon" : "instance",
    };
  });
}
export async function resetDevelopmentInstance(
  instance: DevelopmentInstance,
  options: { yes?: boolean } = {},
) {
  if (!options.yes)
    throw new DevelopmentOperationError(
      "confirmation-required",
      "reset requires --yes and an already stopped instance",
    );
  return withDevelopmentLock(instance, "build", () =>
    withDevelopmentLock(instance, "lifecycle", async () => {
      const identity = await requireIdentity(instance);
      await requireStoppedDevelopmentApps(instance);
      if (await ownedProcess(instance))
        throw new DevelopmentOperationError("owner-live", "Stop the managed owner before reset");
      await inspectOwner(instance, null);
      const tmux = readTmux(instance);
      if (tmux && (await developmentProcessIdentity(tmux.pid)) !== null)
        throw new DevelopmentOperationError("owner-live", "Stop the tmux server before reset");
      // This only reclaims a dead exact socket, never implicitly stops work.
      claimDevelopmentRuntimeOwner(instance, identity);
      await stopTmux(instance);
      validateDevelopmentDirectory(instance.runtimeDir, dirname(instance.runtimeDir));
      const compiledCwd = join(instance.runtimeDir, "compiled-tui");
      validateDevelopmentDirectory(compiledCwd, dirname(instance.runtimeDir));
      rmSync(compiledCwd, { recursive: true, force: true });
      releaseDevelopmentRuntimeOwner(instance, identity);
      if (present(instance.runtimeDir)) rmdirSync(instance.runtimeDir); // Unknown runtime entries block reset.

      // Keep the shared D04 lock scaffold; deleting it would let a concurrent old
      // build/up bypass the locks and lose a newly published generation.
      writeDevelopmentRecord(join(instance.root, "reset.json"), identity);
      for (const name of readdirSync(instance.root)) {
        if (name === "locks" || name === "reset.json") continue;
        rmSync(join(instance.root, name), { recursive: true, force: true });
      }
      return { instanceId: instance.id, status: "reset" as const };
    }),
  );
}
