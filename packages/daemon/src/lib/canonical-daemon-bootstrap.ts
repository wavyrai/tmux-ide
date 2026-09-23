import {
  captureTmuxServerProof,
  captureUnboundTmuxSelectorProof,
  type TmuxServerProof,
} from "./tmux-server-proof.ts";
import {
  createPinnedWorkspaceTmuxRunner,
  resolveWorkspacePaneTmuxAuthority,
} from "./workspace-pane-creation.ts";
import { resolveRuntimeNamespace, resolveTmuxServerIntent } from "./runtime-namespace.ts";
import { compareProductVersions } from "./semver.ts";
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
  getCanonicalDaemonInfoPath,
  prepareCanonicalDaemonInfoForBootstrap,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  type CanonicalDaemonInfo,
  type CanonicalDaemonInfoState,
} from "./canonical-daemon.ts";

export type CanonicalDaemonBootstrapFailure =
  | "tmux-server-mismatch"
  | "tmux-server-unproven"
  | "canonical-record-invalid"
  | "identity-mismatch"
  | "protocol-mismatch"
  | "product-version-mismatch";

export interface CanonicalDaemonBootstrapOptions {
  readonly tmuxServerIntent?: ReturnType<typeof resolveTmuxServerIntent>;
  readonly supervisionId?: string;
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
  readonly serverProof: (
    intent: NonNullable<ReturnType<typeof resolveTmuxServerIntent>>,
  ) => TmuxServerProof | null;
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
  if (resolveRuntimeNamespace().development)
    return Promise.reject(
      new Error(
        "Development owner startup requires the managed instance lifecycle; automatic detached bootstrap is disabled",
      ),
    );
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
  // This adapter owns startup, so legacy permission preparation is explicit
  // here. Injected inspectors remain isolated from real filesystem mutation.
  serverProof: (intent) => {
    try {
      const authority = { ...resolveWorkspacePaneTmuxAuthority(), socketSelector: intent.selector };
      return (
        captureTmuxServerProof(createPinnedWorkspaceTmuxRunner(authority, { timeoutMs: 1000 })) ??
        captureUnboundTmuxSelectorProof(authority)
      );
    } catch {
      return null;
    }
  },
  inspect: prepareCanonicalDaemonInfoForBootstrap,
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
  intent: ReturnType<typeof resolveTmuxServerIntent> = null,
): Promise<void> {
  if (!needsReplacement(info, expectedProductVersion)) {
    throw new DaemonBootstrapError(
      "incompatible",
      `Canonical daemon protocol ${info.protocolVersion} cannot be replaced by older protocol ${DAEMON_WIRE_PROTOCOL_VERSION}.`,
      { reason: "protocol-mismatch" },
    );
  }
  const [identity, health] = await Promise.all([
    deps.identity(info, undefined, Boolean(intent)),
    deps.health(info),
  ]);
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
  assertServerIntent(deps, info, identity, intent);
  const latest = deps.inspect();
  if (
    latest.status !== "valid" ||
    !sameCanonicalInstance(latest.info, info) ||
    latest.info.authToken !== info.authToken ||
    latest.info.bindHostname !== info.bindHostname ||
    latest.info.productVersion !== info.productVersion ||
    latest.info.protocolVersion !== info.protocolVersion ||
    latest.info.supervisionId !== info.supervisionId
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

function assertServerIntent(
  deps: CanonicalDaemonBootstrapDependencies,
  info: CanonicalDaemonInfo,
  identity: NonNullable<Awaited<ReturnType<typeof probeCanonicalDaemonIdentity>>>,
  intent: ReturnType<typeof resolveTmuxServerIntent>,
): void {
  if (!intent) return;
  const proof = deps.serverProof(intent);
  if (info.tmuxServerProofVersion !== 1 || !identity.tmuxServerProof || !proof)
    throw new DaemonBootstrapError(
      "incompatible",
      "Cannot prove the requested tmux server for this daemon. Its server identity is unavailable or unsupported; the existing daemon was left running.",
      { reason: "tmux-server-unproven" },
    );
  if (
    identity.tmuxServerProof.kind !== proof.kind ||
    identity.tmuxServerProof.digest !== proof.digest
  )
    throw new DaemonBootstrapError(
      "incompatible",
      "The existing daemon manages a different tmux server. It was left running; select its server or use a separate daemon namespace.",
      { reason: "tmux-server-mismatch" },
    );
}

async function probeCanonical(
  deps: CanonicalDaemonBootstrapDependencies,
  expectedProductVersion?: string,
  intent: ReturnType<typeof resolveTmuxServerIntent> = null,
): Promise<DaemonBootstrapProbe<CanonicalDaemonInfo, CanonicalDaemonBootstrapFailure>> {
  const state = deps.inspect();
  if (state.status === "missing") return { status: "absent-or-stale" };
  if (state.status === "reserved") return { status: "owner-pending" };
  if (state.status === "invalid") {
    if (await deps.ownerProvenDead(state)) return { status: "absent-or-stale" };
    throw new DaemonBootstrapError(
      "incompatible",
      `Canonical daemon record ${getCanonicalDaemonInfoPath()} is invalid (${state.reason}). ` +
        (state.recoveryDetail ? `Permission recovery refused: ${state.recoveryDetail}. ` : "") +
        "Automatic recovery could not establish trusted metadata with a proven-dead owner. " +
        "Verify record and parent ownership, permissions and provenance before retrying; " +
        "another daemon will not be started.",
      { reason: "canonical-record-invalid" },
    );
  }
  if (!(await deps.alive(state.info)))
    return { status: state.info.supervisionId ? "owner-pending" : "absent-or-stale" };

  const [identity, health] = await Promise.all([
    deps.identity(state.info, undefined, Boolean(intent)),
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
  assertServerIntent(deps, state.info, identity, intent);
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
  if (state.info.supervisionId) {
    const current = deps.inspect();
    if (
      current.status !== "valid" ||
      !sameCanonicalInstance(current.info, state.info) ||
      current.info.supervisionId !== state.info.supervisionId
    )
      return { status: "owner-pending" };
  }
  return { status: "compatible", candidate: state.info };
}

/** Remember observed supervision through retirement and missing-record races. */
function supervisedAdmission(
  deps: CanonicalDaemonBootstrapDependencies,
  declaredBinding?: string,
): CanonicalDaemonBootstrapDependencies {
  let binding = declaredBinding;
  const inspect = () => {
    const state = deps.inspect();
    const next =
      state.status === "reserved"
        ? state.reservation.supervisionId
        : state.status === "valid"
          ? state.info.supervisionId
          : undefined;
    if (binding && (state.status === "valid" || state.status === "reserved") && next !== binding)
      throw new DaemonBootstrapError(
        "incompatible",
        "Supervisor namespace binding changed during bootstrap",
        { reason: "canonical-record-invalid" },
      );
    binding ??= next;
    return state;
  };
  return {
    ...deps,
    inspect,
    spawnOwner: async (entry, cwd) => {
      inspect();
      if (!binding) await deps.spawnOwner(entry, cwd);
    },
  };
}

export function createCanonicalDaemonBootstrapCoordinator(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): DaemonBootstrapCoordinator<CanonicalDaemonInfo, never, CanonicalDaemonBootstrapFailure> {
  options = {
    ...options,
    tmuxServerIntent:
      options.tmuxServerIntent === undefined ? resolveTmuxServerIntent() : options.tmuxServerIntent,
  };
  const deps = supervisedAdmission(
    { ...defaultDependencies, ...dependencies },
    options.supervisionId,
  );
  return new DaemonBootstrapCoordinator({
    probe: () =>
      probeCanonical(
        deps,
        options.expectedProductVersion,
        options.tmuxServerIntent === undefined
          ? resolveTmuxServerIntent()
          : options.tmuxServerIntent,
      ),
    spawn: () => deps.spawnOwner(resolve(options.entryPath), resolve(options.cwd ?? process.cwd())),
    timeoutMs: options.timeoutMs,
    onPhaseChanged: options.onPhaseChanged,
    now: deps.now,
    sleep: deps.sleep,
  });
}

export function ensureCanonicalDaemon(
  options: CanonicalDaemonBootstrapOptions,
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): Promise<DaemonBootstrapResult<CanonicalDaemonInfo, never>> {
  options = {
    ...options,
    tmuxServerIntent:
      options.tmuxServerIntent === undefined ? resolveTmuxServerIntent() : options.tmuxServerIntent,
  };
  const deps = supervisedAdmission(
    { ...defaultDependencies, ...dependencies },
    options.supervisionId,
  );
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
        options.tmuxServerIntent === undefined
          ? resolveTmuxServerIntent()
          : options.tmuxServerIntent,
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
  options = {
    ...options,
    tmuxServerIntent:
      options.tmuxServerIntent === undefined ? resolveTmuxServerIntent() : options.tmuxServerIntent,
  };
  const deps = supervisedAdmission(
    { ...defaultDependencies, ...dependencies },
    options.supervisionId,
  );
  const state = deps.inspect();
  if (
    options.supervisionId &&
    (state.status === "reserved"
      ? state.reservation.supervisionId
      : state.status === "valid"
        ? state.info.supervisionId
        : undefined) !== options.supervisionId
  )
    throw new DaemonBootstrapError(
      "incompatible",
      "Matching supervisor reservation required before retirement",
      { reason: "canonical-record-invalid" },
    );
  if (
    state.status !== "valid" ||
    !needsReplacement(state.info, options.expectedProductVersion) ||
    !(await deps.alive(state.info))
  )
    return false;
  if (state.info.supervisionId) {
    await ensureCanonicalDaemon(options, deps);
    return false;
  }
  try {
    await replaceOlderCanonicalDaemon(
      deps,
      state.info,
      options.timeoutMs ?? 15_000,
      options.expectedProductVersion,
      options.tmuxServerIntent === undefined ? resolveTmuxServerIntent() : options.tmuxServerIntent,
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

/** Admission for foreground election winners and explicit takeover paths. */
export async function assertCanonicalDaemonServerIntent(
  info: CanonicalDaemonInfo,
  intent: ReturnType<typeof resolveTmuxServerIntent> = resolveTmuxServerIntent(),
  dependencies: Partial<CanonicalDaemonBootstrapDependencies> = {},
): Promise<void> {
  if (!intent) return;
  const deps = { ...defaultDependencies, ...dependencies };
  const identity = await deps.identity(info, undefined, true);
  if (
    !identity ||
    identity.pid !== info.pid ||
    identity.instanceId !== info.instanceId ||
    identity.startedAt !== info.startedAt
  )
    throw new DaemonBootstrapError(
      "incompatible",
      "Canonical daemon identity could not be verified for the requested tmux server.",
      { reason: "identity-mismatch" },
    );
  assertServerIntent(deps, info, identity, intent);
}
