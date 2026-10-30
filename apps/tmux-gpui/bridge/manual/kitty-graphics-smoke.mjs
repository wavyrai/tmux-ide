// Opt-in kitty graphics check against an owned daemon and tmux socket.
//
// A pane prints a Unicode-placeholder image and a cursor-anchored image; the
// live helper must publish both placements and stream the exact image bytes
// once. A second helper that already holds the digest (GUI reattach) receives
// placements but no bytes; after it reports the image missing it pulls the
// bytes again from the daemon's store. Set TMUX_IDE_KITTY_SMOKE_TMUX to a directory holding the
// patched tmux to also verify in-order acknowledgements.
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { Buffer } from "node:buffer";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../../packages/daemon-client/src/tmux-server-client.ts";
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
        ...Array.from({ length: width }, (_, x) => Buffer.of(x * 8, y * 8, 200)),
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

const image = png(32, 16);
const digest = createHash("sha256").update(image).digest("hex").slice(0, 32);
const ESC = "\x1b";
const apc = (control, payload = "") => `${ESC}_G${control};${payload}${ESC}\\`;
const D = ["̅", "̍", "̎", "̐"];
const row = (r) => [0, 1, 2, 3].map((c) => "\u{10EEEE}" + D[r] + D[c]).join("");
const sequence =
  "PLACEHOLDER\r\n" +
  apc("a=t,f=100,i=9,q=2", image.toString("base64")) +
  apc("a=p,U=1,i=9,c=4,r=2,q=2") +
  `${ESC}[38;5;9m${row(0)}\r\n${row(1)}${ESC}[39m\r\n` +
  "CURSOR " +
  apc("a=T,f=100,i=7,c=4,r=1,q=2", image.toString("base64")) +
  "\r\nDONE\r\n";

const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-kitty" });
let daemon, client;
const helpers = [];
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function startHelper(config, known = "") {
  const helper = {
    events: [],
    chunks: [],
    diagnostic: "",
    process: spawn(
      process.execPath,
      ["--import", "tsx", resolve("apps/tmux-gpui/bridge/live.ts"), config, "--interactive"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TMUX_IDE_KITTY_KNOWN: known },
      },
    ),
  };
  helpers.push(helper);
  helper.process.stderr.on("data", (b) => (helper.diagnostic += b.toString()));
  let buffer = "";
  helper.process.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.kittyImageChunk) helper.chunks.push(event.kittyImageChunk);
      else helper.events.push(event);
    }
  });
  // The window reports presence before a helper publishes interactive state.
  helper.process.stdin.write(
    JSON.stringify({ kind: "presence", active: true, revision: 1 }) + "\n",
  );
  return helper;
}

const wait = async (helper, predicate, label) => {
  const end = Date.now() + 20000;
  while (!predicate()) {
    if (helper.process.exitCode != null) throw new Error(`Helper exited: ${helper.diagnostic}`);
    if (Date.now() > end)
      throw new Error(
        `${label} deadline: ${helper.diagnostic} events=${helper.events.length} last=${JSON.stringify({ surfaces: helper.events.at(-1)?.surfaces?.length, graphics: helper.events.at(-1)?.graphics })}`,
      );
    await new Promise((r) => setTimeout(r, 20));
  }
};
const placements = (helper) => helper.events.at(-1)?.graphics?.[0]?.placements ?? [];
const assembled = (helper) =>
  Buffer.concat(
    helper.chunks
      .filter((c) => c.digest === digest)
      .sort((a, b) => a.offset - b.offset)
      .map((c) => Buffer.from(c.data, "base64")),
  );

try {
  const pane = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  await writeFile(fleet.root + "/image.seq", sequence);
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-kitty-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  const scope = { serverId: server.serverId, generation: server.generation };
  client = createTmuxServerClient(options, scope);
  const session = (await client.sessions()).sessions[0];
  const opened = await client.openSession(session.liveSessionId);
  const ids = (await client.inventory(opened.workspaceName)).resource.semanticPaneIds;
  const config = fleet.root + "/kitty.json";
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
  const first = startHelper(config);
  await wait(first, () => first.events.at(-1)?.surfaces?.length === 1, "seed");
  tmux("send-keys", "-t", pane, "-l", `clear; cat ${fleet.root}/image.seq`);
  tmux("send-keys", "-t", pane, "Enter");
  await wait(first, () => placements(first).length === 2, "placements");
  await wait(first, () => assembled(first).length === image.length, "bytes");
  assert.deepEqual(assembled(first), image);
  const [placeholder, cursor] = placements(first);
  assert.deepEqual(
    { ...placeholder, row: undefined, image: undefined },
    {
      digest,
      row: undefined,
      image: undefined,
      column: 0,
      rows: 2,
      columns: 4,
      sourceRow: 0,
      sourceColumn: 0,
      totalRows: 2,
      totalColumns: 4,
    },
  );
  assert.equal(cursor.digest, digest);
  assert.match(placeholder.image, /#9$/u, "placements name the program's image");
  assert.equal(cursor.column, "CURSOR ".length);
  assert.equal(cursor.row, placeholder.row + 2);
  const chunksSent = first.chunks.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(first.chunks.length, chunksSent, "each digest is pulled once per helper");

  // GUI reattach with the image already held: placements, no bytes.
  first.process.kill("SIGTERM");
  const second = startHelper(config, digest);
  // Placeholder images are grid text and survive the reattach reseed; cursor
  // placements are best effort (tmux never saw them) and may not.
  await wait(
    second,
    () => placements(second).some((p) => p.columns === 4 && p.rows === 2),
    "reattach placements",
  );
  const cursorSurvived = placements(second).length === 2;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(second.chunks.length, 0);
  // A window that lost the image pulls it again from the daemon's store.
  second.process.stdin.write(JSON.stringify({ kind: "kitty-missing", digests: [digest] }) + "\n");
  await wait(second, () => assembled(second).length === image.length, "re-pull");
  assert.deepEqual(assembled(second), image);

  const option = (() => {
    try {
      return tmux("show-options", "-gv", "kitty-graphics");
    } catch {
      return "unsupported";
    }
  })();
  const environment = tmux("show-environment", "-g", "TMUX_IDE_GRAPHICS");
  assert.equal(environment, "TMUX_IDE_GRAPHICS=kitty");
  if (process.env.TMUX_IDE_KITTY_SMOKE_TMUX) assert.equal(option, "on");
  console.log(
    JSON.stringify({
      passed: true,
      tmux: tmux("-V"),
      kittyGraphicsOption: option,
      imageBytes: image.length,
      chunks: chunksSent,
      reattachWithoutBytes: true,
      cursorPlacementSurvivedReattach: cursorSurvived,
      repulledAfterMissing: true,
    }),
  );
} finally {
  client?.dispose();
  for (const helper of helpers)
    if (helper.process.exitCode === null) {
      const done = once(helper.process, "close");
      helper.process.kill("SIGTERM");
      await done;
    }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
