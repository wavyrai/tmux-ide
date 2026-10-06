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
  it("keeps serving and retaining logs when stdout and its fallback both fail asynchronously", async () => {
    const f = (fleet = await createPrivateFleet("log-failure"));
    f.tmux("-f", "/dev/null", "new-session", "-d", "-s", "log-failure", "exec sleep 300");
    assertUnifiedSocket(f);
    const preload = join(f.root, "fail-log-streams.mjs");
    const receipt = join(f.root, "failure-receipt.json");
    const secret = "private-error-credential-sentinel";
    writeFileSync(
      preload,
      `
import { writeFileSync } from "node:fs";
const evidence = { stdoutFailed: false, stderrFailed: false, warnings: 0, leaked: false };
for (const [name, code] of [["stdout", "ENOSPC"], ["stderr", "EPIPE"]]) {
  const original = process[name].write.bind(process[name]);
  process[name].write = (chunk, ...args) => {
    const text = String(chunk);
    if (name === "stdout" ? !text.includes('"component"') : !text.includes("[log.ts]")) return original(chunk, ...args);
    if (text.includes("[log.ts]")) {
      evidence.warnings++;
      evidence.leaked ||= text.includes(${JSON.stringify(secret)});
    }
    const key = name + "Failed";
    if (!evidence[key]) {
      evidence[key] = true;
      queueMicrotask(() => process[name].emit("error", Object.assign(
        new Error(code + " injected failure Bearer " + ${JSON.stringify(secret)}), { code })));
    }
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(evidence));
    return false;
  };
}
`,
    );
    f.env.NODE_OPTIONS = `--import=${preload}`;
    let daemon;
    try {
      daemon = await f.startDaemon();
    } finally {
      delete f.env.NODE_OPTIONS;
    }
    const challenge = (await f.fetchJson(daemon.info, "/api/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ userId: "fixture" }),
    })) as { challengeId: string };
    const trigger = () =>
      f.fetchJson(daemon.info, "/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          publicKey: "unsupported-fixture-key AA==",
          signature: "AA==",
        }),
      });
    expect(await trigger()).toEqual({ error: "Invalid SSH key signature" });
    const injected = await f.until(() => {
      if (!existsSync(receipt)) return null;
      const value = JSON.parse(readFileSync(receipt, "utf8"));
      return value.stderrFailed ? value : null;
    }, "both injected stream failures");
    expect(injected).toEqual({
      stdoutFailed: true,
      stderrFailed: true,
      warnings: 1,
      leaked: false,
    });
    const result = await f.bounded(
      f.exit(f.cli(["daemon", "info", "--json"])),
      "post-failure provenance",
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "running",
      daemon: { instanceId: daemon.info.instanceId, pid: daemon.child.pid },
    });
    expect(await trigger()).toEqual({ error: "Invalid SSH key signature" });
    const entries = await f.logBackfill(daemon.info);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.instanceId === daemon.info.instanceId)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(daemon.child.exitCode).toBeNull();
    f.evidence({
      scenario: "provenance",
      step: "injected-stream-failures",
      stdoutError: "ENOSPC",
      fallbackError: "EPIPE",
      alive: true,
      ringRetained: true,
      warningRedacted: true,
    });
  }, 60000);
});
