/** Public installed-daemon proof of bounded stock-hook retention and recovery. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TmuxServerSessionsResourceSchemaZ,
  TmuxServersResourceSchemaZ,
  type InteractionJournalEntry,
} from "@tmux-ide/contracts";
import {
  subscribeTmuxServerInteractions,
  type TmuxInteractionSubscription,
} from "@tmux-ide/daemon-client/tmux-server-interaction-events";
import {
  assertUnifiedSocket,
  createPrivateFleet,
  tmuxAvailable,
  type PrivateFleet,
} from "./installed-recovery-fixture.ts";
let fleet: PrivateFleet | undefined;
let stream: TmuxInteractionSubscription | undefined;
afterEach(async () => {
  stream?.close();
  await stream?.done.catch(() => undefined);
  stream = undefined;
  if (!fleet) return;
  const f = fleet;
  fleet = undefined;
  await f.cleanup();
  expect(existsSync(f.root)).toBe(false);
  expect(f.tmuxStatus("list-sessions")).toBe(1);
  f.evidence({
    scenario: "observer-overflow",
    step: "cleanup",
    rootRemoved: true,
    serverStopped: true,
  });
}, 30000);
describe.skipIf(!tmuxAvailable)("installed stock observer overflow", () => {
  it("publishes a gap after a delayed-consumer burst and resumes observed-only receipts", async () => {
    const f = (fleet = await createPrivateFleet("overflow"));
    const pane = f.tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      "overflow",
      "exec sleep 300",
    );
    const recoveryPane = f.tmux(
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "overflow",
      "exec sleep 300",
    );
    f.tmux("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.overflow");
    f.tmux("set-option", "-p", "-t", recoveryPane, "@tmux_ide_pane_id", "pane.recovery");
    assertUnifiedSocket(f);
    const panePid = f.tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
    const adoption = await f.bounded(
      f.exit(f.cli(["adopt", "overflow", "--json"])),
      "adopt overflow session",
    );
    expect(adoption.code).toBe(0);
    const daemon = await f.startDaemon();
    const resource = TmuxServersResourceSchemaZ.parse(
      await f.fetchJson(daemon.info, "/api/v1/tmux-servers"),
    );
    const online = resource.servers.filter((s) => s.state === "online");
    expect(online).toHaveLength(1);
    const server = online[0]!;
    if (server.state !== "online") throw Error("Missing private server");
    const scoped = `/api/v1/tmux-servers/${server.serverId}/${server.generation}`;
    const sessions = TmuxServerSessionsResourceSchemaZ.parse(
      await f.fetchJson(daemon.info, `${scoped}/sessions`),
    );
    const workspace = sessions.sessions.find(
      (row) => row.sessionName === "overflow",
    )?.workspaceName;
    expect(workspace).toBeTruthy();
    const inventory = await f.fetchJson(
      daemon.info,
      `${scoped}/inventory/${encodeURIComponent(workspace!)}`,
    );
    expect(inventory).toHaveProperty("resource");
    const receipts: InteractionJournalEntry[] = [];
    const gapReasons: string[] = [];
    stream = subscribeTmuxServerInteractions({
      baseUrl: `http://127.0.0.1:${daemon.info.port}`,
      ownerToken: daemon.info.authToken!,
      server: { serverId: server.serverId, generation: server.generation },
      onStatus: (status) => {
        if (status.lastGap) gapReasons.push(status.lastGap.reason);
      },
      onBatch: (batch) => {
        receipts.push(...batch.receipts);
      },
    });
    await f.bounded(stream.ready, "stock observer ready");
    await f.until(
      () => (stream?.getObservationStatus()?.method === "stock-hooks" ? true : null),
      "stock hook coverage",
    );
    const option = `@tmux-ide-interaction-v3-${daemon.info.instanceId}`;
    const script = join(f.root, "burst.tmux");
    writeFileSync(
      script,
      Array.from({ length: 1000 }, () => `send-keys -t ${pane} -l x`).join("\n"),
    );
    let retainedBytes: number;
    let retainedMetadata: string;
    expect(daemon.child.kill("SIGSTOP")).toBe(true);
    try {
      f.tmux("source-file", script);
      const retained = await f.until(() => {
        const value = f.tmux("show-options", "-gqv", option);
        return value.includes("|gap|") ? value : null;
      }, "bounded burst gap");
      retainedBytes = Buffer.byteLength(retained);
      retainedMetadata = retained.slice(-600);
      expect(retainedBytes).toBeLessThanOrEqual(9269);
    } finally {
      daemon.child.kill("SIGCONT");
    }
    try {
      await f.until(
        () => (gapReasons.includes("retention-overflow") ? true : null),
        "public overflow notification",
      );
    } catch (error) {
      throw new Error(
        JSON.stringify({
          gapReasons,
          receipts: receipts.length,
          retainedBytes,
          retainedMetadata,
          paneMetadata: f.tmux(
            "display-message",
            "-p",
            "-t",
            pane,
            "#{session_id}|#{pane_id}|#{@tmux_ide_pane_id}",
          ),
          current: stream.getObservationStatus(),
        }),
        { cause: error },
      );
    }
    await f.until(() => (receipts.length ? true : null), "retained receipts");
    expect(receipts.length).toBeLessThan(1000);
    const recoveryId = f.tmux("show-options", "-pqv", "-t", recoveryPane, "@tmux_ide_pane_id");
    expect(recoveryId).not.toBe("");
    const recovered = () =>
      receipts.some(
        (r) =>
          r.type === "interaction.receipt" &&
          r.target.kind === "pane" &&
          r.target.semanticPaneId === recoveryId &&
          r.operationKind === "workspace.pane.send",
      );
    expect(recovered()).toBe(false);
    f.tmux("send-keys", "-t", recoveryPane, "-l", "z");
    await f.until(() => (recovered() ? true : null), "receipt after overflow");
    expect(
      receipts.every(
        (r) =>
          r.type === "interaction.receipt" && r.origin === "external" && r.phase === "observed",
      ),
    ).toBe(true);
    expect(f.tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(panePid);
    f.evidence({
      scenario: "observer-overflow",
      step: "recovered",
      daemonInstanceId: daemon.info.instanceId,
      daemonPid: daemon.child.pid,
      retainedBytes,
      gap: stream.getObservationStatus()?.lastGap?.reason,
      observedReceipts: receipts.length,
      panePidPreserved: true,
    });
  }, 60000);
});
