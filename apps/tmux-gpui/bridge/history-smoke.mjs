// Opt-in multi-pane transport check against an owned daemon and tmux socket.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { stopFixtureChild } from "./fixture-child.mjs";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-multi" });
let daemon, helper, client, fatal, result;
const failures = [];
const events = [];
let diagnostic = "";
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trim();
const wait = async (predicate) => {
  const end = Date.now() + 20000;
  while (!predicate()) {
    if (fatal) throw fatal;
    if (helper?.exitCode != null) throw new Error("Helper exited: " + diagnostic);
    if (Date.now() > end) throw new Error("Multi-pane deadline: " + diagnostic);
    await new Promise((r) => setTimeout(r, 20));
  }
  if (fatal) throw fatal;
};
const text = (snapshot) =>
  snapshot.grid.map((r) => r.cells.map((c) => c.grapheme).join("")).join("\n");
try {
  const first = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  const second = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
  for (const [pane, marker] of [
    [first, "LEFT_UNIQUE"],
    [second, "RIGHT_UNIQUE"],
  ]) {
    tmux("send-keys", "-t", pane, "-l", `printf '${marker}\\n'`);
    tmux("send-keys", "-t", pane, "Enter");
  }
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-multi-test",
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
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope,
      workspaceName: opened.workspaceName,
      liveSessionId: session.liveSessionId,
      semanticPaneId: ids[0],
      visiblePaneIds: ids,
    }),
    { mode: 0o600 },
  );
  helper = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/live.bundle.mjs"), config, "--interactive"]
      : ["--import", "tsx", resolve("apps/tmux-gpui/bridge/live.ts"), config, "--interactive"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      ...(app
        ? { cwd: fleet.root, env: { ...process.env, ...fleet.environment, PATH: "/usr/bin:/bin" } }
        : {}),
    },
  );
  helper.on("error", (error) => {
    fatal ??= error;
  });
  helper.stdin.on("error", (error) => {
    fatal ??= error;
  });
  helper.stderr.on("data", (b) => {
    diagnostic = (diagnostic + b.toString()).slice(-65536);
  });
  let buffer = "";
  helper.stdout.on("data", (b) => {
    if (fatal) return;
    try {
      buffer += b.toString();
      assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024, "history publication limit");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        events.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    } catch (error) {
      fatal ??= error;
    }
  });
  await wait(() => events.at(-1)?.surfaces?.length === 2);
  const seeded = events.at(-1).surfaces;
  const left = seeded.find((s) => text(s.snapshot).includes("LEFT_UNIQUE"));
  const right = seeded.find((s) => text(s.snapshot).includes("RIGHT_UNIQUE"));
  assert.ok(left && right && left.paneId !== right.paneId);
  const untouched = JSON.stringify(right.snapshot);
  tmux("send-keys", "-t", first, "-l", "printf 'LEFT_UPDATED\\n'");
  tmux("send-keys", "-t", first, "Enter");
  await wait(() =>
    events
      .at(-1)
      ?.surfaces?.some(
        (s) => s.paneId === left.paneId && text(s.snapshot).includes("LEFT_UPDATED"),
      ),
  );
  assert.equal(
    JSON.stringify(events.at(-1).surfaces.find((s) => s.paneId === right.paneId).snapshot),
    untouched,
  );
  helper.stdin.write(JSON.stringify({ kind: "presence", active: true, revision: 1 }) + "\n");
  await wait(() => events.at(-1)?.presenceRevision === 1 && events.at(-1)?.inputReady);
  const target = ids[0] === left.paneId ? first : second;
  // Put a soft-wrapped Unicode line well inside the historical viewport.
  // Feed a file so shell command echo cannot masquerade as fixture output.
  const dimensions = events.at(-1).snapshot;
  const unicodeLine = "UNICODE_界e\u0301_" + "x".repeat(dimensions.cols + 8) + "_END";
  const unicodeIndex = Math.max(0, 80 - 30 - Math.ceil(dimensions.rows / 2));
  const historyFile = join(fleet.root, "unicode-history.txt");
  await writeFile(
    historyFile,
    Array.from({ length: 80 }, (_, i) =>
      i === unicodeIndex ? unicodeLine : `HIST_${String(i).padStart(3, "0")}`,
    ).join("\n") + "\nHISTORY_READY\n",
    { mode: 0o600 },
  );
  const quotedHistoryFile = "'" + historyFile.replaceAll("'", "'\"'\"'") + "'";
  tmux("send-keys", "-t", target, "-l", `cat ${quotedHistoryFile}`);
  tmux("send-keys", "-t", target, "Enter");
  await wait(
    () =>
      events.at(-1)?.snapshot &&
      text(events.at(-1).snapshot)
        .split("\n")
        .some((l) => l.trim() === "HISTORY_READY"),
  );
  helper.stdin.write(JSON.stringify({ kind: "scroll", data: 30 }) + "\n");
  await wait(() => events.at(-1)?.scrollOffset === 30);
  const anchorText = text(events.at(-1).snapshot).split("\n")[0];
  assert.match(anchorText, /HIST_/);
  assert.equal(events.at(-1).snapshot.cursor.hidden, true);
  const historicalRows = events.at(-1).snapshot.grid;
  const logicalHistory = historicalRows
    .map((row, index) => {
      const content = row.cells.map((cell) => cell.grapheme).join("");
      return historicalRows[index + 1]?.wrapped ? content : content.trimEnd() + "\n";
    })
    .join("");
  assert.ok(
    historicalRows.some((row) => row.wrapped),
    "source soft-wrap metadata survives history",
  );
  assert.ok(
    logicalHistory.includes(unicodeLine + "\n"),
    "wide and combining graphemes survive wrapped history",
  );
  assert.ok(
    tmux("capture-pane", "-p", "-J", "-S", "-100", "-t", target).includes(unicodeLine),
    "independent tmux capture contains the exact logical Unicode line",
  );
  const before = events.at(-1).sequence;
  tmux("send-keys", "-t", target, "-l", "printf 'AFTER_SCROLL\\n'");
  tmux("send-keys", "-t", target, "Enter");
  await wait(() => events.at(-1).sequence > before && events.at(-1).scrollOffset > 30);
  assert.equal(text(events.at(-1).snapshot).split("\n")[0], anchorText);
  helper.stdin.write(JSON.stringify({ kind: "text", data: "SHOULD_NOT_TYPE" }) + "\n");
  helper.stdin.write(JSON.stringify({ kind: "scroll", data: 0 }) + "\n");
  await wait(
    () => events.at(-1).scrollOffset === 0 && text(events.at(-1).snapshot).includes("AFTER_SCROLL"),
  );
  assert.ok(!tmux("capture-pane", "-p", "-t", target).includes("SHOULD_NOT_TYPE"));
  await daemon.stop();
  daemon = undefined;
  await wait(() => events.at(-1)?.snapshot === null && events.at(-1)?.surfaces?.length === 0);
  result = {
    passed: true,
    runtime: app ? "packaged-node-and-helper" : "source",
    nativeClipboardQualified: false,
    panes: 2,
    independentUpdate: true,
    anchoredHistory: true,
    unicodeWrappedHistory: true,
    historicalInputBlocked: true,
    clearedOnDisconnect: true,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => client?.dispose(),
    () => stopFixtureChild(helper),
    () => daemon?.stop(),
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
if (failures.length) throw new AggregateError(failures, "History fixture failed");
console.log(JSON.stringify(result));
