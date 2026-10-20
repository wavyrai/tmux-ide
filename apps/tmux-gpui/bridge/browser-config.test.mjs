import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stopFixtureChild } from "./fixture-child.mjs";

function isolatedEnvironment(directory) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TMUX") &&
          ![
            "NODE_OPTIONS",
            "NODE_PATH",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "TMPDIR",
            "HOME",
          ].includes(key),
      ),
    ),
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    XDG_STATE_HOME: directory,
    XDG_CACHE_HOME: directory,
    TMPDIR: directory,
  };
}

// Observe startup failure directly; never include child output in failure diagnostics.
// This bounds process startup/import and first publication, not product latency.
function firstPublication(child, lines, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0,
      stderrBytes = 0;
    const finish = (error, line) => {
      clearTimeout(timer);
      lines.off("line", onLine);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      if (error) reject(error);
      else resolve(line);
    };
    const onLine = (line) =>
      Buffer.byteLength(line) > 65536
        ? finish(new Error("Browser startup output exceeded 64 KiB"))
        : finish(null, line);
    const onError = () => finish(new Error("Browser startup spawn failed"));
    const onClose = (code, signal) =>
      finish(
        new Error(
          `Browser closed before publication (exit=${code}, signal=${signal}, stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes})`,
        ),
      );
    const count = (stream, chunk) => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > 65536)
        finish(new Error("Browser startup output exceeded 64 KiB"));
    };
    const onStdout = (chunk) => count("stdout", chunk);
    const onStderr = (chunk) => count("stderr", chunk);
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Browser startup publication deadline (stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes}, exit=${child.exitCode})`,
          ),
        ),
      timeoutMs,
    );
    child.on("error", onError);
    child.on("close", onClose);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    lines.once("line", onLine);
  });
}

test("malformed private config stays recoverable without leaking its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpui-browser-config-"));
  let child, closed, lines;
  let stderr = "";
  try {
    const path = join(directory, "host.json");
    await writeFile(path, '{"ownerToken":"PRIVATE_TEST_SENTINEL", broken', { mode: 0o600 });
    child = spawn(process.execPath, ["--import", "tsx", "apps/tmux-gpui/bridge/browser.ts", path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedEnvironment(directory),
    });
    closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve([code, signal])),
    );
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) < 65536)
        stderr += chunk.toString().slice(0, 65536 - Buffer.byteLength(stderr));
    });
    lines = createInterface({ input: child.stdout });
    const line = await firstPublication(child, lines);
    const event = JSON.parse(line);
    // These real-producer fixtures are also decoded by Rust's strict Reader tests.
    const wireFixture = JSON.parse(
      await readFile(new URL("../fixtures/browser-initial.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        ...Object.keys(wireFixture),
        "selectedServer",
        "attentionAgents",
        "attentionSelectionRejected",
        "attentionSupported",
        "paletteSupported",
        "paletteAgents",
        "paletteSelectionRejected",
        "homeAgentRecovery",
        "homeAgentFilter",
        "historyOffset",
        "sessionTabs",
        "sessionTabResult",
        "workspaceFleetAgents",
        "workspaceFleetAgentRejected",
        "sessionHistory",
        "sessionHistoryRejected",
        "diagnostics",
        "localSetup",
        "localSessionCreate",
        "retainedPreview",
        "selectionIdentity",
      ].sort(),
    );
    assert.equal(event.homeAgentRecovery, null);
    assert.equal(event.homeAgentFilter, null);
    assert.equal(event.historyOffset, 0);
    assert.equal(event.attentionSupported, true);
    assert.equal(event.attentionAgents, null);
    assert.equal(event.attentionSelectionRejected, null);
    assert.equal(child.exitCode, null);
    assert.equal(event.snapshot, null);
    assert.equal(event.inputReady, false);
    assert.match(event.status, /unavailable/);
    assert.ok(!line.includes("PRIVATE_TEST_SENTINEL"));
    assert.equal(event.machines, null);
    // Unsupported private-host history rejects before changing the committed request.
    const rejectedPublication = firstPublication(child, lines);
    const historyCommand = {
      type: "session-history",
      request: 1,
      fromRequest: 0,
      revision: 1,
      action: randomUUID(),
    };
    child.stdin.write(JSON.stringify(historyCommand) + "\n");
    const rejected = JSON.parse(await rejectedPublication);
    assert.equal(rejected.request, 0);
    assert.equal(rejected.sessionHistory, null);
    assert.deepEqual(rejected.sessionHistoryRejected, {
      request: 1,
      fromRequest: 0,
      revision: 1,
      action: historyCommand.action,
    });
    assert.equal(rejected.status, event.status);
    child.stdin.write(JSON.stringify({ ...historyCommand, request: 2, fromRequest: 99 }) + "\n");
    // Machine management remains local and usable even when terminal discovery fails.
    const registryPublication = firstPublication(child, lines);
    child.stdin.write(JSON.stringify({ type: "machines", operation: "read", request: 0 }) + "\n");
    const registryEvent = JSON.parse(await registryPublication);
    const registryFixture = JSON.parse(
      await readFile(new URL("../fixtures/browser-machines.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(
      Object.keys(registryEvent).sort(),
      [
        ...Object.keys(registryFixture),
        "selectedServer",
        "attentionAgents",
        "attentionSelectionRejected",
        "attentionSupported",
        "paletteSupported",
        "paletteAgents",
        "paletteSelectionRejected",
        "homeAgentRecovery",
        "homeAgentFilter",
        "historyOffset",
        "sessionTabs",
        "sessionTabResult",
        "workspaceFleetAgents",
        "workspaceFleetAgentRejected",
        "sessionHistory",
        "sessionHistoryRejected",
        "diagnostics",
        "localSetup",
        "localSessionCreate",
        "retainedPreview",
        "selectionIdentity",
      ].sort(),
    );
    assert.equal(registryEvent.homeAgentRecovery, null);
    assert.equal(registryEvent.homeAgentFilter, null);
    assert.equal(registryEvent.historyOffset, 0);
    assert.equal(registryEvent.sessionHistoryRejected.fromRequest, registryEvent.request);
    assert.equal(registryEvent.sessionHistoryRejected.request, 1);
    assert.equal(registryEvent.attentionSupported, true);
    assert.equal(registryEvent.attentionAgents, null);
    assert.equal(registryEvent.attentionSelectionRejected, null);
    assert.deepEqual(
      Object.keys(registryEvent.machines).sort(),
      Object.keys(registryFixture.machines).sort(),
    );
    assert.equal(registryEvent.machines.available, true);
    assert.deepEqual(registryEvent.machines.machines, []);
    assert.equal(registryEvent.inputReady, false);
    child.stdin.end();
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Browser did not stop after EOF")), 5000);
        closed.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.deepEqual(result, [0, null]);
    assert.match(stderr, /Could not read private native-browser host configuration/);
    assert.ok(!stderr.includes("PRIVATE_TEST_SENTINEL"));
  } finally {
    lines?.close();
    await stopFixtureChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup failure is reported at child exit without exposing diagnostic contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpui-browser-startup-"));
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('PRIVATE_TEST_SENTINEL');process.exit(7)"],
    { stdio: ["ignore", "pipe", "pipe"], env: isolatedEnvironment(directory) },
  );
  const lines = createInterface({ input: child.stdout });
  try {
    await assert.rejects(firstPublication(child, lines), (error) => {
      assert.match(error.message, /closed before publication \(exit=7/);
      assert.ok(!error.message.includes("PRIVATE_TEST_SENTINEL"));
      return true;
    });
  } finally {
    lines.close();
    await stopFixtureChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "remote browser refresh reuses transport and transport loss clears the published route",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gpui-remote-browser-"));
    let child, lines, fatal, wake;
    const fail = (message) => {
      fatal ??= new Error(message);
      wake?.();
    };
    try {
      const { DAEMON_WIRE_PROTOCOL_VERSION } =
        await import("../../../packages/contracts/src/index.ts");
      const daemon = {
        environmentId: randomUUID(),
        pid: 1234,
        port: 4000,
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        productVersion: "2.9.5",
        instanceId: randomUUID(),
        startedAt: new Date().toISOString(),
        bindHostname: "127.0.0.1",
        authToken: "PRIVATE_TEST_SENTINEL",
      };
      const scope = {
        serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
        generation: randomUUID(),
      };
      await writeFile(join(directory, "fixture.json"), JSON.stringify({ daemon, scope }), {
        mode: 0o600,
      });
      const fixture = fileURLToPath(new URL("./remote-browser-fixture.cjs", import.meta.url));
      await writeFile(
        join(directory, "ssh"),
        `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`,
        { mode: 0o700 },
      );
      const config = join(directory, "host.json");
      await writeFile(config, JSON.stringify({ sshTarget: "fixture-only" }), { mode: 0o600 });
      child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/tmux-gpui/bridge/browser.ts", config],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...isolatedEnvironment(directory),
            PATH: `${directory}:${dirname(process.execPath)}`,
            GPUI_TEST_REMOTE_DIRECTORY: directory,
            TMUX_IDE_REGISTRY_DIR: directory,
          },
        },
      );
      const closed = new Promise((resolve) =>
        child.once("close", (code, signal) => resolve([code, signal])),
      );
      child.on("error", () => fail("Remote browser spawn failed"));
      child.stdin.on("error", () => fail("Remote browser input failed"));
      let outputBytes = 0;
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("error", () => fail("Remote browser output failed"));
        stream.on("data", (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes > 262144) {
            fail("Remote browser output exceeded fixture limit");
            child.kill("SIGTERM");
          }
        });
      }
      lines = createInterface({ input: child.stdout });
      const events = [];
      lines.on("line", (line) => {
        if (fatal) return;
        if (line.includes(daemon.authToken)) return fail("Private credential escaped publication");
        if (events.length >= 128) return fail("Too many fixture publications");
        try {
          events.push(JSON.parse(line));
        } catch {
          return fail("Invalid fixture publication");
        }
        wake?.();
      });
      async function until(predicate) {
        let timer;
        try {
          return await Promise.race([
            (async () => {
              for (;;) {
                if (fatal) throw fatal;
                while (events.length) {
                  const event = events.shift();
                  if (predicate(event)) return event;
                }
                await new Promise((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
              }
            })(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Expected remote publication missing")),
                15000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await until((event) => event.home.phase === "live" && event.request === 0);
      child.stdin.write(JSON.stringify({ type: "refresh", request: 1 }) + "\n");
      await until((event) => event.home.phase === "live" && event.request === 1);
      assert.equal((await readFile(join(directory, "transport.log"), "utf8")).trim(), "opened");
      await writeFile(join(directory, "disconnect"), "");
      const event = await until((event) => event.home.phase === "unavailable");
      assert.equal(event.home.phase, "unavailable");
      assert.equal(event.inputReady, false);
      assert.equal(event.selectedSession, null);
      assert.equal(event.selectedPane, null);
      assert.deepEqual(event.sessions, []);
      assert.match(event.status, /Machine connection changed/);
      // A stalled handshake followed by Home/Refresh must not block Local cancellation.
      child.stdin.write(
        JSON.stringify({ type: "machine", request: 2, sshTarget: "slow-fixture" }) + "\n",
      );
      let opened = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await readFile(join(directory, "slow-open"));
          opened = true;
          break;
        } catch {
          await delay(10);
        }
      }
      assert.ok(opened, "Owned slow SSH fixture did not start");
      const cancelStarted = Date.now();
      for (const command of [
        { type: "refresh", request: 3 },
        { type: "home", request: 4 },
        { type: "machine", request: 5, sshTarget: null },
      ])
        child.stdin.write(JSON.stringify(command) + "\n");
      await until((event) => event.request === 5 && event.home.phase === "unavailable");
      assert.ok(Date.now() - cancelStarted < 3000, "Local cancellation waited for SSH timeout");
      await rm(join(directory, "disconnect"));
      const profile = {
        id: randomUUID(),
        label: "Saved fixture",
        sshTarget: "fixture-only",
        expectedEnvironmentId: daemon.environmentId,
        enabled: true,
      };
      const saveFixture = (machine) =>
        writeFile(
          join(directory, "machines.json"),
          JSON.stringify({ version: 1, machines: [machine] }),
          { mode: 0o600 },
        );
      await saveFixture(profile);
      const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
      send({ type: "machines", operation: "read", request: 5 });
      let registry = (
        await until((event) => event.machines?.available && event.machines.machines.length === 1)
      ).machines;
      send({ type: "machine-profile", request: 6, id: profile.id, revision: registry.revision });
      await until((event) => event.request === 6 && event.home.phase === "live");
      const traceBeforeRename = await readFile(join(directory, "transport.log"), "utf8");
      await saveFixture({ ...profile, label: "Renamed" });
      registry = (await until((event) => event.machines?.machines[0]?.label === "Renamed"))
        .machines;
      assert.equal(await readFile(join(directory, "transport.log"), "utf8"), traceBeforeRename);
      await saveFixture({ ...profile, sshTarget: "slow-fixture" });
      const revoked = await until((event) => /Saved machine changed/.test(event.status));
      assert.equal(revoked.inputReady, false);
      assert.deepEqual(revoked.sessions, []);
      registry = revoked.machines;
      send({ type: "refresh", request: 7 });
      await until((event) => event.request === 7 && event.home.phase === "unavailable");
      // Refresh must not silently fall back to the original private host route.
      assert.equal(
        (await readFile(join(directory, "transport.log"), "utf8")).split("opened").length,
        traceBeforeRename.split("opened").length,
      );
      await rm(join(directory, "slow-open"));
      send({ type: "machine-profile", request: 8, id: profile.id, revision: registry.revision });
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await readFile(join(directory, "slow-open"));
          break;
        } catch {
          await delay(10);
        }
      }
      await readFile(join(directory, "slow-open"));
      await saveFixture({ ...profile, sshTarget: "slow-fixture", enabled: false });
      await until((event) => event.request === 8 && /Saved machine changed/.test(event.status));
      send({ type: "refresh", request: 9 });
      await until((event) => event.request === 9 && event.home.phase === "unavailable");
      send({ type: "machine", request: 10, sshTarget: null });
      await until((event) => event.request === 10 && event.home.phase === "unavailable");
      const transportBeforeRefusal = await readFile(join(directory, "transport.log"), "utf8");
      send({ type: "machine-profile", request: 11, id: profile.id, revision: 0 });
      const refused = await until(
        (event) => event.request === 11 && event.home.phase === "unavailable",
      );
      assert.equal(refused.inputReady, false);
      assert.equal(refused.selectedSession, null);
      assert.equal(
        await readFile(join(directory, "transport.log"), "utf8"),
        transportBeforeRefusal,
      );
      // Connect by alias uses the existing saved UUID/pin; it never creates an unpinned duplicate.
      await saveFixture(profile);
      send({ type: "machine", request: 12, sshTarget: "fixture-only" });
      const added = await until((event) => event.request === 12 && event.home.phase === "live");
      assert.equal(added.machines.machines[0].id, profile.id);
      assert.equal(added.machines.machines[0].expectedEnvironmentId, daemon.environmentId);
      assert.equal(added.machines.message, null);
      // Missing local persistence must stay explicit even when remote discovery succeeds.
      await writeFile(
        join(directory, "machines.json"),
        JSON.stringify({ version: 1, machines: [] }),
      );
      await until((event) => event.request === 12 && /Saved machine changed/.test(event.status));
      send({ type: "machine", request: 13, sshTarget: "fixture-only" });
      const temporary = await until((event) => event.request === 13 && event.home.phase === "live");
      assert.match(temporary.status, /not saved locally/);
      assert.equal(temporary.machines.machines.length, 0);
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        assert.deepEqual(await closed, [0, null]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      lines?.close();
      try {
        await stopFixtureChild(child);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (fatal) throw fatal;
  },
);
