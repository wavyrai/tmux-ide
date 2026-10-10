// Opt-in multi-pane transport check against an owned daemon and tmux socket.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  constants,
  openSync,
  readSync,
  writeSync,
  closeSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import assert from "node:assert/strict";
const app = process.env.TMUX_GPUI_TEST_APP;
const pipeDir = process.env.TMUX_GPUI_NATIVE_PIPE_DIR;
if (pipeDir && (!isAbsolute(pipeDir) || existsSync(pipeDir) || process.env.TMUX_GPUI_TEST_BINARY))
  throw new Error(
    "External native FIFO directory must be fresh, absolute, and exclusive of TEST_BINARY",
  );
const nativeMode = !!pipeDir || !!process.env.TMUX_GPUI_TEST_BINARY;
let pipeTimer, inputFd, outputFd, inputPath, outputPath, pipeError;
let publicationQueue = Buffer.alloc(0),
  nativeBuffer = Buffer.alloc(0);
let scrollCommands = 0;
const screenshot = async (name) => {
  const path = join(pipeDir, `${name}.observed`);
  console.log(`SCREENSHOT_CHECKPOINT ${name}: create ${path} after observation`);
  await wait(
    () => existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
  );
};
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-canvas" });
let daemon, helper, client, native;
const events = [];
let diagnostic = "";
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trim();
const wait = async (predicate) => {
  const end = Date.now() + (nativeMode ? 180000 : 20000);
  while (true) {
    if (pipeError) throw pipeError;
    if (helper && (helper.exitCode != null || helper.signalCode != null))
      throw new Error("Helper exited: " + diagnostic);
    if (Date.now() > end) throw new Error("Multi-pane deadline: " + diagnostic);
    if (predicate()) {
      if (pipeError) throw pipeError;
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};
const errors = [];
const text = (snapshot) =>
  snapshot.grid.map((r) => r.cells.map((c) => c.grapheme).join("")).join("\n");
try {
  const first = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  const second = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
  for (const [pane, marker] of [
    [first, "LEFT_UNIQUE"],
    [second, "RIGHT_UNIQUE"],
  ]) {
    // Seed genuine tmux history before daemon opening/replica attachment.
    if (!process.env.TMUX_GPUI_TEST_BINARY) {
      tmux(
        "send-keys",
        "-t",
        pane,
        "-l",
        `i=0; while [ $i -lt 80 ]; do printf '${marker}_HIST_%03d\\n' "$i"; i=$((i+1)); done`,
      );
      tmux("send-keys", "-t", pane, "Enter");
      await wait(() => tmux("capture-pane", "-p", "-t", pane).includes(`${marker}_HIST_079`));
    }
    tmux("send-keys", "-t", pane, "-l", `printf '${marker}\\n'`);
    tmux("send-keys", "-t", pane, "Enter");
  }
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-canvas-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  const scope = { serverId: server.serverId, generation: server.generation };
  client = createTmuxServerClient(options, scope);
  const session = (await client.sessions()).sessions[0];
  const opened = await client.openSession(session.liveSessionId);
  const ids = (await client.inventory(opened.workspaceName)).resource.semanticPaneIds;
  assert.equal(ids.length, 2);
  const config = fleet.root + "/multi.json";
  await writeFile(
    config,
    JSON.stringify({ baseUrl: options.baseUrl, ownerToken: options.ownerToken, scope }),
    { mode: 0o600 },
  );
  helper = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/browser.bundle.mjs"), config]
      : ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    {
      stdio: ["pipe", "pipe", "pipe"],
      ...(app
        ? { cwd: fleet.root, env: { ...process.env, ...fleet.environment, PATH: "/usr/bin:/bin" } }
        : {}),
    },
  );
  helper.stderr.on("data", (b) => {
    diagnostic += b.toString();
  });
  let buffer = "";
  helper.stdout.on("data", (b) => {
    if (pipeDir) {
      publicationQueue = Buffer.concat([publicationQueue, b]);
      if (publicationQueue.length > 16 * 1024 * 1024)
        pipeError = new Error("Native publication queue limit exceeded");
    }
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      events.push(JSON.parse(buffer.slice(0, end)));
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
        if (helper.stdin.writableLength > 65536) return;
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
          if (command.type === "input" && command.input?.kind === "scroll") scrollCommands++;
          helper.stdin.write(line);
          nativeBuffer = nativeBuffer.subarray(end + 1);
        }
        if (nativeBuffer.length > 8192) throw new Error("Native partial command limit exceeded");
      } catch (error) {
        pipeError = error;
        clearInterval(pipeTimer);
      }
    }, 10);
    console.log(`NATIVE_PIPE_READY ${pipeDir}: select session and pane`);
  }
  if (process.env.TMUX_GPUI_TEST_BINARY) {
    native = spawn(process.env.TMUX_GPUI_TEST_BINARY, ["--tmux-browser-stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...fleet.environment },
    });
    helper.stdout.pipe(native.stdin);
    native.stdout.pipe(helper.stdin);
    native.stdin.on("error", () => {});
    if (events.length) native.stdin.write(JSON.stringify(events.at(-1)) + "\n");
    console.log("Native canvas ready: select the session and a pane");
  }
  await wait(() => events.at(-1)?.sessions?.length === 1);
  if (!nativeMode) {
    helper.stdin.write(JSON.stringify({ type: "presence", active: true, revision: 1 }) + "\n");
    helper.stdin.write(
      JSON.stringify({ type: "session", request: 1, id: events.at(-1).sessions[0].id }) + "\n",
    );
    await wait(() => events.at(-1)?.panes?.length === 2);
    helper.stdin.write(
      JSON.stringify({ type: "pane", request: 2, id: events.at(-1).panes[0].id }) + "\n",
    );
  }
  await wait(
    () =>
      events.at(-1)?.snapshot &&
      text(events.at(-1).snapshot).includes("LEFT_UNIQUE") &&
      text(events.at(-1).snapshot).includes("RIGHT_UNIQUE"),
  );
  assert.equal(events.at(-1).snapshot.cols, fleet.windowGrid(fleet.sessionNames[0]).cols);
  tmux("send-keys", "-t", first, "-l", "printf 'LEFT_UPDATED\\n'");
  tmux("send-keys", "-t", first, "Enter");
  await wait(
    () => events.at(-1)?.snapshot && text(events.at(-1).snapshot).includes("LEFT_UPDATED"),
  );
  assert.ok(text(events.at(-1).snapshot).includes("RIGHT_UNIQUE"));
  if (!nativeMode) {
    await wait(() => events.at(-1)?.inputReady && events.at(-1)?.presenceRevision === 1);
    const selected = events.at(-1).selectedPane;
    const region = events.at(-1).regions.find((r) => r.id === selected);
    assert.ok(region);
    const target = region.left === 0 ? first : second;
    const marker = region.left === 0 ? "LEFT_UNIQUE" : "RIGHT_UNIQUE";
    const sendScroll = (request, id, data) =>
      helper.stdin.write(
        JSON.stringify({ type: "input", request, id, input: { kind: "scroll", data } }) + "\n",
      );
    const selectedTop = (event) =>
      event.snapshot.grid[event.copyRegion.top].cells
        .slice(event.copyRegion.left, event.copyRegion.left + event.copyRegion.width)
        .map((cell) => cell.grapheme)
        .join("");
    sendScroll(2, selected, 30);
    await wait(() => events.at(-1)?.status.startsWith("History: 30 lines"));
    const anchored = selectedTop(events.at(-1));
    assert.match(anchored, new RegExp(`${marker}_HIST_[0-9]{3}`));
    assert.equal(events.at(-1).inputReady, false);
    assert.equal(events.at(-1).snapshot.cursor.hidden, true);
    tmux("send-keys", "-t", target, "-l", "printf 'AFTER_BROWSER_SCROLL\\n'");
    tmux("send-keys", "-t", target, "Enter");
    await wait(
      () =>
        /^History: (\d+) lines/.test(events.at(-1)?.status ?? "") &&
        Number(events.at(-1).status.match(/^History: (\d+) lines/)[1]) > 30,
    );
    assert.equal(selectedTop(events.at(-1)), anchored);
    sendScroll(2, selected, 0);
    await wait(
      () =>
        events.at(-1)?.inputReady && text(events.at(-1).snapshot).includes("AFTER_BROWSER_SCROLL"),
    );
    sendScroll(2, selected, 30);
    await wait(() => events.at(-1)?.status.startsWith("History: 30 lines"));
    const other = events.at(-1).panes.find((pane) => pane.id !== selected).id;
    helper.stdin.write(JSON.stringify({ type: "pane", request: 3, id: other }) + "\n");
    await wait(
      () =>
        events.at(-1)?.request === 3 &&
        events.at(-1)?.selectedPane === other &&
        events.at(-1)?.inputReady,
    );
    assert.ok(!events.at(-1).status.startsWith("History:"));
    assert.equal(events.at(-1).snapshot.cursor.hidden, false);
  }
  if (pipeDir) {
    await wait(() => events.at(-1)?.inputReady);
    const selected = events.at(-1).selectedPane;
    const region = events.at(-1).regions.find((r) => r.id === selected);
    const target = region.left === 0 ? first : second;
    const prefix = region.left === 0 ? "LEFT_UNIQUE_HIST_" : "RIGHT_UNIQUE_HIST_";
    const offset = () => Number(events.at(-1)?.status.match(/^History: (\d+) lines/)?.[1] ?? 0);
    const crop = (event) => {
      const r = event.copyRegion;
      return event.snapshot.grid
        .slice(r.top, r.top + r.height)
        .map((row) => row.cells.slice(r.left, r.left + r.width));
    };
    const beforeScrollCommands = scrollCommands;
    console.log(
      "NATIVE_HISTORY_READY: wheel upward over selected pane; stop after history appears",
    );
    await wait(() => scrollCommands > beforeScrollCommands && offset() > 0);
    assert.equal(events.at(-1).inputReady, false);
    assert.equal(events.at(-1).snapshot.cursor.hidden, true);
    assert.ok(
      crop(events.at(-1)).some((row) =>
        row
          .map((c) => c.grapheme)
          .join("")
          .includes(prefix),
      ),
    );
    await screenshot("history");
    const anchored = JSON.stringify(crop(events.at(-1)));
    const oldOffset = offset();
    const oldCommands = scrollCommands;
    tmux("send-keys", "-t", target, "-l", "printf 'AFTER_FIFO_SCROLL\\n'");
    tmux("send-keys", "-t", target, "Enter");
    await wait(() => offset() > oldOffset);
    assert.equal(scrollCommands, oldCommands, "Do not scroll while proving append anchoring");
    assert.equal(JSON.stringify(crop(events.at(-1))), anchored);
    console.log("NATIVE_HISTORY_ANCHORED: selected full viewport unchanged after live output");
    await screenshot("anchored");
    console.log("RETURN_LIVE: press Shift-End");
    await wait(
      () =>
        events.at(-1)?.inputReady &&
        offset() === 0 &&
        text(events.at(-1).snapshot).includes("AFTER_FIFO_SCROLL"),
    );
    await screenshot("live");
    console.log("SCROLL_THEN_SWITCH: wheel upward again; wait for next instruction");
    await wait(() => offset() > 0 && !events.at(-1).inputReady);
    console.log("SWITCH_PANE: use Cmd-K to select the other pane, verify live history reset");
    await wait(
      () => events.at(-1)?.selectedPane !== selected && events.at(-1)?.inputReady && offset() === 0,
    );
    assert.equal(events.at(-1).snapshot.cursor.hidden, false);
    await screenshot("switched");
  }
  if (native) {
    const initialSelection = events.at(-1).selectedPane;
    console.log("Native canvas verified: click the OTHER terminal pane to select it");
    await wait(
      () =>
        events.at(-1)?.selectedPane !== initialSelection &&
        events.at(-1)?.snapshot &&
        events.at(-1)?.inputReady,
    );
    console.log("Canvas click changed selected pane; type echo NATIVE_CANVAS and Enter");
    const selectedIndex =
      events.at(-1).snapshot.cursor.x <
      Number(tmux("display-message", "-p", "-t", second, "#{pane_left}"))
        ? 0
        : 1;
    if (process.env.TMUX_GPUI_TEST_SELECTION) {
      console.log(
        "Selection fixture ready: drag selected pane, then create the private signal file",
      );
      await wait(() => existsSync(process.env.TMUX_GPUI_TEST_SELECTION));
      const target = [first, second][selectedIndex];
      tmux("send-keys", "-t", target, "-l", "echo AFTER_SELECTION");
      tmux("send-keys", "-t", target, "Enter");
      await wait(
        () => events.at(-1)?.snapshot && text(events.at(-1).snapshot).includes("AFTER_SELECTION"),
      );
      console.log(
        "New output admitted during selection: verify frozen native frame, copy, Escape, then type echo NATIVE_CANVAS",
      );
    }
    const hasOutput = (value) => value.split("\n").some((line) => line.trim() === "NATIVE_CANVAS");
    await wait(() => hasOutput(tmux("capture-pane", "-p", "-t", [first, second][selectedIndex])));
    const output = [first, second].map((pane) => tmux("capture-pane", "-p", "-t", pane));
    assert.ok(hasOutput(output[selectedIndex]));
    assert.equal(hasOutput(output[1 - selectedIndex]), false);
    console.log("Native keyboard reached exactly one pane; screenshot ready");
    if (process.env.TMUX_GPUI_TEST_HISTORY) {
      const target = [first, second][selectedIndex];
      tmux(
        "send-keys",
        "-t",
        target,
        "-l",
        "i=0; while [ $i -lt 120 ]; do printf 'HISTORY_%03d\\n' $i; i=$((i+1)); done; echo HISTORY_READY",
      );
      tmux("send-keys", "-t", target, "Enter");
      await wait(
        () => events.at(-1)?.snapshot && text(events.at(-1).snapshot).includes("HISTORY_119"),
      );
      console.log(
        process.env.TMUX_GPUI_TEST_WHEEL
          ? "History fixture ready: scroll up over selected pane"
          : "History fixture ready: press Shift-PageUp",
      );
      await wait(() => events.at(-1)?.status.startsWith("History:"));
      const scrolled = text(events.at(-1).snapshot);
      assert.equal(events.at(-1).inputReady, false);
      const seq = events.at(-1).sequence;
      tmux("send-keys", "-t", target, "-l", "echo AFTER_NATIVE_SCROLL");
      tmux("send-keys", "-t", target, "Enter");
      await wait(() => events.at(-1).sequence > seq);
      assert.equal(text(events.at(-1).snapshot), scrolled);
      console.log("Native history remained anchored; screenshot and press Shift-End");
      await wait(
        () =>
          events.at(-1)?.inputReady && text(events.at(-1).snapshot).includes("AFTER_NATIVE_SCROLL"),
      );
      console.log("Native return to live restored output and input authority");
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  await daemon.stop();
  daemon = undefined;
  await wait(() => events.at(-1)?.snapshot === null && events.at(-1)?.inputReady === false);
  if (pipeError) throw pipeError;
  console.log(
    JSON.stringify({
      passed: true,
      externalNativeHistory: !!pipeDir,
      runtime: app ? "packaged-browser-helper" : "source",
      panes: 2,
      independentUpdate: true,
      ...(!nativeMode
        ? {
            preexistingHistory: true,
            anchoredHistory: true,
            returnLive: true,
            paneSwitchResetsHistory: true,
          }
        : {}),
      clearedOnDisconnect: true,
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
  client?.dispose();
  const retireChild = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "close");
    const waitClose = async () => {
      let timer;
      try {
        return await Promise.race([
          done.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    child.kill("SIGTERM");
    if (!(await waitClose())) {
      child.kill("SIGKILL");
      if (!(await waitClose())) throw new Error("Owned child did not close after SIGKILL");
    }
  };
  for (const child of [native, helper]) {
    try {
      await retireChild(child);
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
if (errors.length) throw new AggregateError(errors, "Canvas fixture failed");
