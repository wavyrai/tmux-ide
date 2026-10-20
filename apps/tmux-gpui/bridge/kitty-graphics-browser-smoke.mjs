// Opt-in kitty graphics check of the product bridge path (browser.ts) against
// an owned daemon and scratch tmux. A two-pane window shows a placeholder
// image in its right pane; the publication must carry the placement in
// window-canvas cells and the image bytes as ordered chunk lines.
//
// TMUX_GPUI_TEST_BINARY pipes the bridge into a dev native binary
// (`--tmux-browser-stdio`) and requires it to accept every line; with
// TMUX_GPUI_KITTY_SCREENSHOT=<absent absolute .png> it also captures the
// window (needs an unlocked desktop).
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { Buffer } from "node:buffer";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import assert from "node:assert/strict";

if (process.env.TMUX_IDE_KITTY_SMOKE_TMUX)
  process.env.PATH = `${process.env.TMUX_IDE_KITTY_SMOKE_TMUX}:${process.env.PATH}`;

function png(width, height) {
  const rows = Buffer.concat(
    Array.from({ length: height }, (_, y) =>
      Buffer.concat([
        Buffer.of(0),
        ...Array.from({ length: width }, (_, x) => {
          const ring = Math.floor(Math.hypot(x - width / 2, y - height / 2) / 6) % 2;
          return Buffer.of((x * 255) / width, (y * 255) / height, ring ? 255 : 90);
        }),
      ]),
    ),
  );
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// TMUX_IDE_KITTY_SMOKE_SIZE=1920x1080 exercises multi-chunk pacing.
const [width, height] = (process.env.TMUX_IDE_KITTY_SMOKE_SIZE ?? "240x160").split("x").map(Number);
const image = png(width, height);
const digest = createHash("sha256").update(image).digest("hex").slice(0, 32);
const ESC = "\x1b";
const apc = (control, payload = "") => `${ESC}_G${control};${payload}${ESC}\\`;
const DIACRITICS = "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357"
  .split(" ")
  .map((hex) => String.fromCodePoint(parseInt(hex, 16)));
const COLUMNS = 16;
const ROWS = 6;
const base64 = image.toString("base64");
const parts = Math.ceil(base64.length / 4096);
const transfer = Array.from({ length: parts }, (_, i) =>
  apc(
    (i === 0 ? "a=t,f=100,i=9,q=2," : "") + (i < parts - 1 ? "m=1" : "m=0"),
    base64.slice(i * 4096, (i + 1) * 4096),
  ),
).join("");
const sequence =
  "IMAGE\r\n" +
  transfer +
  apc(`a=p,U=1,i=9,c=${COLUMNS},r=${ROWS},q=2`) +
  Array.from(
    { length: ROWS },
    (_, r) =>
      `${ESC}[38;5;9m` +
      Array.from({ length: COLUMNS }, (_, c) => "\u{10EEEE}" + DIACRITICS[r] + DIACRITICS[c]).join(
        "",
      ) +
      `${ESC}[39m`,
  ).join("\r\n") +
  "\r\nDONE\r\n";

const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-kbrowse" });
let daemon, browser, native;
const events = [];
const chunks = [];
let stderr = "";
let nativeStderr = "";
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
const until = async (predicate, label) => {
  const end = Date.now() + 60000;
  while (!predicate()) {
    if (browser?.exitCode != null) throw new Error("Browser exited: " + stderr);
    if (native?.exitCode != null) throw new Error("Native exited: " + nativeStderr);
    if (Date.now() > end) throw new Error(`${label} deadline: ${stderr}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  const first = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  const right = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
  await writeFile(fleet.root + "/image.seq", sequence);
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-kitty-browser-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
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
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...fleet.environment } },
  );
  browser.stderr.on("data", (b) => (stderr += b.toString()));
  let buffer = "";
  browser.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.kittyImageChunk) chunks.push(event.kittyImageChunk);
      else events.push(event);
    }
  });
  if (process.env.TMUX_GPUI_TEST_BINARY) {
    native = spawn(process.env.TMUX_GPUI_TEST_BINARY, ["--tmux-browser-stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...fleet.environment },
    });
    native.stderr.on("data", (b) => (nativeStderr += b.toString()));
    browser.stdout.pipe(native.stdin);
    native.stdin.on("error", () => {});
  }
  send({ type: "presence", active: true, revision: 1 });
  await until(() => events.some((e) => e.sessions?.length === 1), "catalog");
  send({ type: "session", request: 1, id: events.at(-1).sessions[0].id });
  await until(() => events.at(-1)?.request === 1 && events.at(-1)?.panes.length === 2, "panes");
  // Either pane selects the window; the canvas holds both.
  const selected = events.at(-1).panes[0].id;
  send({ type: "pane", request: 2, id: selected });
  await until(() => events.some((e) => e.request === 2 && e.snapshot && e.inputReady), "ready");
  tmux("send-keys", "-t", right, "-l", `clear; cat ${fleet.root}/image.seq`);
  tmux("send-keys", "-t", right, "Enter");
  await until(() => events.at(-1)?.graphics?.length === 1, "graphics");
  const total = () =>
    chunks
      .filter((c) => c.digest === digest)
      .reduce((sum, c) => sum + Buffer.byteLength(c.data, "base64"), 0);
  await until(() => total() === image.length, "bytes");
  const placement = events.at(-1).graphics[0];
  // The image is in the right-hand pane: its placement starts at that pane's
  // canvas column, not at column 0.
  const region = events.at(-1).regions.find((r) => r.left > 0);
  assert.ok(region, "two-pane canvas");
  assert.equal(placement.digest, digest);
  assert.equal(placement.column, region.left, "placement moved to the pane's canvas column");
  assert.deepEqual(
    [placement.rows, placement.columns, placement.totalRows, placement.totalColumns],
    [ROWS, COLUMNS, ROWS, COLUMNS],
  );
  const assembled = Buffer.concat(
    chunks
      .filter((c) => c.digest === digest)
      .sort((a, b) => a.offset - b.offset)
      .map((c) => Buffer.from(c.data, "base64")),
  );
  assert.deepEqual(assembled, image);
  let screenshot = null;
  if (native) {
    await new Promise((r) => setTimeout(r, 3000));
    assert.doesNotMatch(nativeStderr, /rejected|stream ended/u, nativeStderr);
    const target = process.env.TMUX_GPUI_KITTY_SCREENSHOT;
    if (target) {
      execFileSync("screencapture", ["-x", "-o", target]);
      screenshot = target;
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      tmux: tmux("-V"),
      canvasColumn: placement.column,
      imageBytes: image.length,
      chunkLines: chunks.length,
      nativeAccepted: !!native,
      screenshot,
    }),
  );
} finally {
  for (const child of [native, browser])
    if (child && child.exitCode === null) {
      const done = once(child, "close");
      child.kill("SIGTERM");
      await done;
    }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
