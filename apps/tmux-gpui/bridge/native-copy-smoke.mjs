// External native full-pane copy proof using owned canonical and tmux capture evidence.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { Buffer } from "node:buffer";

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
import { writeFile, readFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
const app = process.env.TMUX_GPUI_TEST_APP;
const pipeDir = process.env.TMUX_GPUI_NATIVE_PIPE_DIR;
if (!app || !isAbsolute(app) || !pipeDir || !isAbsolute(pipeDir) || existsSync(pipeDir))
  throw new Error("Require absolute packaged app and fresh absolute native pipe directory");
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
  slug: "gpui-native-copy",
});
let daemon, browser;
let pipeTimer, inputFd, outputFd;
let inputPath, outputPath;
let pipeError;
let nativeResize;

let publicationQueue = Buffer.alloc(0);
let nativeBuffer = Buffer.alloc(0);
const errors = [];
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
    hostClientId: "gpui-native-copy-test",
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
        let budget = 1024 * 1024;
        while (publicationQueue.length && budget > 0) {
          try {
            const n = writeSync(inputFd, publicationQueue.subarray(0, budget));
            if (!n) break;
            publicationQueue = publicationQueue.subarray(n);
            budget -= n;
          } catch (error) {
            if (error.code !== "EAGAIN") throw error;
            break;
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
          if (command.type === "input" && command.input?.kind === "resize") nativeResize = command;
          browser.stdin.write(line);
          nativeBuffer = nativeBuffer.subarray(end + 1);
        }
        if (nativeBuffer.length > 8192) throw new Error("Native partial command limit exceeded");
      } catch (error) {
        pipeError = error;
        clearInterval(pipeTimer);
      }
    }, 1);
    stage(`NATIVE_PIPE_READY ${pipeDir}`);
  }
  stage("SELECT_COPY_PANE: select the only session and pane; do not type into it");
  await until(
    () => latest?.selectedPane && latest.snapshot && latest.inputReady && latest.copyRegion,
  );
  const tmux = (...args) =>
    execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ...fleet.environment },
    });
  const pane = fleet.initialPanes[0].paneId;
  stage("WAIT_NATIVE_VIEWPORT: waiting for native resize and matching canonical/tmux geometry");
  await until(() => {
    if (
      !nativeResize ||
      nativeResize.request !== latest?.request ||
      nativeResize.id !== latest?.selectedPane ||
      !latest.inputReady ||
      !latest.snapshot ||
      !latest.copyRegion
    )
      return false;
    const { cols, rows } = nativeResize.input.data;
    const dimensions = tmux(
      "display-message",
      "-p",
      "-t",
      pane,
      "#{window_width},#{window_height},#{pane_width},#{pane_height}",
    )
      .trim()
      .split(",")
      .map(Number);
    return (
      latest.snapshot.cols === cols &&
      latest.snapshot.rows === rows &&
      dimensions[0] === cols &&
      dimensions[1] === rows &&
      dimensions[2] === latest.copyRegion.width &&
      dimensions[3] === latest.copyRegion.height
    );
  });
  const settledResize = nativeResize;
  const width = latest.copyRegion.width;
  assert.ok(width >= 40, "Unicode fixture requires at least 40 columns");
  const soft = "COPY_UNICODE_界e\u0301🙂_" + "x".repeat(width * 2) + "_SOFT_END";
  const hard = "HARD_LINE_λ_END";
  const producer = join(fleet.root, "copy-producer.cjs");
  // No prompt/echo may contaminate the clipboard oracle. The process stays alive
  // and ignores input; exact private daemon/native lifecycle cleanup owns it.
  await writeFile(
    producer,
    `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify("\x1b[2J\x1b[H" + soft + "\r\n" + hard + "\r\n")});setInterval(()=>{},1000);`,
    { mode: 0o600 },
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  tmux("respawn-pane", "-k", "-t", pane, `${quote(process.execPath)} ${quote(producer)}`);
  const selectedText = (event) => {
    const region = event.copyRegion;
    if (!region || !event.snapshot) return null;
    let result = "";
    for (let index = 0; index < region.height; index++) {
      const cells = event.snapshot.grid[region.top + index].cells.slice(
        region.left,
        region.left + region.width,
      );
      const line = cells
        .filter((cell) => cell.width !== 0)
        .map((cell) => cell.grapheme || " ")
        .join("");
      const continued = region.wrapped[index + 1] === true;
      result += continued ? line : line.replace(/ +$/u, "");
      if (index + 1 < region.height && !continued) result += "\n";
    }
    return result;
  };
  await until(
    () =>
      latest?.inputReady &&
      latest.copyRegion?.wrapped.some(Boolean) &&
      selectedText(latest)?.startsWith(soft + "\n" + hard + "\n"),
  );
  const expected = selectedText(latest);
  const binding = {
    nativeResize: settledResize,
    request: latest.request,
    selectedPane: latest.selectedPane,
    region: latest.copyRegion,
    cols: latest.snapshot.cols,
    rows: latest.snapshot.rows,
  };
  const captured = tmux("capture-pane", "-p", "-J", "-t", pane);
  assert.equal(
    captured.replace(/\n+$/u, ""),
    expected.replace(/\n+$/u, ""),
    "independent tmux joined capture",
  );
  await writeFile(join(pipeDir, "expected.txt"), expected, { mode: 0o600 });
  await writeFile(join(pipeDir, "tmux-joined.txt"), captured, { mode: 0o600 });
  await writeFile(join(pipeDir, "binding.json"), JSON.stringify(binding), { mode: 0o600 });
  const clipboard = join(pipeDir, "clipboard.txt");
  stage(
    `COPY_READY: screenshot; set known sentinel clipboard; press Cmd-Shift-C with terminal focused and no selection; parent reads clipboard only after that action and atomically writes ${clipboard}`,
  );
  await until(() => existsSync(clipboard));
  const stat = lstatSync(clipboard);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
  assert.equal(latest.snapshot.cols, binding.cols);
  assert.equal(latest.snapshot.rows, binding.rows);
  assert.equal(latest.request, binding.request);
  assert.equal(latest.selectedPane, binding.selectedPane);
  assert.equal(selectedText(latest), expected, "viewport changed during physical copy");
  assert.equal(
    await readFile(clipboard, "utf8"),
    expected,
    "native clipboard exact full-pane logical text",
  );
  if (pipeError) throw pipeError;
  console.log(
    JSON.stringify({
      passed: true,
      packagedBrowser: true,
      externalNative: true,
      unicodeSoftWrap: true,
      hardNewline: true,
      independentTmuxJoined: true,
      exactClipboard: true,
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
if (errors.length) throw new AggregateError(errors, "Native copy fixture failed");
