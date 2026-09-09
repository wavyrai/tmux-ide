import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import {
  DaemonBootstrapError,
  DaemonBootstrapCoordinator,
  type DaemonBootstrapResult,
  type DaemonBootstrapSnapshot,
  type DaemonBootstrapProbe,
} from "@tmux-ide/daemon-client/bootstrap-coordinator";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";

import {
  canonicalDaemonUrl,
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
  | "protocol-mismatch"
  | "product-version-mismatch";

export interface CanonicalDaemonBootstrapOptions {
  /** The shipped CLI entry which owns `runHeadlessDaemon`. */
  readonly entryPath: string;
  readonly cwd?: string;
  readonly expectedProductVersion?: string;
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
  readonly shutdownOlderOwner: (info: CanonicalDaemonInfo) => Promise<void>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
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

async function shutdownOlderOwner(info: CanonicalDaemonInfo): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (info.authToken) headers.authorization = `Bearer ${info.authToken}`;
  const response = await fetch(
    canonicalDaemonUrl("http", info.bindHostname, info.port, "/api/v2/action/daemon.shutdown"),
    {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({
        reason: "daemon-version-upgrade",
        expectedInstanceId: info.instanceId,
      }),
      signal: AbortSignal.timeout(2_000),
    },
  );
  const envelope = (await response.json().catch(() => null)) as {
    ok?: unknown;
    result?: { stopping?: unknown };
    error?: { code?: unknown };
  } | null;
  // The authenticated handler verifies expectedInstanceId before reporting this
  // conflict. A concurrent upgrader already requested the same retirement.
  if (
    (response.status === 200 || response.status === 409) &&
    envelope?.ok === false &&
    envelope.error?.code === "shutdown_already_in_progress"
  )
    return;
  if (!response.ok || envelope?.ok !== true || envelope.result?.stopping !== true) {
    throw new DaemonBootstrapError(
      "incompatible",
      `The older canonical daemon refused a version upgrade (HTTP ${response.status}).`,
      { reason: "protocol-mismatch" },
    );
  }
}

function sameCanonicalInstance(left: CanonicalDaemonInfo, right: CanonicalDaemonInfo): boolean {
  return (
    left.pid === right.pid &&
    left.port === right.port &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

const defaultDependencies: CanonicalDaemonBootstrapDependencies = {
  inspect: inspectCanonicalDaemonInfo,
  ownerProvenDead: isCanonicalDaemonRecordOwnerProvenDead,
  alive: isCanonicalDaemonAlive,
  identity: probeCanonicalDaemonIdentity,
  health: probeCanonicalDaemonHealth,
  spawnOwner,
  shutdownOlderOwner,
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise((resolveSleep) => {
      setTimeout(resolveSleep, milliseconds);
    }),
};

// Strict SemVer precedence: numeric prerelease identifiers must not sort lexically.
function compareProductVersions(actual: string, expected: string): number | null {
  const parse = (value: string) => {
    if (value.length > 256) return null;
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
        value,
      );
    if (!match) return null;
    const pre = match[4]?.split(".") ?? [];
    if (pre.some((part) => /^0\d+$/.test(part))) return null;
    return { core: match.slice(1, 4).map(BigInt), pre };
  };
  const a = parse(actual);
  const b = parse(expected);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length)
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i];
    const right = b.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/.test(left);
    const rn = /^\d+$/.test(right);
    if (ln !== rn) return ln ? -1 : 1;
    return ln ? (BigInt(left) < BigInt(right) ? -1 : 1) : left < right ? -1 : 1;
  }
  return 0;
}

function needsReplacement(info: CanonicalDaemonInfo, expected?: string): boolean {
  if (info.protocolVersion > DAEMON_WIRE_PROTOCOL_VERSION) return false;
  if (expected !== undefined) {
    const comparison = compareProductVersions(info.productVersion, expected);
    if (comparison === null || comparison > 0) return false;
    if (comparison < 0) return true;
  }
  return info.protocolVersion < DAEMON_WIRE_PROTOCOL_VERSION;
}

async function replaceOlderCanonicalDaemon(
  deps: CanonicalDaemonBootstrapDependencies,
  info: CanonicalDaemonInfo,
  timeoutMs: number,
  expectedProductVersion?: string,
): Promise<void> {
  if (!needsReplacement(info, expectedProductVersion)) {
    throw new DaemonBootstrapError(
      "incompatible",
      `Canonical daemon protocol ${info.protocolVersion} cannot be replaced by older protocol ${DAEMON_WIRE_PROTOCOL_VERSION}.`,
      { reason: "protocol-mismatch" },
    );
  }
  const [identity, health] = await Promise.all([deps.identity(info), deps.health(info)]);
  if (
    !info.authToken ||
    !identity ||
    !health ||
    identity.pid !== info.pid ||
    identity.instanceId !== info.instanceId ||
    identity.startedAt !== info.startedAt ||
    identity.protocolVersion !== info.protocolVersion ||
    health.protocolVersion !== info.protocolVersion ||
    identity.productVersion !== info.productVersion ||
    health.productVersion !== info.productVersion
  ) {
    throw new DaemonBootstrapError(
      "incompatible",
      "The older canonical daemon changed identity before the version upgrade.",
      { reason: "identity-mismatch" },
    );
  }
  const latest = deps.inspect();
  if (
    latest.status !== "valid" ||
    !sameCanonicalInstance(latest.info, info) ||
    latest.info.authToken !== info.authToken ||
    latest.info.bindHostname !== info.bindHostname ||
    latest.info.productVersion !== info.productVersion ||
    latest.info.protocolVersion !== info.protocolVersion
  ) {
    throw new DaemonBootstrapError("incompatible", "Canonical daemon changed before upgrade.", {
      reason: "identity-mismatch",
    });
  }
  await deps.shutdownOlderOwner(info);
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    const state = deps.inspect();
    if (state.status === "missing") return;
    if (state.status === "valid" && !sameCanonicalInstance(state.info, info)) return;
    if (!(await deps.alive(info))) return;
    await deps.sleep(25);
  }
  throw new DaemonBootstrapError(
    "control-timeout",
    "The older canonical daemon did not retire after accepting the version upgrade.",
    { reason: "protocol-mismatch" },
  );
}

async function probeCanonical(
  deps: CanonicalDaemonBootstrapDependencies,
  expectedProductVersion?: string,
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
  if (expectedProductVersion !== undefined) {
    const comparison = compareProductVersions(state.info.productVersion, expectedProductVersion);
    if (
      identity.productVersion !== state.info.productVersion ||
      health.productVersion !== state.info.productVersion
    ) {
      return { status: "incompatible", reason: "identity-mismatch" };
    }
    if (comparison === null || comparison < 0)
      return { status: "incompatible", reason: "product-version-mismatch" };
  }
  return { status: "compatible", candidate: state.info };
}

export function createCanonicalDaemonBootstrapCoordinator(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): DaemonBootstrapCoordinator<CanonicalDaemonInfo, never, CanonicalDaemonBootstrapFailure> {
  const deps = { ...defaultDependencies, ...dependencies };
  return new DaemonBootstrapCoordinator({
    probe: () => probeCanonical(deps, options.expectedProductVersion),
    spawn: () => deps.spawnOwner(resolve(options.entryPath), resolve(options.cwd ?? process.cwd())),
    timeoutMs: options.timeoutMs,
    onPhaseChanged: options.onPhaseChanged,
  });
}

export function ensureCanonicalDaemon(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): Promise<DaemonBootstrapResult<CanonicalDaemonInfo, never>> {
  const deps = { ...defaultDependencies, ...dependencies };
  const ensure = () => createCanonicalDaemonBootstrapCoordinator(options, deps).ensure();
  return ensure().catch(async (error: unknown) => {
    if (
      !(error instanceof DaemonBootstrapError) ||
      error.code !== "incompatible" ||
      (error.reason !== "protocol-mismatch" && error.reason !== "product-version-mismatch")
    ) {
      throw error;
    }
    const state = deps.inspect();
    // Another launcher may have won the upgrade between our incompatible
    // probe and this recovery inspection. Converge on its missing/current
    // state instead of rethrowing the stale mismatch observed above.
    if (state.status === "missing") return ensure();
    if (
      state.status === "valid" &&
      state.info.protocolVersion === DAEMON_WIRE_PROTOCOL_VERSION &&
      !needsReplacement(state.info, options.expectedProductVersion)
    ) {
      return ensure();
    }
    if (state.status !== "valid" || state.info.protocolVersion > DAEMON_WIRE_PROTOCOL_VERSION) {
      throw error;
    }
    const replacing = state.info;
    try {
      await replaceOlderCanonicalDaemon(
        deps,
        replacing,
        options.timeoutMs ?? 15_000,
        options.expectedProductVersion,
      );
    } catch (replacementError) {
      // A duplicate upgrader can retire the exact owner while this caller is
      // proving or shutting it down. Only adopt after inspection proves that
      // the old identity is gone; a failure against the same owner remains a
      // real replacement failure.
      const after = deps.inspect();
      if (
        after.status === "missing" ||
        (after.status === "valid" && !sameCanonicalInstance(after.info, replacing))
      ) {
        return ensure();
      }
      throw replacementError;
    }
    return ensure();
  });
}

/** Retire only a verified older owner; the foreground caller retains ownership of startup. */
export async function retireOutdatedCanonicalDaemon(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): Promise<boolean> {
  const deps = { ...defaultDependencies, ...dependencies };
  const state = deps.inspect();
  if (
    state.status !== "valid" ||
    !needsReplacement(state.info, options.expectedProductVersion) ||
    !(await deps.alive(state.info))
  )
    return false;
  try {
    await replaceOlderCanonicalDaemon(
      deps,
      state.info,
      options.timeoutMs ?? 15_000,
      options.expectedProductVersion,
    );
    return true;
  } catch (error) {
    const after = deps.inspect();
    if (
      after.status === "missing" ||
      (after.status === "valid" && !sameCanonicalInstance(after.info, state.info))
    )
      return false;
    throw error;
  }
}
