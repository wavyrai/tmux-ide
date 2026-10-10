// Real tmux geometry proof on an explicitly owned socket and daemon.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import {
  existsSync,
  constants,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import assert from "node:assert/strict";

const app = process.env.TMUX_GPUI_TEST_APP;
const pipeDir = process.env.TMUX_GPUI_NATIVE_PIPE_DIR;
const nativeBinary = process.env.TMUX_GPUI_TEST_BINARY;
const nativeMode = !!nativeBinary || !!pipeDir;
if (app && !isAbsolute(app)) throw new Error("App path must be absolute");
if (pipeDir && (!isAbsolute(pipeDir) || existsSync(pipeDir) || nativeBinary))
  throw new Error("FIFO directory must be fresh, absolute, and exclusive of native binary");
let pipeTimer, inputFd, outputFd, inputPath, outputPath, pipeError;
let publicationQueue = Buffer.alloc(0),
  nativeBuffer = Buffer.alloc(0);
const screenshot = async (name) => {
  if (!pipeDir) return;
  const path = join(pipeDir, `${name}.observed`);
  console.log(`SCREENSHOT_CHECKPOINT ${name}: create ${path} after observation`);
  await wait(
    () => existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    `${name} screenshot`,
  );
};
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-resize" });
let daemon, helper, native, failure;
const cleanupErrors = [];
let diagnostic = "";
const events = [];
const commands = [];
const dragPublications = new WeakMap();
const recordCommand = (command) => {
  if (command.type === "resize-pane") {
    const publication = events.findLast(
      (event) =>
        event.request === command.request &&
        event.resizeToken === command.token &&
        event.inputReady &&
        event.snapshot &&
        event.regions?.some((region) => region.id === command.id),
    );
    if (!publication) throw new Error("Native drag has no matching retained coherent publication");
    dragPublications.set(command, publication);
  }
  commands.push(command);
};
const drags = () => commands.filter((command) => command.type === "resize-pane");
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trim();
const wait = async (predicate, label) => {
  const end = Date.now() + (nativeMode ? 180000 : 30000);
  while (true) {
    if (pipeError) throw pipeError;
    if (helper?.exitCode != null || helper?.signalCode != null)
      throw new Error("Helper exited: " + diagnostic);
    if (native && (native.exitCode != null || native.signalCode != null))
      throw new Error("Native closed during " + label);
    if (Date.now() > end) {
      const event = events.at(-1);
      throw new Error(
        label +
          " deadline: " +
          diagnostic +
          JSON.stringify({
            request: event?.request,
            inputReady: event?.inputReady,
            resizeToken: event?.resizeToken,
            regions: event?.regions,
            hasSnapshot: !!event?.snapshot,
            status: event?.status,
          }),
      );
    }
    if (predicate()) {
      if (pipeError) throw pipeError;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};
const send = (command) => helper.stdin.write(JSON.stringify(command) + "\n");
const latest = () => events.at(-1);
const paneGrid = (pane) =>
  tmux("display-message", "-p", "-t", pane, "#{pane_width},#{pane_height}").split(",").map(Number);
const capture = (pane) => tmux("capture-pane", "-p", "-t", pane);
const ready = () => latest()?.inputReady && latest()?.snapshot && latest()?.resizeToken;
try {
  const session = fleet.sessionNames[0];
  const first = tmux("display-message", "-p", "-t", session, "#{pane_id}");
  const second = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-pane-resize-proof",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = fleet.root + "/resize.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  helper = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/browser.bundle.mjs"), config]
      : [
          ...(process.env.TMUX_GPUI_TEST_BUNDLE ? [] : ["--import", "tsx"]),
          process.env.TMUX_GPUI_TEST_BUNDLE
            ? resolve(process.env.TMUX_GPUI_TEST_BUNDLE, "browser.bundle.mjs")
            : resolve("apps/tmux-gpui/bridge/browser.ts"),
          config,
        ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...fleet.environment, ...(app ? { PATH: "/usr/bin:/bin" } : {}) },
      ...(app || process.env.TMUX_GPUI_TEST_BUNDLE ? { cwd: fleet.root } : {}),
    },
  );
  helper.stderr.on("data", (b) => (diagnostic = (diagnostic + b).slice(-4000)));
  let buffer = "";
  helper.stdout.on("data", (b) => {
    if (pipeDir) {
      publicationQueue = Buffer.concat([publicationQueue, b]);
      if (publicationQueue.length > 16 * 1024 * 1024)
        pipeError = new Error("Native publication queue limit exceeded");
    }
    buffer += b;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      events.push(JSON.parse(buffer.slice(0, end)));
      if (events.length > 500) events.shift();
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
        // Drain available FIFO capacity without turning a small kernel write into
        // an artificial frame-rate throttle. Preserve every byte, bounded per tick.
        let writeBudget = 1024 * 1024;
        while (publicationQueue.length && writeBudget > 0) {
          try {
            const n = writeSync(inputFd, publicationQueue.subarray(0, writeBudget));
            if (n === 0) break;
            publicationQueue = publicationQueue.subarray(n);
            writeBudget -= n;
          } catch (error) {
            if (error.code !== "EAGAIN") throw error;
            break;
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
          recordCommand(command);
          if (commands.length > 4096) throw new Error("Native command count limit exceeded");
          helper.stdin.write(line);
          nativeBuffer = nativeBuffer.subarray(end + 1);
        }
        if (nativeBuffer.length > 8192) throw new Error("Native partial command limit exceeded");
      } catch (error) {
        pipeError = error;
        clearInterval(pipeTimer);
      }
    }, 1);
    console.log(`NATIVE_PIPE_READY ${pipeDir}: select session and pane`);
  }
  if (nativeBinary) {
    native = spawn(nativeBinary, ["--tmux-browser-stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...fleet.environment },
    });
    helper.stdout.pipe(native.stdin);
    native.stdout.pipe(helper.stdin);
    native.stdin.on("error", () => {});
    let input = "";
    native.stdout.on("data", (b) => {
      input += b;
      let end;
      while ((end = input.indexOf("\n")) >= 0) {
        try {
          recordCommand(JSON.parse(input.slice(0, end)));
        } catch (error) {
          pipeError = error;
        }
        input = input.slice(end + 1);
      }
    });
    if (latest()) native.stdin.write(JSON.stringify(latest()) + "\n");
    console.log(JSON.stringify({ stage: "select-session", nativePid: native.pid }));
  }
  await wait(() => latest()?.sessions?.length === 1, "catalog");
  if (!nativeMode) {
    send({ type: "session", request: 1, id: latest().sessions[0].id });
    await wait(() => latest()?.panes?.length === 2, "pane catalog");
    send({ type: "pane", request: 2, id: latest().panes[0].id });
  }
  await wait(ready, "resize-ready horizontal split");
  const stableToken = latest().resizeToken;
  tmux("send-keys", "-t", second, "-l", "printf 'RESIZE_OUTPUT_OK\\n'");
  tmux("send-keys", "-t", second, "Enter");
  await wait(
    () =>
      latest()
        ?.snapshot?.grid.map((r) => r.cells.map((c) => c.grapheme).join(""))
        .join("\n")
        .includes("RESIZE_OUTPUT_OK"),
    "content-only publication",
  );
  // Native window sizing may legitimately overlap initial output delivery.
  if (!nativeMode) assert.equal(latest().resizeToken, stableToken);
  if (nativeMode) {
    tmux(
      "send-keys",
      "-t",
      second,
      "-l",
      "i=0; while [ $i -lt 1200 ]; do printf '.'; i=$((i+1)); sleep 0.1; done",
    );
    tmux("send-keys", "-t", second, "Enter");
  }
  const left = () => latest().regions.find((p) => p.left === 0);
  const before = paneGrid(first)[0];
  const stale = {
    type: "resize-pane",
    request: latest().request,
    id: left().id,
    token: latest().resizeToken,
    axis: "cols",
    cells: before + 7,
  };
  if (nativeMode)
    console.log(
      JSON.stringify({ stage: "drag-vertical-divider", before, regions: latest().regions }),
    );
  else send(stale);
  if (nativeMode) {
    await wait(() => drags().length >= 1, "native vertical divider command");
    const command = drags()[0];
    const publication = dragPublications.get(command);
    const target = publication.regions.find((region) => region.id === command.id);
    assert.equal(command.axis, "cols");
    assert.equal(target.left, 0);
    assert.notEqual(command.cells, target.width);
    await wait(
      () => paneGrid(first)[0] === command.cells,
      "native vertical drag reaches requested tmux width",
    );
  } else
    await wait(() => paneGrid(first)[0] !== before, "vertical divider changes real tmux width");
  await wait(() => ready() && left().width === paneGrid(first)[0], "coherent resized columns");
  if (!nativeMode) assert.equal(paneGrid(first)[0], before + 7);
  const changed = paneGrid(first)[0];
  if (nativeMode) {
    const drags = commands.filter((c) => c.type === "resize-pane");
    assert.equal(drags.length, 1);
    const publication = dragPublications.get(drags[0]);
    assert.equal(drags[0].request, publication.request);
    assert.equal(drags[0].token, publication.resizeToken);
    assert.equal(drags[0].axis, "cols");
    assert.equal(drags[0].id, stale.id);
    assert.equal(drags[0].cells, changed);
    assert.equal(
      commands.some((c) => c.type === "input" && c.input?.kind !== "resize"),
      false,
    );
    await screenshot("cols");
  }
  if (!nativeMode) {
    const seq = latest().sequence;
    send({ ...stale, cells: before + 12 });
    // A round-trip selection in the same pipe fences command processing.
    send({ type: "pane", request: latest().request + 1, id: latest().selectedPane });
    await wait(
      () => ready() && latest().sequence > seq && latest().request > stale.request,
      "stale drag barrier",
    );
    assert.equal(paneGrid(first)[0], changed);
  }
  if (nativeMode) tmux("send-keys", "-t", second, "C-c");
  // Horizontal divider with an outer status row: region height is not pane_height.
  tmux("select-layout", "-t", first, "even-vertical");
  tmux("set-option", "-w", "-t", first, "pane-border-status", "top");
  await wait(
    () =>
      ready() &&
      latest().regions.every((p) => p.left === 0) &&
      latest().regions.find((p) => p.top === 0)?.height === paneGrid(first)[1] + 1,
    "vertical layout and status row",
  );
  const top = latest().regions.find((p) => p.top === 0);
  const beforeRows = paneGrid(first)[1];

  if (nativeMode)
    console.log(
      JSON.stringify({ stage: "drag-horizontal-divider", beforeRows, regions: latest().regions }),
    );
  else
    send({
      type: "resize-pane",
      request: latest().request,
      id: top.id,
      token: latest().resizeToken,
      axis: "rows",
      cells: top.height + 3,
    });
  if (nativeMode) {
    await wait(() => drags().length >= 2, "native horizontal divider command");
    const command = drags()[1];
    const publication = dragPublications.get(command);
    const target = publication.regions.find((region) => region.id === command.id);
    assert.equal(command.axis, "rows");
    assert.equal(target.top, 0);
    assert.notEqual(command.cells, target.height);
    await wait(
      () => paneGrid(first)[1] + 1 === command.cells,
      "native horizontal drag reaches requested tmux height",
    );
  } else
    await wait(
      () => paneGrid(first)[1] !== beforeRows,
      "horizontal divider changes real tmux height",
    );
  await wait(
    () => ready() && latest().regions.find((p) => p.top === 0)?.height === paneGrid(first)[1] + 1,
    "coherent resized rows",
  );
  if (!nativeMode) assert.equal(paneGrid(first)[1], beforeRows + 3);
  if (nativeMode) {
    const drags = commands.filter((c) => c.type === "resize-pane");
    assert.equal(drags.length, 2);
    const publication = dragPublications.get(drags[1]);
    assert.equal(drags[1].request, publication.request);
    assert.equal(drags[1].token, publication.resizeToken);
    assert.equal(drags[1].axis, "rows");
    assert.equal(drags[1].id, top.id);
    assert.equal(drags[1].cells, paneGrid(first)[1] + 1);
    assert.equal(
      commands.some((c) => c.type === "input" && c.input?.kind !== "resize"),
      false,
    );
    console.log(
      JSON.stringify({
        stage: "native-drags-passed",
        commands: commands.filter((c) => c.type === "resize-pane"),
      }),
    );
  }
  await screenshot("rows");
  if (!nativeMode) {
    const zoomTarget = latest().regions.find((p) => p.top === 0);
    const zoomRequest = latest().request + 1;
    send({ type: "pane", request: zoomRequest, id: zoomTarget.id });
    await wait(() => ready() && latest().request === zoomRequest, "select pane to zoom");
    const preZoom = [paneGrid(first), paneGrid(second)];
    const preZoomToken = latest().resizeToken;
    tmux("resize-pane", "-Z", "-t", first);
    await wait(
      () => latest()?.snapshot && latest()?.resizeToken === null && latest()?.regions?.length === 1,
      "zoom suppresses divider capability",
    );
    tmux("resize-pane", "-Z", "-t", first);
    await wait(() => ready() && latest().regions.length === 2, "unzoom restores coherent split");
    assert.notEqual(latest().resizeToken, preZoomToken);
    assert.deepEqual([paneGrid(first), paneGrid(second)], preZoom);
    console.log(JSON.stringify({ zoomCancelsResize: true, unzoomRestoresLayout: true }));
    // A T layout has an unequal-span border. tmux, not the client, owns the subtree resize.
    tmux("set-option", "-w", "-t", first, "pane-border-status", "off");
    tmux("select-layout", "-t", first, "even-horizontal");
    const third = tmux("split-window", "-v", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
    let request = latest().request + 1;
    send({ type: "session", request, id: latest().sessions[0].id });
    await wait(
      () => latest()?.request === request && latest()?.panes?.length === 3,
      "nested pane catalog",
    );
    send({ type: "pane", request: ++request, id: latest().panes[0].id });
    await wait(ready, "nested resize ready");
    const target = latest().regions.find((p) => p.left === 0 && p.top === 0);
    const width = paneGrid(first)[0];
    send({
      type: "resize-pane",
      request,
      id: target.id,
      token: latest().resizeToken,
      axis: "cols",
      cells: width + 5,
    });
    await wait(
      () => paneGrid(first)[0] === width + 5 && paneGrid(third)[0] === width + 5,
      "tmux resizes nested ancestor",
    );
    await wait(
      () => ready() && latest().regions.find((p) => p.id === target.id)?.width === width + 5,
      "nested coherent frame",
    );
    assert.equal(paneGrid(second)[0], latest().snapshot.cols - width - 6);
    console.log(JSON.stringify({ nestedTmuxAncestorResize: true }));
    // Counterexample: the last leaf of a nested same-axis group cannot identify
    // an outer divider by pane id alone. Keep that native handle disabled.
    const fourth = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
    const edge = () =>
      Number(tmux("display-message", "-p", "-t", fourth, "#{pane_left}")) + paneGrid(fourth)[0];
    const outerEdge = edge(),
      siblingWidth = paneGrid(second)[0],
      innerWidth = paneGrid(first)[0];
    tmux("resize-pane", "-t", fourth, "-x", String(paneGrid(fourth)[0] + 2));
    assert.equal(edge(), outerEdge);
    assert.equal(paneGrid(second)[0], siblingWidth);
    assert.equal(paneGrid(first)[0], innerWidth - 2);
    console.log(JSON.stringify({ ambiguousNestedTargetMovesInnerDivider: true }));
  }
  // No drag command was delivered as shell text, and both sessions still work.
  for (const pane of [first, second]) assert.equal(capture(pane).includes("resize-pane"), false);
  if (nativeMode) {
    // Include commands received while the final screenshot checkpoint was open.
    assert.equal(commands.filter((command) => command.type === "resize-pane").length, 2);
    assert.equal(
      commands.some((command) => command.type === "input" && command.input?.kind !== "resize"),
      false,
    );
  }
  if (pipeError) throw pipeError;
  console.log(
    JSON.stringify({
      passed: true,
      runtime: app ? "packaged-browser-helper" : "source-or-bundle",
      externalNative: !!pipeDir,
      realTmux: true,
      columns: true,
      rowsWithStatus: true,
      staleTokenRejected: !nativeMode,
      nativeDrag: nativeMode,
      contentInputLeak: false,
    }),
  );
  if (native) await new Promise((r) => setTimeout(r, 10000));
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  clearInterval(pipeTimer);
  if (pipeError && pipeError !== failure) errors.push(pipeError);
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
  for (const child of [native, helper]) {
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    let escalation, deadline;
    try {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000);
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Child cleanup deadline")), 5000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
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
  cleanupErrors.push(...errors);
}

if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    "Resize fixture failed",
  );
