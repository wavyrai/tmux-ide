// Opt-in: real private daemon, private tmux server, and optionally the native window.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn } from "node:child_process";
import { createPreviewCatalog } from "./catalog.ts";
import { runPreview } from "./preview-processes.mjs";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-live",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_LIVE_INITIAL",
});
let daemon, helper, native;
let frames = 0,
  initial = false,
  changed = false,
  unavailable = false;
let helperError = "";
let nativeOutput = "";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    if (!unavailable && helper?.exitCode !== null && helper?.exitCode !== undefined)
      throw new Error("helper exited: " + helperError);
    await delay(50);
  }
  throw new Error("preview smoke timed out: " + helperError);
}
try {
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-smoke",
    origin: "tmux-ide://app",
  };
  const servers = await listTmuxServers(options);
  const server = servers.servers.find((s) => s.state === "online");
  if (!server) throw new Error("no owned server");
  const scope = { serverId: server.serverId, generation: server.generation };
  const client = createTmuxServerClient(options, scope);
  const sessions = await client.sessions();
  const session = sessions.sessions[0];
  const opened = await client.openSession(session.liveSessionId);
  const inventory = await client.inventory(opened.workspaceName);
  const config = {
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope,
    workspaceName: opened.workspaceName,
    liveSessionId: opened.liveSessionId,
    semanticPaneId: inventory.resource.semanticPaneIds[0],
  };
  const catalog = createPreviewCatalog({
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope,
  });
  try {
    const visible = await catalog.sessions();
    if (!visible.some((s) => s.liveSessionId === session.liveSessionId))
      throw new Error("Catalog omitted the owned session");
    const choices = await catalog.panes(session.liveSessionId);
    if (
      !choices.some(
        (p) =>
          p.semanticPaneId === config.semanticPaneId && p.workspaceName === config.workspaceName,
      )
    )
      throw new Error("Catalog routed to the wrong pane");
    let rejected = false;
    try {
      await catalog.panes("missing-session");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Catalog accepted a missing session");
    console.log("Scoped catalog selection verified; missing session rejected");
  } finally {
    catalog.dispose();
  }
  const path = fleet.root + "/connection.json";
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  helper = spawn(
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/live.ts"), path],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  helper.stderr.on("data", (b) => (helperError += b.toString()));
  if (process.env.TMUX_GPUI_TEST_BINARY) {
    native = spawn(process.env.TMUX_GPUI_TEST_BINARY, ["--tmux-live-stdin"], {
      env: { ...process.env, ...fleet.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    helper.stdout.pipe(native.stdin);
    native.stderr.on("data", (b) => {
      nativeOutput += b.toString();
      process.stderr.write(b);
    });
  }
  let buffer = "";
  helper.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const event = JSON.parse(line);
      frames++;
      if (!event.snapshot) {
        unavailable = true;
        continue;
      }
      const text = event.snapshot.grid
        .map((r) => r.cells.map((c) => c.grapheme).join(""))
        .join("\n");
      initial ||= text.split("\n").some((line) => line.trim() === "RIG_GPUI_LIVE_INITIAL");
      changed ||= text.split("\n").some((line) => line.trim() === "RIG_GPUI_LIVE_CHANGED");
    }
  });
  await until(() => initial);
  fleet.typeInPane(fleet.sessionNames[0], "printf 'RIG_GPUI_LIVE_CHANGED\\n'");
  await until(() => changed);
  console.log("Live seed and updated pane received");
  if (process.env.TMUX_GPUI_TEST_BINARY) {
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(), 2000);
    try {
      const code = await runPreview({
        helper: {
          command: process.execPath,
          args: ["--import", "tsx", resolve("apps/tmux-gpui/bridge/live.ts"), path],
          env: { ...process.env, ...fleet.environment },
        },
        native: {
          command: process.env.TMUX_GPUI_TEST_BINARY,
          args: ["--tmux-live-stdin"],
          env: { ...process.env, ...fleet.environment },
        },
        signal: cancellation.signal,
      });
      if (code !== 1 || !cancellation.signal.aborted)
        throw new Error("Launcher did not remain running until cancellation");
      // runPreview resolves only after both owned children close. The same
      // daemon and session must still be available to the original viewer.
      await client.inventory(opened.workspaceName);
      console.log("Native launcher cancellation reaped children; daemon preserved");
    } finally {
      clearTimeout(timer);
    }
  }
  await delay(process.env.TMUX_GPUI_TEST_BINARY ? 15000 : 100);
  const oldGeneration = daemon.record.instanceId;
  await daemon.stop();
  daemon = null;
  await until(() => unavailable);
  if (native) await until(() => nativeOutput.includes("unavailable applied"));
  const retiredFrames = frames;
  daemon = await startDaemon(fleet);
  if (daemon.record.instanceId === oldGeneration) throw new Error("Replacement reused generation");
  await delay(500);
  if (frames !== retiredFrames) throw new Error("Retired preview received replacement state");
  console.log(
    JSON.stringify({
      passed: true,
      frames,
      initial,
      changed,
      unavailable,
      nativeApplied: !!native,
      replacementRejected: true,
    }),
  );
  await delay(process.env.TMUX_GPUI_TEST_BINARY ? 15000 : 100);
  if (native && !nativeOutput.includes("unavailable applied"))
    throw new Error("Native UI did not consume disconnect");
} finally {
  for (const child of [helper, native])
    if (child && child.exitCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
