/**
 * restoreFleet over a fake tmux runner (#766): what the upgrade relies on.
 * No tmux runs; every command is recorded.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSnapshot } from "./tui/chrome/snapshot.ts";

const calls: string[][] = [];
let failOn: ((args: string[]) => boolean) | null = null;
let prefs = { resumeAgents: false };

vi.mock("@tmux-ide/tmux-bridge", () => ({
  runTmux: (args: string[]) => {
    calls.push(args);
    if (failOn?.(args)) throw new Error(`tmux failed: ${args.join(" ")}`);
    if (args[0] === "list-sessions") return "";
    if (args.includes("-P")) return args[0] === "split-window" ? "%2" : "@1";
    if (args[0] === "display-message") return "%1";
    return "";
  },
}));
vi.mock("./lib/project-registry.ts", () => ({
  listProjects: () => [{ name: "api", dir: "/work/api", configKind: "workspace" }],
}));
vi.mock("./lib/app-config.ts", async (original) => ({
  ...(await original<typeof import("./lib/app-config.ts")>()),
  loadAppConfig: () => ({ restore: prefs }),
}));
vi.mock("./tui/chrome/statusline.ts", () => ({ adoptSession: () => {} }));
const launched: string[] = [];
vi.mock("./launch.ts", () => ({
  launch: async (dir: string) => {
    launched.push(dir);
  },
}));

const { restoreFleet } = await import("./restore.ts");

const fleet = (): FleetSnapshot => ({
  version: 1,
  savedAt: "2026-11-10T09:00:00.000Z",
  sessions: ["api", "web"].map((name) => ({
    name,
    cwd: `/work/${name}`,
    adopted: false,
    windows: [
      {
        index: 0,
        name: "code",
        active: true,
        layout: "abcd,80x24,0,0{40x24,0,0,1,39x24,41,0,2}",
        panes: [
          {
            index: 0,
            cwd: `/work/${name}`,
            command: "claude",
            agent: "claude",
            agentSessionId: "0f3c9a2e-1111-4222-8333-944455556666",
            agentState: null,
            title: "agent",
          },
          {
            index: 1,
            cwd: `/work/${name}`,
            command: null,
            agent: null,
            agentSessionId: null,
            agentState: null,
            title: "sh",
          },
        ],
      },
    ],
  })),
});

let dir = "";
let file = "";
beforeEach(() => {
  calls.length = 0;
  launched.length = 0;
  failOn = null;
  prefs = { resumeAgents: false };
  dir = mkdtempSync(join(tmpdir(), "restore-fleet-"));
  file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(fleet()));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const resumes = () =>
  calls.filter((args) => args[0] === "send-keys" && args.some((a) => a.includes("--resume")));

describe("restoreFleet", () => {
  it("relaunches a config-backed session from its config unless snapshotOnly", async () => {
    // Plain restore --from: the workspace config wins for "api".
    const plain = await restoreFleet({ from: file });
    expect(launched).toEqual(["/work/api"]);
    expect(plain.launched).toEqual(["api"]);
    expect(plain.restored).toEqual(["web"]);

    launched.length = 0;
    const pinned = await restoreFleet({ from: file, snapshotOnly: true });
    expect(launched).toEqual([]);
    expect(pinned.restored).toEqual(["api", "web"]);
  });

  it("ORs the config default into resume only when resumeFromConfig is on", async () => {
    prefs = { resumeAgents: true };
    await restoreFleet({ from: file, snapshotOnly: true, resumeFromConfig: false });
    expect(resumes()).toEqual([]);
    calls.length = 0;
    await restoreFleet({ from: file, snapshotOnly: true });
    expect(resumes()).toHaveLength(2);
    calls.length = 0;
    prefs = { resumeAgents: false };
    await restoreFleet({
      from: file,
      snapshotOnly: true,
      resumeAgents: true,
      resumeFromConfig: false,
    });
    expect(resumes()).toHaveLength(2);
  });

  it("rebuilds the rest when one session fails, and lists the failure", async () => {
    failOn = (args) => args[0] === "new-session" && args.includes("api");
    const outcome = await restoreFleet({ from: file, snapshotOnly: true });
    expect(outcome.failed).toEqual(["api"]);
    expect(outcome.restored).toEqual(["web"]);
  });

  it("refuses a missing or unreadable --from file", async () => {
    await expect(restoreFleet({ from: join(dir, "nope.json") })).rejects.toThrow(
      /no readable snapshot at/,
    );
  });
});
