// Real isolated name-only Home session creation. No GUI or personal tmux server access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";

const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");

// Save no inherited server/development selectors: every resource below is fixture-owned.
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-create",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_HOME_SOURCE",
});
let daemon, browser;
let latest,
  buffer = "",
  stderr = "";
let fatal;
const failures = [];
const checkFatal = () => {
  if (fatal) throw fatal;
};
const until = async (predicate) => {
  const deadline = Date.now() + 20000;
  while (true) {
    checkFatal();
    const ready = predicate();
    checkFatal();
    if (ready) return;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Home browser exited");
    assert.ok(Date.now() < deadline, "Home fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-create-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((server) => server.state === "online");
  assert.ok(server);
  const config = fleet.root + "/home-host.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  // Test-only observer copies the authoritative creation identity, never credentials.
  const receiptPath = fleet.root + "/creation-receipt.json";
  const observer =
    "data:text/javascript," +
    encodeURIComponent(`
    import { writeFile } from 'node:fs/promises';
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (new URL(typeof args[0] === 'string' ? args[0] : args[0].url ?? args[0]).pathname.endsWith('/sessions/create') && response.ok) {
        const { liveSessionId, operationId } = await response.clone().json();
        await writeFile(${JSON.stringify(receiptPath)}, JSON.stringify({liveSessionId, operationId}), {mode: 0o600});
      }
      return response;
    };
  `);
  browser = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    [
      ...(app ? [] : ["--import", "tsx"]),
      "--import",
      observer,
      app
        ? join(app, "Contents/Resources/bridge/browser.bundle.mjs")
        : resolve("apps/tmux-gpui/bridge/browser.ts"),
      config,
    ],
    {
      env: { ...process.env, ...fleet.environment },
      stdio: ["pipe", "pipe", "pipe"],
      ...(app ? { cwd: fleet.root } : {}),
    },
  );
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.on("data", (data) => {
    if (fatal) return;
    try {
      assert.ok(Buffer.byteLength(stderr) + data.length <= 65536, "stderr limit");
      stderr += data;
    } catch (error) {
      fatal ??= error;
    }
  });
  browser.stdout.on("data", (data) => {
    if (fatal) return;
    try {
      assert.ok(
        Buffer.byteLength(buffer) + data.length <= 8 * 1024 * 1024,
        "publication buffer limit",
      );
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    } catch (error) {
      fatal ??= error;
    }
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(() => latest?.surface === "home" && latest.home.phase === "live");
  assert.equal(latest.sessions.length, 1);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.selectedSession, null);
  const original = latest.sessions[0];
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  const revision = latest.createSession.revision;
  const name = "GPUI Created Session";
  send({ type: "create-session", request: 0, name });
  await until(
    () => latest.createSession.revision > revision && latest.createSession.phase !== "pending",
  );
  assert.equal(latest.createSession.phase, "idle", JSON.stringify(latest.createSession));
  assert.equal(latest.sessions.length, 2);
  const created = latest.sessions.filter((item) => item.id !== original.id);
  assert.equal(created.length, 1);
  assert.match(created[0].label, /^gpui-created-session-[0-9a-f]{20}$/);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(created[0].id, receipt.liveSessionId);
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/);
  assert.ok(latest.sessions.some((item) => item.id === original.id));
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  assert.equal(latest.surface, "home");
  assert.equal(latest.selectedSession, null);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(stderr, "");
  checkFatal();
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    async () => {
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        const done = once(browser, "close");
        browser.kill("SIGTERM");
        const timer = setTimeout(() => browser.kill("SIGKILL"), 2000);
        try {
          await done;
        } finally {
          clearTimeout(timer);
        }
      }
    },
    async () => {
      if (daemon) await daemon.stop();
    },
    async () => {
      await fleet.dispose();
    },
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Session creation smoke failed");
console.log(
  JSON.stringify({
    passed: true,
    runtime: app ? "packaged-node-and-browser" : "source",
    receiptIdentityCorrelated: true,
    createdExactlyOne: true,
    preexistingSourceUnchanged: true,
    stayedHomeWithoutInputAuthority: true,
    nativeUi: "not exercised",
  }),
);
