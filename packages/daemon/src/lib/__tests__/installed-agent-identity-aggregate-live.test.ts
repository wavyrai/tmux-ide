/** Installed-artifact A1 qualification. Receipts identify sampled pane transitions,
 * not process generations or submitted tasks. All product execution uses the fixture CLI. */
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentIdForPaneStamp } from "../../command-center/resources/application-shell.ts";
import {
  assertUnifiedSocket,
  createPrivateFleet,
  tmuxAvailable,
  uniqueName,
  type EventsClient,
  type PrivateFleet,
} from "./installed-recovery-fixture.ts";

// Only the CLI wire fields asserted here; keep engine tests independent of TUI types.
interface FleetAggregateResponse {
  projects: Array<{ sessions: Array<{ name: string; status: string; panes: number }> }>;
}

const lsofAvailable = spawnSync("lsof", ["-v"], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe
  .skipIf(!tmuxAvailable || !lsofAvailable)
  .sequential("installed agent identity and aggregate wait (live)", () => {
    let fleet: PrivateFleet;
    let events: EventsClient;
    let session: string;
    let pane: string;
    let port: number;
    const oldStamp = "pane.installed.old";
    const newStamp = "pane.installed.replacement";

    beforeEach(async () => {
      fleet = await createPrivateFleet("identity");
      fleet.tmux("-f", "/dev/null", "new-session", "-d", "-s", "zz-keeper", "exec sleep 300");
      assertUnifiedSocket(fleet);
      session = uniqueName("identity"); // Non-internal name: visible to fleet discovery.
      pane = fleet.tmux(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        session,
        "exec sleep 300",
      );
      fleet.tmux("set-option", "-t", session, "@tmux_ide_adopted", "1");
      fleet.tmux("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", oldStamp);
      fleet.stampAgent(pane, "working");
      const daemon = await fleet.startDaemon();
      port = daemon.info.port;
      events = fleet.eventsClient(daemon.info);
      await fleet.bounded(events.ready, "fleet baseline acknowledgement");
      expect(events.frames.find((frame) => frame.type === "resource.interests-ack")).toMatchObject({
        interestRevision: 1,
        unavailableInterests: [],
      });
      fleet.evidence({
        scenario: "A1",
        step: "fixture",
        session,
        socketPath: fleet.socketPath,
        cliSha256: createHash("sha256").update(readFileSync(fleet.cliPath)).digest("hex"),
        runtime: process.version,
        platform: process.platform,
      });
    }, 30000);

    afterEach(async () => {
      if (!fleet) return;
      const root = fleet.root;
      await fleet.cleanup();
      expect(existsSync(root)).toBe(false);
      expect(existsSync(fleet.socketPath)).toBe(false);
      const serverProbe = spawnSync(
        fleet.env.TMUX_IDE_TMUX_BIN!,
        ["-S", fleet.socketPath, "list-sessions"],
        {
          cwd: "/tmp",
          env: fleet.env,
          stdio: "ignore",
        },
      );
      expect(serverProbe.error).toBeUndefined();
      expect(serverProbe.status).toBe(1);
      fleet.evidence({ scenario: "A1", step: "cleanup", rootRemoved: true, serverStopped: true });
    }, 30000);

    const receipts = (since: number) =>
      events.frames
        .slice(since)
        .filter((frame) => frame.type === "agent.turn-completed" && frame.sessionName === session);
    const changed = async (since: number) => {
      await fleet.until(
        () =>
          events.frames
            .slice(since)
            .find(
              (frame) => frame.type === "agent-status.changed" && frame.sessionName === session,
            ) ?? null,
        "observed agent invalidation",
      );
      // Invalidation and receipts are separate frames from the same observer sample.
      await pause(100);
    };
    const transition = async (target: string, state: "working" | "blocked" | "done" | "idle") => {
      const cursor = events.frames.length;
      fleet.stampAgent(target, state);
      await changed(cursor);
      return cursor;
    };
    const waiter = async (): Promise<ChildProcess> => {
      const child = fleet.cli([
        "wait",
        "agent-status",
        session,
        "--status",
        "done",
        "--timeout",
        "30000",
        "--json",
      ]);
      // Prove this installed CLI reaches this daemon, rather than merely polling tmux.
      await fleet.until(() => {
        const probe = spawnSync(
          "lsof",
          ["-a", "-p", String(child.pid), "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED"],
          { encoding: "utf8" },
        );
        return probe.status === 0 && probe.stdout.includes(`->127.0.0.1:${port}`) ? true : null;
      }, "installed waiter daemon connection");
      await pause(300);
      expect(child.exitCode).toBeNull();
      return child;
    };
    const succeeds = async (child: ChildProcess) => {
      const result = await fleet.bounded(fleet.exit(child), "wait completion", 10000);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ session, status: "done", ok: true });
    };
    const receiptFor = (frame: Record<string, unknown>, stamp: string | null, status = "done") => {
      expect(frame).toMatchObject({
        type: "agent.turn-completed",
        sessionName: session,
        agentId: stamp === null ? null : agentIdForPaneStamp(stamp),
        fromStatus: "working",
        toStatus: status,
      });
      const wire = JSON.stringify(frame);
      expect(wire).not.toContain(pane);
      expect(wire).not.toContain(fleet.root);
      if (stamp) expect(wire).not.toContain(stamp);
    };

    it.each(["replace", "remove", "gain", "respawn"] as const)(
      "rejects stale completion across %s identity and completes only a fresh observed turn",
      async (mode) => {
        if (mode === "gain") {
          const cursor = events.frames.length;
          fleet.tmux("set-option", "-pu", "-t", pane, "@tmux_ide_pane_id");
          await changed(cursor);
        }
        const previousPid = fleet.tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
        const cursor = events.frames.length;
        const stamp = mode === "remove" ? null : newStamp;
        const commands =
          mode === "respawn" ? ["respawn-pane", "-k", "-t", pane, "exec sleep 300", ";"] : [];
        commands.push("set-option", stamp === null ? "-pu" : "-p", "-t", pane, "@tmux_ide_pane_id");
        if (stamp !== null) commands.push(stamp);
        commands.push(
          ";",
          "set-option",
          "-p",
          "-t",
          pane,
          "@agent_state",
          `done:${Math.floor(Date.now() / 1000)}`,
        );
        fleet.tmux(...commands);
        await changed(cursor);
        await pause(2300);
        expect(receipts(cursor)).toEqual([]);
        if (mode === "respawn") {
          expect(fleet.tmux("display-message", "-p", "-t", pane, "#{pane_id}")).toBe(pane);
          expect(fleet.tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).not.toBe(
            previousPid,
          );
        }
        // A session wait may answer done here: it promises current aggregate,
        // not continuity with the replaced identity. Start it on a fresh working turn.
        await transition(pane, "working");
        const child = await waiter();
        await pause(2300);
        expect(child.exitCode).toBeNull();
        const fresh = await transition(pane, "done");
        await succeeds(child);
        expect(receipts(fresh)).toHaveLength(1);
        receiptFor(receipts(fresh)[0]!, stamp);
        fleet.evidence({
          scenario: "A1",
          step: "identity",
          mode,
          staleReceiptCount: receipts(cursor).length - 1,
          receipt: receipts(fresh)[0],
          wait: "done",
          reusedRuntimePane: mode === "respawn",
        });
      },
      45000,
    );

    it.each(["working", "blocked"] as const)(
      "waits for both agents when the second remains %s, ignoring historical completion",
      async (otherState) => {
        const second = fleet.tmux(
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          pane,
          "exec sleep 300",
        );
        fleet.tmux("set-option", "-p", "-t", second, "@tmux_ide_pane_id", newStamp);
        const secondCursor = events.frames.length;
        fleet.stampAgent(second, otherState);
        await changed(secondCursor);
        // An actual old completion precedes the new CLI's subscription.
        const historical = await transition(pane, "done");
        expect(receipts(historical)).toHaveLength(1);
        receiptFor(receipts(historical)[0]!, oldStamp);
        await transition(pane, "working");
        const child = await waiter();
        const first = await transition(pane, "done");
        expect(receipts(first)).toHaveLength(1);
        receiptFor(receipts(first)[0]!, oldStamp);
        await pause(2300);
        expect(child.exitCode).toBeNull();
        const team = await fleet.bounded(
          fleet.exit(fleet.cli(["team", "--json"])),
          "current aggregate",
        );
        expect(team.code, team.stderr).toBe(0);
        const current = (JSON.parse(team.stdout) as FleetAggregateResponse).projects
          .flatMap((project) => project.sessions)
          .find((entry) => entry.name === session);
        expect(current?.status).toBe(otherState);
        // Authority-only sleep fixtures contribute aggregate status, but lack
        // a detected agent manifest and therefore have no per-agent detail.
        expect(current?.panes).toBe(2);
        // A fresh subscriber must not receive the prior completion as a new receipt.
        const late = fleet.eventsClient(fleet.info()!);
        await fleet.bounded(late.ready, "late subscriber baseline");
        await pause(2300);
        expect(late.frames.filter((frame) => frame.type === "agent.turn-completed")).toEqual([]);
        late.close();
        if (otherState === "blocked") await transition(second, "working");
        const last = await transition(second, "done");
        await succeeds(child);
        expect(receipts(last)).toHaveLength(1);
        receiptFor(receipts(last)[0]!, newStamp);
        fleet.evidence({
          scenario: "A1",
          step: "aggregate",
          otherState,
          heldAfterFirstMs: 4600,
          firstReceipt: receipts(first)[0],
          secondReceipt: receipts(last)[0],
          historicalReplayCount: 0,
          wait: "done",
        });
      },
      45000,
    );
  });
