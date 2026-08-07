/**
 * The daemon under test: a real headless `tmux-ide` process over a scratch
 * fleet, and the owner-gated client the harness uses for SETUP only.
 *
 * Readiness is taken from the daemon's own startup-readiness ladder rather than
 * from ad-hoc polling of whichever route a test happens to need. The ladder is
 * the daemon's positive answer to "am I up?", so waiting on it means the suite
 * and the product agree on what "up" means — and a harness that hangs reports
 * the rung it is stuck at instead of a bare timeout.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  pollUntil,
  processIsAlive,
  spawnHarnessChild,
  type HarnessChild,
} from "./harness-process.ts";
import type { ScratchFleet } from "./scratch-fleet.ts";

const DAEMON_READY_TIMEOUT_MS = 45_000;
const LADDER_TIMEOUT_MS = 45_000;
const BUNDLE_BUILD_TIMEOUT_MS = 120_000;

export const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
export const rendererRoot = resolve(import.meta.dirname, "..", "..");

export interface CanonicalDaemonRecord {
  readonly port: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly authToken: string;
}

export interface StartupReadinessRung {
  readonly rung: string;
  readonly status: "pending" | "satisfied" | "stuck";
  readonly reason?: { readonly vocabulary: string; readonly code: string };
  readonly population?: {
    readonly fleet: "empty" | "populated";
    readonly workspaceCount: number;
    readonly attachablePaneCount: number;
  };
}

export interface StartupReadinessLadder {
  readonly rungs: readonly StartupReadinessRung[];
  readonly blockedAt: string | null;
}

export interface RunningDaemon {
  readonly record: CanonicalDaemonRecord;
  readonly baseUrl: string;
  readonly readiness: () => Promise<StartupReadinessLadder>;
  /** SETUP ONLY. Registers a session as a workspace without using the UI. */
  readonly promote: (label: string) => Promise<string>;
  readonly fleetLabels: () => Promise<readonly string[]>;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

const execFileAsync = promisify(execFile);
let bundleBuild: Promise<void> | null = null;

/**
 * Rebuild `bin/cli.js` before the first daemon of a run starts.
 *
 * The daemon under test is not the source tree — it is the esbuild bundle, so
 * every daemon-side change is invisible here until that bundle is rebuilt. A
 * stale bundle does not fail loudly; it silently tests the PREVIOUS commit's
 * daemon and reports whatever that code does, which is worse than a red suite
 * because it looks like a real verdict.
 *
 * This is not hypothetical. A rebase rewrites the tracked bundle to the target
 * branch's build, so the suite ran main's daemon against this branch's
 * assertions and reported a fix as broken. mtime cannot catch that — the rebase
 * makes the stale bundle NEWER than the sources it disagrees with — so the only
 * honest answer is to build it. It costs about a second, once per run.
 */
async function ensureDaemonBundle(): Promise<void> {
  bundleBuild ??= execFileAsync("node", [join(repoRoot, "scripts", "build-cli.mjs")], {
    cwd: repoRoot,
    timeout: BUNDLE_BUILD_TIMEOUT_MS,
  }).then(() => undefined);
  await bundleBuild;
}

export async function startDaemon(fleet: ScratchFleet): Promise<RunningDaemon> {
  await ensureDaemonBundle();
  const environment: NodeJS.ProcessEnv = { ...process.env, ...fleet.environment };
  // Inherited runtime hooks and a stale pane id would follow the daemon into
  // the scratch world and point it back at the developer's real tmux server.
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.TMUX_PANE;
  delete environment.TMUX_TMPDIR;

  const harness: HarnessChild = spawnHarnessChild({
    command: process.execPath,
    args: [join(repoRoot, "bin", "cli.js"), "--headless"],
    cwd: repoRoot,
    env: environment,
  });

  const record = await pollUntil<CanonicalDaemonRecord>({
    probe: async () => {
      if (harness.child.exitCode !== null) {
        throw new Error(`daemon exited (${harness.child.exitCode})\n${harness.output()}`);
      }
      const parsed = JSON.parse(
        await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"),
      ) as Partial<CanonicalDaemonRecord>;
      return parsed.port && parsed.authToken ? (parsed as CanonicalDaemonRecord) : null;
    },
    detail: "the daemon to publish its canonical record",
    timeoutMs: DAEMON_READY_TIMEOUT_MS,
  });

  const baseUrl = `http://127.0.0.1:${record.port}`;
  const owner = { Authorization: `Bearer ${record.authToken}` };

  const readiness = async (): Promise<StartupReadinessLadder> => {
    const response = await fetch(`${baseUrl}/api/resources/startup-readiness`, { headers: owner });
    if (!response.ok) throw new Error(`startup-readiness answered ${response.status}`);
    const body = (await response.json()) as { readonly ladder: StartupReadinessLadder };
    return body.ladder;
  };

  const fleetLabels = async (): Promise<readonly string[]> => {
    const response = await fetch(`${baseUrl}/api/resources/fleet-catalog`, { headers: owner });
    if (!response.ok) throw new Error(`fleet-catalog answered ${response.status}`);
    const body = (await response.json()) as {
      readonly sessions?: readonly { readonly label: string }[];
    };
    return (body.sessions ?? []).map((session) => session.label);
  };

  const promote = async (label: string): Promise<string> => {
    const session = await pollUntil<{ sessionId: string }>({
      probe: async () => {
        const response = await fetch(`${baseUrl}/api/resources/fleet-catalog`, { headers: owner });
        if (!response.ok) return null;
        const body = (await response.json()) as {
          readonly sessions?: readonly { readonly label: string; readonly sessionId: string }[];
        };
        return body.sessions?.find((entry) => entry.label === label) ?? null;
      },
      detail: `the session ${label} to appear in the fleet catalog`,
      timeoutMs: 30_000,
      intervalMs: 200,
    });
    const response = await fetch(`${baseUrl}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        ...owner,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
      },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    const body = (await response.json()) as {
      readonly ok?: boolean;
      readonly result?: { readonly resource?: { readonly workspaceName?: string } };
    };
    const workspaceName = body.result?.resource?.workspaceName;
    if (body.ok !== true || !workspaceName) {
      throw new Error(`workspace.promote refused for ${label}: ${JSON.stringify(body)}`);
    }
    return workspaceName;
  };

  return {
    record,
    baseUrl,
    readiness,
    promote,
    fleetLabels,
    output: harness.output,
    stop: async () => {
      await harness.stop();
      if (Number.isInteger(record.pid) && processIsAlive(record.pid)) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // Already gone with its group, which is the outcome we wanted.
        }
      }
    },
  };
}

/**
 * Wait for the daemon's own five-rung ladder to clear.
 *
 * `attachment-issuable` satisfied means a pane-stream lease could be issued NOW
 * — which is precisely the precondition the terminal chain depends on, and the
 * thing that used to be approximated by sleeping.
 */
export async function waitForReadinessLadder(
  daemon: RunningDaemon,
): Promise<StartupReadinessLadder> {
  let last: StartupReadinessLadder | null = null;
  return await pollUntil<StartupReadinessLadder>({
    probe: async () => {
      const ladder = await daemon.readiness();
      last = ladder;
      return ladder.blockedAt === null ? ladder : null;
    },
    detail: "the startup readiness ladder to clear every rung",
    timeoutMs: LADDER_TIMEOUT_MS,
    intervalMs: 250,
  }).catch((error: Error) => {
    const blocked = last?.blockedAt ?? "unknown";
    const rung = last?.rungs.find((entry) => entry.rung === blocked);
    const reason = rung?.reason
      ? `${rung.reason.vocabulary}/${rung.reason.code}`
      : "no reason given";
    throw new Error(`${error.message} — blocked at rung "${blocked}" (${reason})`);
  });
}
