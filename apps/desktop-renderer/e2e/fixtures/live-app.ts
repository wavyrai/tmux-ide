/**
 * The one fixture every chain imports: a running app, live end to end.
 *
 * It composes the three pieces of real infrastructure — scratch tmux fleet,
 * headless daemon, Vite dev server — and hands a chain both the page URL and
 * the handles to perturb the world behind it (kill a session, create another).
 * A chain declares the world it needs with `test.use({ scratchSessions: 2 })`.
 *
 * Teardown is unconditional and runs in reverse order of construction, plus a
 * process-level hook so an interrupted run leaves no daemon, no vite and no
 * tmux server behind.
 */
import { test as base } from "@playwright/test";
import { randomBytes } from "node:crypto";

import {
  startDaemon,
  waitForReadinessLadder,
  type RunningDaemon,
  type StartupReadinessLadder,
} from "./daemon.ts";
import { startDevServer, type RunningDevServer } from "./dev-server.ts";
import { createScratchFleet, type ScratchFleet } from "./scratch-fleet.ts";

export interface LiveApp {
  readonly fleet: ScratchFleet;
  readonly daemon: RunningDaemon;
  readonly devServer: RunningDevServer;
  /** The app URL, development-host opt-in included. */
  readonly pageUrl: string;
  /** The ladder as it stood when the harness declared the app ready. */
  readonly readinessAtStart: StartupReadinessLadder;
  /** Workspace names created during setup, in promotion order. */
  readonly promotedWorkspaces: readonly string[];
}

export interface LiveAppOptions {
  /** Adopted scratch sessions to stand up. Zero is a legitimate empty fleet. */
  readonly scratchSessions: number;
  /**
   * How many of them to promote to workspaces during SETUP. The app has no
   * surface that lists sessions until at least one workspace is open, so a
   * chain that wants to exercise the in-app promote path still needs one.
   */
  readonly promoteSessions: number;
}

/** Leftover children from a crashed run are the incident this suite must not cause. */
const liveTeardowns = new Set<() => Promise<void>>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const drain = (): void => {
    for (const teardown of liveTeardowns) void teardown();
  };
  process.once("exit", drain);
  process.once("SIGINT", () => {
    drain();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    drain();
    process.exit(143);
  });
}

export const test = base.extend<LiveAppOptions & { liveApp: LiveApp }>({
  scratchSessions: [1, { option: true }],
  promoteSessions: [1, { option: true }],

  liveApp: async ({ scratchSessions, promoteSessions }, use) => {
    installExitHook();
    // Short and random: the whole path has to fit in a 104-byte sun_path.
    const slug = randomBytes(3).toString("hex");
    const fleet = await createScratchFleet({ sessions: scratchSessions, slug });
    let daemon: RunningDaemon | null = null;
    let devServer: RunningDevServer | null = null;
    const teardown = async (): Promise<void> => {
      liveTeardowns.delete(teardown);
      await devServer?.stop();
      await daemon?.stop();
      await fleet.dispose();
    };
    liveTeardowns.add(teardown);

    try {
      daemon = await startDaemon(fleet);
      const promotedWorkspaces: string[] = [];
      for (const label of fleet.sessionNames.slice(0, promoteSessions)) {
        promotedWorkspaces.push(await daemon.promote(label));
      }
      const readinessAtStart = await waitForReadinessLadder(daemon);
      devServer = await startDevServer(daemon);
      await use({
        fleet,
        daemon,
        devServer,
        pageUrl: devServer.pageUrl,
        readinessAtStart,
        promotedWorkspaces,
      });
    } finally {
      await teardown();
    }
  },
});

export { expect } from "@playwright/test";
