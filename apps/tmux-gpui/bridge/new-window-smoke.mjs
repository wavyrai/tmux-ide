import { newWindowDiagnostic } from "./new-window-diagnostic.mjs";
// Real scoped terminal-window creation in a private session; no GUI or CLI build.
// Only the receipt-created pane in a distinct canonical window may become selected.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { execFileSync, spawn } from "node:child_process";
import { access, stat, writeFile, readFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";

import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli), "Explicit private TMUX_GPUI_TEST_CLI required");
const harness = process.env.TMUX_GPUI_TEST_AGENT;
assert.ok(
  harness === undefined || ["claude", "codex"].includes(harness),
  "TMUX_GPUI_TEST_AGENT must be claude or codex",
);
const agentName = "Fixture agent ; literal";
const app = process.env.TMUX_GPUI_TEST_APP;
if (app !== undefined) {
  assert.ok(isAbsolute(app), "TMUX_GPUI_TEST_APP must be absolute");
  assert.ok((await stat(app)).isDirectory());
  for (const file of ["node", "bridge/browser.bundle.mjs"]) {
    const path = join(app, "Contents/Resources", file);
    assert.ok((await stat(path)).isFile());
    await access(path, file === "node" ? constants.X_OK : constants.R_OK);
  }
}
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    key.startsWith("CLAUDE") ||
    key.startsWith("CODEX") ||
    key.startsWith("ANTHROPIC") ||
    key.startsWith("OPENAI") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-new-window",
});
const fixtureEnvironment = { ...fleet.environment };
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fixtureEnvironment },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
let daemon, browser, latest, fatal, result;
let originalPane = null,
  observedCreatedPane = null;
let originalNativePaneIds = [];
let buffer = "",
  stderr = "";
const failures = [];
// Failure-only evidence: never emit terminal contents, connection config or raw errors.
function failureEvidence(error) {
  const id = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_.:%@$-]{1,512}$/.test(value) ? value : null;
  const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const statuses = [
    "Loading new terminal window",
    "Loading new agent window",
    "New window created; pane unavailable — refresh",
  ];
  let native = null;
  let nativeReadFailed = false;
  try {
    const output = execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      [
        "-S",
        fleet.socketPath,
        "list-panes",
        "-a",
        "-F",
        "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{@tmux_ide_pane_id}",
      ],
      {
        env: { ...process.env, ...fixtureEnvironment },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const rows = output.trim().split("\n");
    assert.ok(rows.length <= 512, "Bounded native failure inventory");
    native = rows.map((row) => {
      const [session, window, pane, pid, semanticPane, extra] = row.split("|");
      assert.ok(
        extra === undefined &&
          /^\$\d+$/.test(session) &&
          /^@\d+$/.test(window) &&
          /^%\d+$/.test(pane) &&
          /^[1-9]\d*$/.test(pid),
      );
      return {
        session,
        window,
        pane,
        pid,
        semanticPane: id(semanticPane),
        existedBeforeAction: originalNativePaneIds.includes(pane),
      };
    });
  } catch {
    nativeReadFailed = true;
  }
  console.error(
    JSON.stringify({
      stage: "new-window-failure-evidence",
      errorClass: ["Error", "AssertionError", "TypeError", "RangeError"].includes(error?.name)
        ? error.name
        : "Other",
      errorCode: ["ERR_ASSERTION", "ETIMEDOUT", "ENOENT", "EPIPE"].includes(error?.code)
        ? error.code
        : null,
      browser: {
        request: integer(latest?.request),
        sequence: integer(latest?.sequence),
        presenceRevision: integer(latest?.presenceRevision),
        inputReady: latest?.inputReady === true,
        hasSnapshot: !!latest?.snapshot,
        selectedSession: id(latest?.selectedSession),
        selectedPane: id(latest?.selectedPane),
        originalPane,
        observedCreatedPane,
        status: statuses.includes(latest?.status) ? latest.status : "other",
        retainedPaneIds: Array.isArray(latest?.panes)
          ? latest.panes.slice(0, 512).map((pane) => id(pane.id))
          : [],
      },
      // The browser's public publication deliberately does not expose the helper receipt.
      receiptCreatedPaneAvailable: false,
      // Only retain our fixed diagnostic labels, never arbitrary helper stderr.
      refreshFailureStage: newWindowDiagnostic(stderr)?.refreshStage ?? null,
      refreshCatalogFailure: newWindowDiagnostic(stderr)?.catalog ?? null,
      observedCreatedPanePresent:
        observedCreatedPane && native
          ? native.some((pane) => pane.semanticPane === observedCreatedPane)
          : null,
      native,
      nativeReadFailed,
    }),
  );
}
async function until(predicate) {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (fatal) throw fatal;
    if (predicate()) {
      if (fatal) throw fatal;
      return;
    }
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Browser exited");
    assert.ok(
      Date.now() < deadline,
      `New-window deadline: ${JSON.stringify({ status: latest?.status, selectedPane: latest?.selectedPane, panes: latest?.panes, presence: latest?.presenceRevision, hasSnapshot: !!latest?.snapshot, inputReady: latest?.inputReady })}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  if (harness) {
    const bin = join(fleet.root, "inert-harnesses");
    await mkdir(bin, { mode: 0o700 });
    const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    for (const name of ["claude", "codex"]) {
      await writeFile(
        join(bin, name),
        '#!/bin/sh\ncase "$1" in --version|-v) printf \'' +
          name +
          " 1.0.0\\n'; exit 0;; esac\nprintf '%s\\n' '" +
          name +
          '\' "$@" >> ' +
          quote(join(fleet.root, "harness-invocations")) +
          "\nexec /bin/sh -i\n",
        { mode: 0o700, flag: "wx" },
      );
    }
    process.env.PATH = bin + ":" + process.env.PATH;
    fixtureEnvironment.PATH = process.env.PATH;
    run("set-option", "-g", "default-shell", "/bin/sh");
    run("set-environment", "-g", "PATH", process.env.PATH);
    for (const session of run("list-sessions", "-F", "#{session_id}").split("\n"))
      run("set-environment", "-t", session, "PATH", process.env.PATH);
  }
  daemon = spawn(process.execPath, [cli, "--headless"], {
    env: { ...process.env, ...fixtureEnvironment },
    stdio: "ignore",
  });
  daemon.on("error", (error) => {
    fatal ??= error;
  });
  let record;
  const deadline = Date.now() + 25000;
  while (!record) {
    if (fatal) throw fatal;
    assert.ok(Date.now() < deadline, "Daemon startup deadline");
    try {
      const value = JSON.parse(await readFile(fleet.daemonInfoDir + "/daemon.json", "utf8"));
      if (value.pid === daemon.pid) record = value;
    } catch {
      // Wait for the owned daemon atomic discovery record.
    }
    if (!record) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const options = {
    baseUrl: `http://127.0.0.1:${record.port}/`,
    ownerToken: record.authToken,
    hostClientId: "gpui-new-window",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = fleet.root + "/host.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  browser = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/browser.bundle.mjs"), config]
      : ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    {
      env: { ...process.env, ...fixtureEnvironment, ...(app ? { PATH: "/usr/bin:/bin" } : {}) },
      ...(app ? { cwd: fleet.root } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  browser.stdout.on("data", (chunk) => {
    try {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        assert.ok(end <= 8 * 1024 * 1024);
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      assert.ok(buffer.length <= 8 * 1024 * 1024);
    } catch (error) {
      fatal ??= error;
    }
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(() => latest?.sessions.length === 1);
  const session = latest.sessions[0].id;
  const sessionLabel = latest.sessions[0].label;
  assert.equal(latest.sessions[0].paneCount, 1);
  send({ type: "presence", active: true, revision: 1 });
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.sessionCatalogComplete);
  const original = latest.preferredPane;
  assert.ok(original);
  originalPane = original;
  send({ type: "pane", request: 2, id: original });
  await until(() => latest?.inputReady && latest.paneActions);
  const originalWindow = latest.panes.find((p) => p.id === original).windowId;
  const before = run("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}").split(
    "\n",
  );
  originalNativePaneIds = before.map((row) => row.split("|")[0]);
  const command = {
    type: "pane-action",
    request: 2,
    id: original,
    token: latest.paneActions.token,
    ...(harness ? { action: "new-agent", name: agentName, harness } : { action: "new-window" }),
  };
  if (harness) {
    send({ ...command, name: " invalid" });
    send({ ...command, harness: "sh" });
    send({ type: "presence", active: true, revision: 2 });
    await until(() => latest?.presenceRevision === 2 && latest.paneActions);
    assert.deepEqual(
      run("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}").split("\n"),
      before,
    );
    command.token = latest.paneActions.token;
  }
  send(command);
  send(command);
  await until(
    () =>
      latest?.request === 2 &&
      latest.inputReady &&
      latest.selectedPane !== original &&
      latest.paneActions,
  );
  const created = latest.selectedPane;
  observedCreatedPane = created;
  const selectedWindow = latest.panes.find((p) => p.id === created).windowId;
  const nativeRows = run("list-panes", "-a", "-F", "#{pane_id}|#{@tmux_ide_pane_id}").split("\n");
  const createdNative = nativeRows.filter((row) => row.split("|")[1] === created);
  assert.equal(createdNative.length, 1);
  const nativePane = createdNative[0].split("|")[0];
  if (harness) {
    assert.equal(run("display-message", "-p", "-t", nativePane, "#{@tmux_ide_harness}"), harness);
    assert.equal(run("display-message", "-p", "-t", nativePane, "#{@ide_name}"), agentName);
    assert.equal(run("display-message", "-p", "-t", nativePane, "#{@ide_type}"), "agent");
    assert.equal(run("display-message", "-p", "-t", nativePane, "#{@ide_role}"), "implementer");
    assert.equal(run("display-message", "-p", "-t", nativePane, "#{@tmux_ide_mission}"), "");
    await until(() => {
      try {
        return (
          execFileSync("/bin/cat", [join(fleet.root, "harness-invocations")], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).split("\n")[0] === harness
        );
      } catch {
        return false;
      }
    });
  }
  if (harness) {
    assert.equal(
      await readFile(join(fleet.root, "harness-invocations"), "utf8"),
      harness + "\n",
      "Exactly the inert harness executed once, with no name interpolated into argv",
    );
  }
  const marker = "GPUI_NEW_WINDOW_INPUT_OK";
  send({
    type: "input",
    request: 2,
    id: created,
    input: { kind: "text", data: "printf '\\n" + marker + "\\n'" },
  });
  send({ type: "input", request: 2, id: created, input: { kind: "key", data: "Enter" } });
  await until(() =>
    run("capture-pane", "-p", "-t", nativePane)
      .split("\n")
      .some((line) => line.trim() === marker),
  );
  for (const { paneId } of fleet.initialPanes)
    assert.equal(run("capture-pane", "-p", "-t", paneId).includes(marker), false);

  assert.notEqual(selectedWindow, originalWindow);
  assert.equal(latest.sessions.find((s) => s.id === session).paneCount, 2);
  assert.equal(run("list-windows", "-t", sessionLabel, "-F", "#{window_id}").split("\n").length, 2);
  const after = run("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}").split(
    "\n",
  );
  assert.equal(after.length, before.length + 1);
  for (const identity of before)
    assert.ok(after.includes(identity), "Original source identity preserved");
  send(command);
  send({ type: "presence", active: true, revision: 3 });
  await until(() => latest?.presenceRevision === 3);
  assert.equal(run("list-windows", "-t", sessionLabel, "-F", "#{window_id}").split("\n").length, 2);
  result = {
    passed: true,
    harness: harness ?? null,
    structuredAgentMetadata: !!harness,
    distinctCreatedWindowSelected: true,
    exactNewPaneInput: true,
    exactOneCreation: true,
    duplicateAndStaleRefused: true,
    sourceIdentityPreserved: true,
  };
} catch (error) {
  failures.push(error);
  failureEvidence(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(browser),
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
if (fatal) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "New-window fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
