/** Exercise provenance through the installed CLI, never through source imports. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonProvenanceReport } from "../daemon-provenance.ts";
import {
  assertUnifiedSocket,
  createPrivateFleet,
  tmuxAvailable,
  type PrivateFleet,
} from "./installed-recovery-fixture.ts";

let fleet: PrivateFleet | undefined;
afterEach(async () => {
  if (!fleet) return;
  const current = fleet;
  fleet = undefined;
  await current.cleanup();
  expect(existsSync(current.root)).toBe(false);
  expect(current.tmuxStatus("list-sessions")).toBe(1);
  current.evidence({
    scenario: "provenance",
    step: "cleanup",
    rootRemoved: true,
    serverStopped: true,
  });
}, 30000);

describe.skipIf(!tmuxAvailable)("installed daemon provenance", () => {
  it("reports the current process across replacement, preserves historical logs and omits credentials", async () => {
    const f = (fleet = await createPrivateFleet("provenance"));
    const pane = f.tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      "provenance",
      "exec sleep 300",
    );
    assertUnifiedSocket(f);
    const panePid = f.tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
    mkdirSync(join(f.stateDir, "logs"));
    const historical = join(f.stateDir, "logs", "headless.out");
    const secret = "private-provenance-sentinel-do-not-report";
    const bytes = `Canonical daemon ready: http://127.0.0.1:1 (pid 2147483647)\nBearer ${secret}\n`;
    writeFileSync(historical, bytes);
    const report = async (token: string | undefined) => {
      const result = await f.bounded(
        f.exit(f.cli(["daemon", "info", "--json"])),
        "provenance report",
      );
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("authToken");
      expect(result.stdout).not.toContain(secret);
      if (token) expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(secret);
      if (token) expect(result.stderr).not.toContain(token);
      return JSON.parse(result.stdout) as DaemonProvenanceReport;
    };
    const first = await f.startDaemon();
    const initial = await report(first.info.authToken);
    expect(initial).toMatchObject({
      status: "running",
      daemon: {
        instanceId: first.info.instanceId,
        pid: first.child.pid,
        productVersion: first.info.productVersion,
        launcher: "headless",
        provenanceRecorded: true,
      },
    });
    expect(["pipe", "socket"]).toContain(initial.daemon?.logs.stdout?.kind);
    expect(initial.logFiles.find((file) => file.path === historical)).toMatchObject({
      status: "historical",
      pid: 2147483647,
      pidLiveness: "dead",
    });
    first.child.kill("SIGTERM");
    await f.bounded(f.exit(first.child), "first daemon exit");
    const second = await f.startDaemon();
    const replacement = await report(second.info.authToken);
    expect(second.info.instanceId).not.toBe(first.info.instanceId);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(replacement.daemon).toMatchObject({
      instanceId: second.info.instanceId,
      pid: second.child.pid,
      liveness: "alive",
    });
    expect(replacement.logFiles.find((file) => file.path === historical)?.status).toBe(
      "historical",
    );
    expect(readFileSync(historical, "utf8")).toBe(bytes);
    expect(f.tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(panePid);
    f.evidence({
      scenario: "provenance",
      step: "replacement",
      firstInstanceId: first.info.instanceId,
      secondInstanceId: second.info.instanceId,
      version: second.info.productVersion,
      supervisor: replacement.daemon?.supervisor,
      streamKind: replacement.daemon?.logs.stdout?.kind,
      historicalPreserved: true,
      credentialsOmitted: true,
      panePreserved: true,
    });
  }, 60000);
});
