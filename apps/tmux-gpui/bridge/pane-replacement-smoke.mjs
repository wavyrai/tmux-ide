// Same browser and daemon: remove a selected tmux pane, then explicitly select its replacement.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import {
  constants,
  openSync,
  readSync,
  writeSync,
  closeSync,
  mkdirSync,
  lstatSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
const app = process.env.TMUX_GPUI_TEST_APP;
const pipeDir = process.env.TMUX_GPUI_NATIVE_PIPE_DIR;
const observedFile = process.env.TMUX_GPUI_NATIVE_OBSERVED_FILE;
if (app && !isAbsolute(app)) throw new Error("App path must be absolute");
if (
  pipeDir &&
  (!isAbsolute(pipeDir) ||
    existsSync(pipeDir) ||
    !observedFile ||
    !isAbsolute(observedFile) ||
    existsSync(observedFile))
)
  throw new Error("Native pipe directory must be fresh and observation signal absolute/absent");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-pane-replacement",
});
let daemon, browser;
let pipeTimer, inputFd, outputFd;
let inputPath, outputPath;
let pipeError;
let awaitingObservation = false;
let publicationQueue = Buffer.alloc(0);
let nativeBuffer = Buffer.alloc(0);
const errors = [];
const observed = () =>
  !!observedFile &&
  existsSync(observedFile) &&
  lstatSync(observedFile).isFile() &&
  !lstatSync(observedFile).isSymbolicLink();
const stage = (message) => console.log(message);
let latest,
  buffer = "",
  stderr = "";
const until = async (predicate) => {
  const deadline = Date.now() + (pipeDir ? 180000 : 20000);
  while (true) {
    if (pipeError) throw pipeError;
    if (browser.exitCode !== null || browser.signalCode !== null)
      throw new Error("Browser exited instead of retaining recovery: " + stderr);
    if (Date.now() > deadline) throw new Error("Startup recovery deadline: " + stderr);
    if (predicate()) {
      if (pipeError) throw pipeError;
      return;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
};
try {
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-pane-replacement-test",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = fleet.root + "/host.json";
  const host = {
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope: { serverId: server.serverId, generation: server.generation },
  };
  await writeFile(config, JSON.stringify(host), { mode: 0o600 });
  browser = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/browser.bundle.mjs"), config]
      : ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    {
      env: { ...process.env, ...fleet.environment, ...(app ? { PATH: "/usr/bin:/bin" } : {}) },
      cwd: app ? fleet.root : process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  browser.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-16000);
  });
  browser.stdout.on("data", (b) => {
    if (pipeDir) {
      publicationQueue = Buffer.concat([publicationQueue, b]);
      if (publicationQueue.length > 16 * 1024 * 1024)
        pipeError = new Error("Native publication queue limit exceeded");
    }
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      latest = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  if (pipeDir) {
    mkdirSync(pipeDir, { mode: 0o700 });
    inputPath = join(pipeDir, "input.fifo");
    outputPath = join(pipeDir, "output.fifo");
    execFileSync("/usr/bin/mkfifo", ["-m", "600", inputPath, outputPath]);
    inputFd = openSync(inputPath, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    outputFd = openSync(outputPath, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    pipeTimer = setInterval(() => {
      try {
        if (publicationQueue.length) {
          try {
            const n = writeSync(inputFd, publicationQueue);
            publicationQueue = publicationQueue.subarray(n);
          } catch (error) {
            if (error.code !== "EAGAIN") throw error;
          }
        }
        if (browser.stdin.writableLength > 65536) return;
        const chunk = Buffer.alloc(8192);
        let n = 0;
        try {
          n = readSync(outputFd, chunk);
        } catch (error) {
          if (error.code !== "EAGAIN") throw error;
        }
        if (n) nativeBuffer = Buffer.concat([nativeBuffer, chunk.subarray(0, n)]);
        let end;
        while ((end = nativeBuffer.indexOf(10)) >= 0) {
          if (end > 8192) throw new Error("Native command limit exceeded");
          const line = nativeBuffer.subarray(0, end + 1);
          const command = JSON.parse(line.toString());
          if (
            awaitingObservation &&
            ["refresh", "home", "session", "pane"].includes(command.type) &&
            !observed()
          )
            throw new Error("Native navigation before unavailable observation signal");
          browser.stdin.write(line);
          nativeBuffer = nativeBuffer.subarray(end + 1);
        }
        if (nativeBuffer.length > 8192) throw new Error("Native partial command limit exceeded");
      } catch (error) {
        pipeError = error;
        clearInterval(pipeTimer);
      }
    }, 10);
    stage(`NATIVE_PIPE_READY ${pipeDir}`);
  }
  const send = (value) => browser.stdin.write(JSON.stringify(value) + "\n");
  await until(() => latest?.sessions.length === 1);
  const connection = latest.connection;
  let pane;
  if (pipeDir) {
    stage("Select the session and pane; type echo BEFORE_PANE_REPLACEMENT and Enter");
    await until(() => latest?.snapshot && latest.inputReady && latest.selectedPane);
    pane = latest.selectedPane;
  } else {
    send({ type: "session", request: 2, id: latest.sessions[0].id });
    await until(() => latest?.request === 2 && latest.panes.length > 0);
    pane = latest.panes[0].id;
    send({ type: "pane", request: 3, id: pane });
    await until(() => latest?.request === 3 && latest.snapshot && latest.inputReady);
  }
  const originalRequest = latest.request;
  const tmux = (...args) =>
    execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...fleet.environment },
    }).trim();
  const original = fleet.initialPanes[0].paneId;
  if (pipeDir)
    await until(() =>
      tmux("capture-pane", "-p", "-t", original)
        .split("\n")
        .some((line) => line.trim() === "BEFORE_PANE_REPLACEMENT"),
    );
  const replacement = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", original, "sh -i");
  assert.notEqual(replacement, original);
  awaitingObservation = !!pipeDir;
  tmux("kill-pane", "-t", original);
  await until(
    () =>
      latest?.request === originalRequest &&
      latest.status.includes("unavailable") &&
      !latest.snapshot,
  );
  assert.equal(latest.inputReady, false);
  send({
    type: "input",
    request: originalRequest,
    id: pane,
    input: { kind: "text", data: "STALE_DELETED_PANE" },
  });
  if (pipeDir) {
    stage(
      "PANE_REMOVED_UNAVAILABLE: capture native state, then create observation signal before Refresh",
    );
    await until(observed);
    awaitingObservation = false;
    stage("Refresh, select the session/new pane, then type echo AFTER_PANE_REPLACEMENT and Enter");
    await until(
      () =>
        latest?.request > originalRequest &&
        latest.selectedPane &&
        latest.selectedPane !== pane &&
        latest.snapshot &&
        latest.inputReady,
    );
    assert.equal(latest.panes.length, 1);
    assert.ok(latest.panes.every((choice) => choice.id !== pane));
    await until(() =>
      tmux("capture-pane", "-p", "-t", replacement)
        .split("\n")
        .some((line) => line.trim() === "AFTER_PANE_REPLACEMENT"),
    );
    // An already displayed human marker is not a processing barrier. Queue the
    // stale attempt and a fresh owned-pane marker on the same browser stdin.
    const barrier = `STALE_BARRIER_${randomUUID().replaceAll("-", "")}`;
    send({
      type: "input",
      request: latest.request,
      id: pane,
      input: { kind: "text", data: "STALE_DELETED_PANE" },
    });
    send({
      type: "input",
      request: latest.request,
      id: latest.selectedPane,
      input: { kind: "text", data: `echo ${barrier}\n` },
    });
    await until(() =>
      tmux("capture-pane", "-p", "-t", replacement)
        .split("\n")
        .some((line) => line.trim() === barrier),
    );
  } else {
    send({ type: "refresh", request: 5 });
    await until(() => latest?.request === 5 && latest.sessions.length === 1);
    send({ type: "session", request: 6, id: latest.sessions[0].id });
    await until(() => latest?.request === 6 && latest.panes.length > 0);
    assert.ok(latest.panes.every((choice) => choice.id !== pane));
    assert.equal(latest.panes.length, 1);
    send({ type: "pane", request: 7, id: latest.panes[0].id });
    await until(() => latest?.request === 7 && latest.snapshot && latest.inputReady);
    send({
      type: "input",
      request: 7,
      id: pane,
      input: { kind: "text", data: "STALE_DELETED_PANE" },
    });
    send({
      type: "input",
      request: 7,
      id: latest.selectedPane,
      input: { kind: "text", data: "echo REPLACEMENT_INPUT_OK\n" },
    });
    await until(() =>
      fleet
        .captureWindowPanes(fleet.sessionNames[0])
        .split("\n")
        .some((line) => line.trim() === "REPLACEMENT_INPUT_OK"),
    );
  }
  assert.ok(!fleet.captureWindowPanes(fleet.sessionNames[0]).includes("STALE_DELETED_PANE"));
  assert.equal(latest.connection, connection);
  assert.ok(!stderr.includes(host.ownerToken));
  if (pipeError) throw pipeError;
  console.log(
    JSON.stringify({
      passed: true,
      runtime: app ? "packaged-browser-helper" : "source",
      nativeExternal: !!pipeDir,
      ...(pipeDir
        ? { beforeTyped: true, unavailableObservationSignaled: true, afterTyped: true }
        : {}),
      sameBrowser: true,
      selectedPaneRemoved: true,
      replacementIdentityChanged: true,
      staleInputRejected: true,
    }),
  );
} catch (error) {
  errors.push(error);
} finally {
  clearInterval(pipeTimer);
  if (pipeError && !errors.includes(pipeError)) errors.push(pipeError);
  for (const fd of [inputFd, outputFd])
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    }
  for (const path of [inputPath, outputPath])
    if (path) {
      try {
        if (lstatSync(path).isFIFO()) unlinkSync(path);
      } catch (error) {
        errors.push(error);
      }
    }
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const closed = once(browser, "close");
    const waitClose = async () => {
      let timer;
      try {
        return await Promise.race([
          closed.then(() => true),
          new Promise((done) => {
            timer = setTimeout(() => done(false), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      browser.kill("SIGTERM");
      if (!(await waitClose())) {
        browser.kill("SIGKILL");
        if (!(await waitClose()))
          errors.push(new Error("Owned browser did not close after SIGKILL"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    if (daemon) await daemon.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    await fleet.dispose();
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length) throw new AggregateError(errors, "Pane replacement fixture failed");
