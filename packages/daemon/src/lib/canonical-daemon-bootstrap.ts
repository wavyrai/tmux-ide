import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import {
  DaemonBootstrapCoordinator,
  type DaemonBootstrapResult,
  type DaemonBootstrapSnapshot,
  type DaemonBootstrapProbe,
} from "@tmux-ide/daemon-client/bootstrap-coordinator";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";

import {
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  type CanonicalDaemonInfo,
  type CanonicalDaemonInfoState,
} from "./canonical-daemon.ts";

export type CanonicalDaemonBootstrapFailure =
  | "canonical-record-invalid"
  | "identity-mismatch"
  | "protocol-mismatch";

export interface CanonicalDaemonBootstrapOptions {
  /** The shipped CLI entry which owns `runHeadlessDaemon`. */
  readonly entryPath: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly onPhaseChanged?: (
    snapshot: DaemonBootstrapSnapshot<CanonicalDaemonInfo, never, CanonicalDaemonBootstrapFailure>,
  ) => void;
}

export interface CanonicalDaemonBootstrapDependencies {
  readonly inspect: () => CanonicalDaemonInfoState;
  readonly ownerProvenDead: (
    state: Exclude<CanonicalDaemonInfoState, { status: "missing" }>,
  ) => Promise<boolean>;
  readonly alive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  readonly identity: typeof probeCanonicalDaemonIdentity;
  readonly health: typeof probeCanonicalDaemonHealth;
  readonly spawnOwner: (entryPath: string, cwd: string) => Promise<void>;
}

function spawnOwner(entryPath: string, cwd: string): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entryPath, "--headless", "--json"], {
        cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.removeListener("error", reject);
      child.unref();
      resolveSpawn();
    });
  });
}

const defaultDependencies: CanonicalDaemonBootstrapDependencies = {
  inspect: inspectCanonicalDaemonInfo,
  ownerProvenDead: isCanonicalDaemonRecordOwnerProvenDead,
  alive: isCanonicalDaemonAlive,
  identity: probeCanonicalDaemonIdentity,
  health: probeCanonicalDaemonHealth,
  spawnOwner,
};

async function probeCanonical(
  deps: CanonicalDaemonBootstrapDependencies,
): Promise<DaemonBootstrapProbe<CanonicalDaemonInfo, CanonicalDaemonBootstrapFailure>> {
  const state = deps.inspect();
  if (state.status === "missing") return { status: "absent-or-stale" };
  if (state.status === "invalid") {
    return (await deps.ownerProvenDead(state))
      ? { status: "absent-or-stale" }
      : { status: "incompatible", reason: "canonical-record-invalid" };
  }
  if (!(await deps.alive(state.info))) return { status: "absent-or-stale" };

  const [identity, health] = await Promise.all([
    deps.identity(state.info),
    deps.health(state.info),
  ]);
  // A living elected generation may publish before its accept loop. Preserve
  // it as the one candidate: the generic coordinator will poll this adapter,
  // while spawning another owner would merely lose the canonical claim.
  if (!identity || !health) return { status: "control-pending", candidate: state.info };
  if (
    identity.instanceId !== state.info.instanceId ||
    identity.pid !== state.info.pid ||
    identity.startedAt !== state.info.startedAt
  ) {
    return { status: "incompatible", reason: "identity-mismatch" };
  }
  if (
    state.info.protocolVersion !== DAEMON_WIRE_PROTOCOL_VERSION ||
    identity.protocolVersion !== state.info.protocolVersion ||
    health.protocolVersion !== state.info.protocolVersion
  ) {
    return { status: "incompatible", reason: "protocol-mismatch" };
  }
  return { status: "compatible", candidate: state.info };
}

export function createCanonicalDaemonBootstrapCoordinator(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): DaemonBootstrapCoordinator<CanonicalDaemonInfo, never, CanonicalDaemonBootstrapFailure> {
  const deps = { ...defaultDependencies, ...dependencies };
  return new DaemonBootstrapCoordinator({
    probe: () => probeCanonical(deps),
    spawn: () => deps.spawnOwner(resolve(options.entryPath), resolve(options.cwd ?? process.cwd())),
    timeoutMs: options.timeoutMs,
    onPhaseChanged: options.onPhaseChanged,
  });
}

export function ensureCanonicalDaemon(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): Promise<DaemonBootstrapResult<CanonicalDaemonInfo, never>> {
  return createCanonicalDaemonBootstrapCoordinator(options, dependencies).ensure();
}
