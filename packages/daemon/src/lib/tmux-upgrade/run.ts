/**
 * The steps of `tmux-ide servers upgrade` (#766), over an injectable io so the
 * order and every refusal are unit-tested. Nothing is killed until a snapshot
 * written to its own file, read back and parsed, covers a fresh listing of the
 * server, and the user (or `--yes`, with `--end-running-agents` when an agent
 * is mid-turn) agreed. Real io: ./io.ts.
 */
import { IdeError } from "../errors.ts";
import type { FleetSnapshot } from "../../tui/chrome/snapshot.ts";
import type { ServerFeatures } from "../tmux-server-features.ts";
import {
  buildUpgradePlan,
  confirmation,
  coverage,
  renderPlan,
  sameShape,
  type ServerIdentity,
  type UpgradePlan,
} from "./plan.ts";

export type ServerFacts = Omit<ServerIdentity, "host" | "features">;

/** What the detached worker needs to finish an upgrade the user agreed to. */
export interface WorkerState {
  server: ServerIdentity;
  client: string;
  snapshotPath: string;
  resumeAgents: boolean;
}

export interface UpgradeIo {
  host(): string;
  /** The validated bundled tmux, or null. Throws when the bundle is damaged. */
  bundled(): { executable: string; version: string } | null;
  configuredBinary(): string | undefined;
  /** The target server as `client` reaches it; null when none runs. */
  identify(client: string): ServerFacts | null;
  features(client: string, socket: string): ServerFeatures;
  /** Start a throwaway server from `client` on a private socket and probe it. */
  scratchFeatures(client: string): ServerFeatures;
  listPanes(client: string, socket: string): string[];
  collect(client: string, socket: string): FleetSnapshot;
  /** Write the snapshot to a new file of its own (fsync'd); returns its path. */
  saveSnapshot(snapshot: FleetSnapshot): string;
  loadSnapshot(path: string): FleetSnapshot | null;
  /** Whether this process runs in a pane of the server at `socket`. */
  insideTarget(socket: string): boolean;
  confirm(text: string): Promise<boolean>;
  /** Start a detached worker that runs {@link finishUpgrade}; returns its log path. */
  startWorker(state: WorkerState): string;
  /** Kill exactly this server (guarded by pid and start time). */
  kill(client: string, server: ServerIdentity): void;
  /** Wait briefly; true once no server answers on the socket. */
  serverGone(client: string, socket: string): boolean;
  restore(input: {
    client: string;
    socket: string;
    snapshotPath: string;
    resumeAgents: boolean;
  }): Promise<{ restored: string[]; failed: string[] }>;
  print(text: string): void;
  nowSec(): number;
}

export interface UpgradeOptions {
  yes: boolean;
  endRunningAgents: boolean;
  json: boolean;
  dryRun: boolean;
  resumeAgents: boolean;
}

export type UpgradeStatus =
  | "already-full"
  | "preview"
  | "declined"
  | "refused"
  | "handed-off"
  | "upgraded"
  | "failed";

export interface UpgradeResult {
  status: UpgradeStatus;
  message: string;
  plan?: UpgradePlan;
  restored?: string[];
  failed?: string[];
}

const nothingChanged = (message: string, code: string) =>
  new IdeError(`${message} Nothing was stopped.`, { code, exitCode: 1 });

/** Snapshot, write, read back, and prove coverage against a fresh listing. */
function pinnedSnapshot(io: UpgradeIo, client: string, socket: string) {
  const snapshot = io.collect(client, socket);
  let path: string;
  try {
    path = io.saveSnapshot(snapshot);
  } catch (error) {
    throw nothingChanged(
      `The snapshot could not be written: ${(error as Error).message}.`,
      "SNAPSHOT_WRITE",
    );
  }
  const saved = io.loadSnapshot(path);
  if (!saved)
    throw nothingChanged(`The snapshot at ${path} could not be read back.`, "SNAPSHOT_READ");
  const covered = coverage(saved, io.listPanes(client, socket));
  if (!covered.ok)
    throw nothingChanged(
      `The snapshot does not cover the server: ${covered.problems.join("; ")}.`,
      "SNAPSHOT_COVERAGE",
    );
  return { snapshot: saved, path, notRestored: covered.notRestored };
}

export async function upgradeServer(
  io: UpgradeIo,
  options: UpgradeOptions,
): Promise<UpgradeResult> {
  const configured = io.configuredBinary();
  const bundled = io.bundled();
  if (!bundled)
    throw nothingChanged(
      "No bundled tmux found for this machine. Reinstall tmux-ide.",
      "NO_BUNDLED_TMUX",
    );
  if (configured && configured !== bundled.executable)
    throw nothingChanged(
      `TMUX_IDE_TMUX_BIN names ${configured}, not tmux-ide's own tmux. Unset it first.`,
      "TMUX_BIN_OVERRIDE",
    );
  const client = bundled.executable;
  const facts = io.identify(client);
  if (!facts)
    throw new IdeError("No tmux server is running here.", { code: "NO_SERVER", exitCode: 1 });
  const server: ServerIdentity = {
    ...facts,
    host: io.host(),
    features: io.features(client, facts.socketPath),
  };
  if (server.features === "full")
    return {
      status: "already-full",
      message: `${server.host} (${server.socketPath}) already runs tmux-ide's own tmux.`,
    };
  const scratch = io.scratchFeatures(client);
  if (scratch !== "full")
    throw nothingChanged(
      `A scratch server from the bundled tmux reports "${scratch}", not full features.`,
      "BUNDLE_NOT_FULL",
    );

  for (let attempt = 0; ; attempt++) {
    const pinned = pinnedSnapshot(io, client, server.socketPath);
    const plan = buildUpgradePlan({
      server,
      bundled,
      snapshot: pinned.snapshot,
      snapshotPath: pinned.path,
      notRestored: pinned.notRestored,
      resumeAgents: options.resumeAgents,
      nowSec: io.nowSec(),
    });
    const decision = confirmation({ ...options, midTurn: plan.midTurn });
    if (decision.kind === "preview") return { status: "preview", message: renderPlan(plan), plan };
    if (decision.kind === "refuse") {
      if (!options.json) io.print(renderPlan(plan));
      return { status: "refused", message: decision.reason, plan };
    }
    if (decision.kind === "ask") {
      io.print(renderPlan(plan));
      if (!(await io.confirm("Restart the server and restore? [y/N] ")))
        return { status: "declined", message: "Nothing was stopped.", plan };
    }
    // The server may have changed while the question was open.
    if (!coverage(pinned.snapshot, io.listPanes(client, server.socketPath)).ok) {
      if (attempt >= 2)
        throw nothingChanged(
          "The server keeps changing; try again in a moment.",
          "SERVER_CHANGING",
        );
      io.print("The server changed since the snapshot. Taking a new one.");
      continue;
    }
    const work: WorkerState = {
      server,
      client,
      snapshotPath: pinned.path,
      resumeAgents: options.resumeAgents,
    };
    if (io.insideTarget(server.socketPath)) {
      const log = io.startWorker(work);
      return {
        status: "handed-off",
        message: `This terminal runs inside that server and closes in a moment. Reopen tmux-ide or run \`tmux attach\` in a few seconds. Log: ${log}`,
        plan,
      };
    }
    const result = await stopAndRestore(io, work, pinned.snapshot);
    return { ...result, plan };
  }
}

/** The detached worker's entry: confirm it is still the same server, then finish. */
export async function finishUpgrade(io: UpgradeIo, work: WorkerState): Promise<UpgradeResult> {
  const facts = io.identify(work.client);
  if (!facts || facts.pid !== work.server.pid || facts.startTime !== work.server.startTime)
    return {
      status: "failed",
      message: "The server changed since the prompt. Nothing was stopped.",
    };
  const snapshot = io.loadSnapshot(work.snapshotPath);
  if (!snapshot || !coverage(snapshot, io.listPanes(work.client, work.server.socketPath)).ok)
    return {
      status: "failed",
      message: "The snapshot no longer covers the server. Nothing was stopped.",
    };
  return stopAndRestore(io, work, snapshot);
}

async function stopAndRestore(
  io: UpgradeIo,
  work: WorkerState,
  snapshot: FleetSnapshot,
): Promise<UpgradeResult> {
  const { server, client, snapshotPath, resumeAgents } = work;
  const retry = `Retry with: tmux-ide restore --from ${snapshotPath}`;
  try {
    io.kill(client, server);
  } catch (error) {
    return {
      status: "failed",
      message: `The kill failed (${(error as Error).message}); the server is still running. Nothing was stopped.`,
    };
  }
  if (!io.serverGone(client, server.socketPath))
    return {
      status: "failed",
      message: "The server is still running after the kill. Check it with `tmux-ide doctor`.",
    };
  const input = { socket: server.socketPath, snapshotPath, resumeAgents };
  let outcome: { restored: string[]; failed: string[] };
  try {
    outcome = await io.restore({ ...input, client });
  } catch (error) {
    if (!server.executable)
      return {
        status: "failed",
        message: `tmux-ide's tmux could not start a server (${(error as Error).message}). ${retry}`,
      };
    try {
      outcome = await io.restore({ ...input, client: server.executable });
    } catch (fallback) {
      return {
        status: "failed",
        message: `Neither tmux could start a server (${(fallback as Error).message}). ${retry}`,
      };
    }
    return {
      status: "failed",
      message: `tmux-ide's tmux could not start a server (${(error as Error).message}); your sessions were restored on ${server.executable} instead. ${retry}`,
      ...outcome,
    };
  }
  const features = io.features(client, server.socketPath);
  const shape = sameShape(snapshot, io.listPanes(client, server.socketPath));
  const problems = [
    ...outcome.failed.map((name) => `session ${name} failed to rebuild`),
    ...shape.filter((line) => !outcome.failed.some((name) => line.includes(` ${name} `))),
    ...(features === "full" ? [] : [`the new server reports "${features}", not full features`]),
  ];
  if (problems.length)
    return { status: "failed", message: `${problems.join("; ")}. ${retry}`, ...outcome };
  io.print(
    `Restored ${outcome.restored.length} sessions. tmux features: bundled tmux: full features.`,
  );
  return {
    status: "upgraded",
    message: `${server.host} (${server.socketPath}) now runs tmux-ide's own tmux.`,
    ...outcome,
  };
}
