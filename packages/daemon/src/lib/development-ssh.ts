/** Read-only fixture handshake authority. No owner or tmux startup path. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { inspectCanonicalDaemonInfoPath } from "./canonical-daemon.ts";
import { RemoteDaemonHandshakeSchema } from "./ssh-daemon-transport.ts";
import { developmentOwnerEnvironment, statusDevelopmentInstance } from "./development-lifecycle.ts";
import { readDevelopmentBuild } from "./development-build.ts";
import {
  readDevelopmentIdentity,
  readDevelopmentOwner,
  ownerBuildEnvironment,
} from "./development-state.ts";
import { requireDevelopmentNotSuspended } from "./development-suspension.ts";
import type { DevelopmentInstance } from "./development-instance.ts";
export interface DevelopmentSshLease {
  version: 1;
  instanceId: string;
  worktree: string;
  name: string;
  store: string;
  daemonId: string;
  pid: number;
  port: number;
  startedAt: string;
  protocolVersion: number;
  productVersion: string;
  generation: string;
  manifestHash: string;
}
const unavailable = () => new Error("Development SSH fixture has no matching verified ready owner");
export async function developmentSshAuthority(instance: DevelopmentInstance) {
  requireDevelopmentNotSuspended(instance);
  const status = await statusDevelopmentInstance(instance);
  if (status.state !== "ready" || !status.daemon || !status.activeBuild) throw unavailable();
  const identity = await readDevelopmentIdentity(instance);
  const owner = readDevelopmentOwner(instance);
  if (
    !identity ||
    !owner ||
    owner.pid !== status.daemon.pid ||
    owner.generation !== status.activeBuild.generation
  )
    throw unavailable();
  const build = readDevelopmentBuild(instance, ownerBuildEnvironment(owner));
  if (!build.capabilities?.includes("container-suspension-v1")) throw unavailable();
  const env = developmentOwnerEnvironment(instance, identity, build);
  const final = await statusDevelopmentInstance(instance);
  requireDevelopmentNotSuspended(instance);
  const current = readDevelopmentOwner(instance);
  if (
    final.state !== "ready" ||
    JSON.stringify(final.daemon) !== JSON.stringify(status.daemon) ||
    current?.attempt !== owner.attempt ||
    current?.incarnation !== owner.incarnation ||
    current?.manifestHash !== owner.manifestHash ||
    current?.generation !== owner.generation
  )
    throw unavailable();
  const info = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
  if (
    info.status !== "valid" ||
    info.info.bindHostname !== "127.0.0.1" ||
    info.info.instanceId !== status.daemon.instanceId ||
    info.info.pid !== owner.pid ||
    info.info.port !== status.daemon.port
  )
    throw unavailable();
  const lease: DevelopmentSshLease = {
    version: 1,
    instanceId: instance.id,
    worktree: instance.worktree,
    name: instance.name,
    store: instance.store,
    daemonId: status.daemon.instanceId,
    pid: owner.pid,
    port: status.daemon.port,
    generation: owner.generation,
    manifestHash: owner.manifestHash,
    startedAt: info.info.startedAt,
    protocolVersion: info.info.protocolVersion,
    productVersion: info.info.productVersion,
  };
  return { lease, executable: build.tools.node, cli: build.cli, env };
}
/** Handshake bytes are credential-bearing: return only to the authenticated SSH channel.
 * Existing CLI performs another authenticated identity probe, without starting anything. */
export async function developmentSshHandshake(
  instance: DevelopmentInstance,
  expected: unknown,
): Promise<string> {
  const authority = await developmentSshAuthority(instance);
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw unavailable();
  const fields = expected as Record<string, unknown>;
  if (
    Object.keys(fields).length !== Object.keys(authority.lease).length ||
    Object.entries(authority.lease).some(([key, value]) => fields[key] !== value)
  )
    throw unavailable();
  try {
    const result = await promisify(execFile)(
      authority.executable,
      [authority.cli, "remote-daemon-info", "--json"],
      {
        env: authority.env,
        cwd: instance.worktree,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      },
    );
    // The CLI's schema and authenticated probe are authoritative. Do not echo stderr.
    const parsed = RemoteDaemonHandshakeSchema.parse(JSON.parse(result.stdout));
    if (
      parsed.daemon.bindHostname !== "127.0.0.1" ||
      parsed.daemon.instanceId !== authority.lease.daemonId ||
      parsed.daemon.port !== authority.lease.port ||
      parsed.daemon.pid !== authority.lease.pid ||
      parsed.daemon.startedAt !== authority.lease.startedAt ||
      parsed.daemon.protocolVersion !== authority.lease.protocolVersion ||
      parsed.daemon.productVersion !== authority.lease.productVersion
    )
      throw unavailable();
    requireDevelopmentNotSuspended(instance);
    const current = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
    const owner = readDevelopmentOwner(instance);
    if (
      current.status !== "valid" ||
      current.info.instanceId !== authority.lease.daemonId ||
      current.info.pid !== authority.lease.pid ||
      current.info.port !== authority.lease.port ||
      owner?.pid !== authority.lease.pid ||
      owner.generation !== authority.lease.generation ||
      owner.manifestHash !== authority.lease.manifestHash
    )
      throw unavailable();
    return result.stdout;
  } catch {
    throw unavailable();
  }
}
