/**
 * Live proof, against the CLI under test: two `tmux-ide --headless` starts
 * racing for one state home yield exactly one authority, the loser reports
 * the winner instead of publishing a second record, a late contender is
 * refused the same way, and the winner's events clients keep receiving
 * receipts throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertUnifiedSocket,
  createPrivateFleet,
  tmuxAvailable,
  uniqueName,
  type PrivateFleet,
} from "./installed-recovery-fixture.ts";

describe.skipIf(!tmuxAvailable).sequential("installed daemon authority contest (live)", () => {
  let fleet: PrivateFleet;
  const agentSession = uniqueName("agent");
  let agentPane = "";

  beforeAll(async () => {
    fleet = await createPrivateFleet("authority");
    fleet.tmux("-f", "/dev/null", "new-session", "-d", "-s", "zz-keeper", "exec sleep 300");
    assertUnifiedSocket(fleet);
    agentPane = fleet.tmux(
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      agentSession,
      "-n",
      "agent",
      "exec sleep 300",
    );
    fleet.tmux(
      "set-option",
      "-p",
      "-t",
      agentPane,
      "@tmux_ide_pane_id",
      `pane.livetest.${uniqueName("k").replace(/-/gu, "")}`,
    );
    fleet.tmux("set-option", "-t", agentSession, "@tmux_ide_adopted", "1");
    fleet.stampAgent(agentPane, "working");
  }, 60_000);

  afterAll(async () => {
    await fleet?.cleanup();
  }, 30_000);

  it("elects exactly one authority under a cold race and refuses a late contender", async () => {
    const contenders = [fleet.cli(["--headless", "--json"]), fleet.cli(["--headless", "--json"])];
    // Exactly one publishes a record and stays; the other prints the winner and exits.
    const published = await fleet.until(() => {
      const value = fleet.info();
      return value && contenders.some((child) => child.pid === value.pid) ? value : null;
    }, "one contender publishes");
    const winner = contenders.find((child) => child.pid === published.pid)!;
    const loser = contenders.find((child) => child !== winner)!;
    const loserExit = await fleet.bounded(fleet.exit(loser), "loser exit");
    expect(loserExit.code, loserExit.stderr).toBe(0);
    const loserLine = JSON.parse(loserExit.stdout.trim().split("\n").at(-1)!);
    expect(loserLine).toMatchObject({
      status: "already-running",
      pid: published.pid,
      port: published.port,
    });
    expect(winner.exitCode).toBeNull();
    expect(fleet.info()?.instanceId).toBe(published.instanceId);
    fleet.evidence({
      scenario: 2,
      step: "cold-race",
      winnerPid: published.pid,
      loserPid: loser.pid,
      loserStdout: loserLine,
    });

    await fleet.until(() => {
      const probe = fleet.tmuxStatus("has-session", "-t", agentSession);
      return probe === 0 ? true : null;
    }, "agent session");
    // The winner is fully attachable before a client subscribes.
    const health = (await fleet.fetchJson(published, "/health")) as { ok: boolean };
    expect(health.ok).toBe(true);
    const events = fleet.eventsClient(published);
    await fleet.bounded(events.ready, "events subscription");
    const hello = events.frames.find((frame) => frame.type === "hello") as {
      daemon: { instanceId: string };
    };
    expect(hello.daemon.instanceId).toBe(published.instanceId);

    // A late contender against the live authority is refused the same way.
    const late = await fleet.bounded(
      fleet.exit(fleet.cli(["--headless", "--json"])),
      "late contender",
    );
    expect(late.code, late.stderr).toBe(0);
    const lateLine = JSON.parse(late.stdout.trim().split("\n").at(-1)!);
    expect(lateLine).toMatchObject({
      status: "already-running",
      pid: published.pid,
      port: published.port,
    });
    expect(fleet.info()?.instanceId).toBe(published.instanceId);
    expect(winner.exitCode).toBeNull();

    // The winner's client still receives receipts after both contests.
    const framesBefore = events.frames.length;
    fleet.stampAgent(agentPane, "done");
    const receipt = await fleet.until(
      () => {
        const frame = events.frames
          .slice(framesBefore)
          .find(
            (candidate) =>
              (candidate.type === "agent.turn-completed" ||
                candidate.type === "agent-status.changed") &&
              candidate.sessionName === agentSession,
          );
        return frame ?? null;
      },
      "receipt after contest",
      15000,
    );
    expect(receipt).toBeTruthy();
    fleet.evidence({
      scenario: 2,
      step: "receipt-after-contest",
      lateStdout: lateLine,
      receiptType: receipt.type,
      instanceId: published.instanceId,
    });
    const infoAfter = JSON.parse(
      (await fleet.bounded(fleet.exit(fleet.cli(["daemon", "info", "--json"])), "daemon info"))
        .stdout,
    );
    expect(infoAfter).toMatchObject({
      status: "running",
      daemon: { pid: published.pid, instanceId: published.instanceId },
    });
    events.close();
  }, 60_000);
});
