// Private real-daemon Home load-more qualification; no GUI or generated CLI build.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "../fixture-child.mjs";

const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli), "Provide absolute TMUX_GPUI_TEST_CLI");
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 33,
  windowsPerSession: 1,
  slug: "home-recovery",
});
const env = { ...process.env, ...fleet.environment };
const tmux = (...args) =>
  execFileSync(env.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
let daemon,
  browser,
  latest,
  fatal,
  closing = false;
let buffer = "",
  stderrBytes = 0,
  publications = 0;
const failures = [];
const until = async (predicate) => {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (fatal) throw fatal;
    if (await predicate()) {
      if (fatal) throw fatal;
      return;
    }
    assert.ok(
      Date.now() < deadline,
      "Home recovery fixture deadline: " +
        JSON.stringify({
          request: latest?.request,
          status: latest?.status,
          connection: latest?.connection,
          fleet: latest?.fleet?.groups?.map((g) => ({
            state: g.state,
            sessions: g.sessions.length,
            conflict: g.conflict,
          })),
          surface: latest?.surface,
          phase: latest?.homeAgents?.phase,
          observed: latest?.homeAgents?.observedSessions,
          total: latest?.homeAgents?.totalSessions,
          truncated: latest?.homeAgents?.truncatedSessions,
          rows: latest?.homeAgents?.rows?.length,
          recovery: latest?.homeAgentRecovery,
          publications,
        }),
    );
    await delay(20);
  }
};
const ownChild = (child) => {
  child.on("error", (error) => {
    fatal ??= error;
  });
  child.on("exit", () => {
    if (!closing) fatal ??= new Error("Fixture child exited unexpectedly");
  });
  return child;
};
try {
  assert.equal(fleet.initialPanes.length, 33);
  for (const { paneId } of fleet.initialPanes) {
    tmux("set-option", "-p", "-t", paneId, "@agent_display_name", "Recovery agent");
    tmux(
      "set-option",
      "-p",
      "-t",
      paneId,
      "@agent_state",
      `blocked:${Math.floor(Date.now() / 1000)}`,
    );
    assert.equal(tmux("display-message", "-p", "-t", paneId, "#{@tmux_ide_pane_id}").trim(), "");
  }
  const source = () =>
    tmux(
      "list-panes",
      "-a",
      "-F",
      "#{session_id}|#{session_name}|#{window_id}|#{pane_id}|#{pane_birth_id}|#{pane_pid}|#{pane_width}|#{pane_height}|#{@tmux_ide_pane_id}",
    )
      .split("\n")
      .filter(Boolean)
      .sort();
  const before = source();
  daemon = ownChild(spawn(process.execPath, [cli, "--headless"], { env, stdio: "ignore" }));
  await until(async () => {
    try {
      return (
        JSON.parse(await readFile(fleet.daemonInfoDir + "/daemon.json", "utf8")).pid === daemon.pid
      );
    } catch {
      return false;
    }
  });
  browser = ownChild(
    spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../browser.ts", import.meta.url)),
        "--local",
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  for (const stream of [browser.stdin, browser.stdout, browser.stderr])
    stream.on("error", (error) => {
      fatal ??= error;
    });
  browser.stderr.on("data", (data) => {
    stderrBytes += data.length;
    if (stderrBytes > 65536) fatal ??= new Error("Diagnostics overflow");
  });
  browser.stdout.setEncoding("utf8");
  browser.stdout.on("data", (data) => {
    try {
      buffer += data;
      assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024, "Publication buffer overflow");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        assert.ok(++publications <= 10000, "Publication count overflow");
      }
    } catch (error) {
      fatal ??= error;
    }
  });
  const send = (value) => browser.stdin.write(JSON.stringify(value) + "\n");
  // Establish foreground intent before awaiting the resident Home observation.
  send({ type: "presence", active: true, revision: 1 });
  await until(
    () =>
      latest?.presenceRevision === 1 &&
      latest.homeAgents?.observedSessions === 32 &&
      latest.homeAgents.truncatedSessions === 1 &&
      latest.homeAgentRecovery?.canLoadMore,
  );
  const connection = latest.connection;
  const request = latest.request;
  send({ type: "attention-observe", request, scope: 1, active: true });
  await until(
    () =>
      latest?.attentionAgents?.scope === 1 &&
      latest.attentionAgents.rows.length === 32 &&
      latest.homeAgentRecovery?.canLoadMore,
  );
  assert.equal(latest.homeAgentRecovery.revision, latest.homeAgents.revision);
  send({
    type: "home-agent-recovery",
    request,
    rosterRevision: latest.homeAgents.revision,
    action: "load-more",
  });
  await until(
    () =>
      latest?.homeAgents?.observedSessions === 33 &&
      latest.homeAgents.truncatedSessions === 0 &&
      latest.attentionAgents?.scope === 1 &&
      latest.attentionAgents.rows.length === 33,
  );
  assert.equal(latest.connection, connection);
  assert.equal(latest.request, request);
  assert.equal(latest.surface, "home");
  assert.equal(latest.selectedSession, null);
  assert.equal(latest.selectedPane, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.homeAgents.rows.length, 33);
  assert.equal(latest.homeAgentRecovery.canLoadMore, false);
  assert.equal(latest.homeAgentRecovery.revision, latest.homeAgents.revision);
  assert.deepEqual(
    source(),
    before,
    "Observation recovery must preserve native source identity, geometry and stamps",
  );
} catch (error) {
  failures.push(error);
} finally {
  closing = true;
  for (const cleanup of [
    () => browser && stopFixtureChild(browser),
    () => daemon && stopFixtureChild(daemon),
    () => fleet.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Home recovery fixture failed");
console.log(
  JSON.stringify({
    passed: true,
    observedBefore: 32,
    observedAfter: 33,
    sameConnection: true,
    attentionScopeRetained: true,
    sourceIdentityGeometryAndStampsUnchanged: true,
    noPromotion: true,
    retryFailureRecoveryTested: false,
    ownedCleanup: true,
    nativeUi: false,
  }),
);
