/** Real isolated daemon -> Rust qualification. No Node terminal subscription/replica. */
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { createPreviewCatalog } from "./catalog.ts";
import { issueDirectTerminal } from "./direct-terminal.ts";

const binary = process.env.TMUX_GPUI_DIRECT_PROBE;
assert(binary, "Set TMUX_GPUI_DIRECT_PROBE to the built tmux_direct_probe example");
const projection = process.env.TMUX_GPUI_DIRECT_PROJECTION === "1";
assert(!projection || !process.env.TMUX_GPUI_DIRECT_INTERACTIVE, "Projection probe is read-only");
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-direct",
  windowsPerSession: 1,
  ...(projection
    ? {
        initialPaneCommand: {
          executable: process.execPath,
          args: [
            "-e",
            "for(let i=0;i<350;i++)process.stdout.write('HISTORY '+i+'\\r\\n');process.stdout.write('\\x1b[?1049h');let n=0;setInterval(()=>process.stdout.write('\\x1b[H'+String(n++).padStart(6,'0')),250);",
          ],
        },
      }
    : { initialPaneMarker: "RIG_DIRECT_PROBE" }),
});
let daemon, catalog, child;
try {
  daemon = await startDaemon(
    fleet,
    process.env.TMUX_GPUI_TEST_CLI ? { cliPath: process.env.TMUX_GPUI_TEST_CLI } : undefined,
  );
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "native-direct-setup",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  assert(server);
  catalog = createPreviewCatalog({
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope: { serverId: server.serverId, generation: server.generation },
  });
  const sessions = await catalog.sessions();
  const session = sessions.find((s) => s.sessionName === fleet.sessionNames[0]);
  assert(session);
  const [config] = await catalog.panes(session.liveSessionId);
  assert(config);
  const handoff = await issueDirectTerminal(
    config,
    process.env.TMUX_GPUI_DIRECT_INTERACTIVE ? "interactive" : "read-only",
    new globalThis.AbortController().signal,
  );
  assert(!JSON.stringify(handoff).includes(options.ownerToken));
  child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  const completion = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (data) => {
    errors = (errors + data).slice(-4096);
  });
  child.stdin.end(JSON.stringify(handoff));
  const commits = [];
  for await (const line of createInterface({ input: child.stdout })) {
    const result = JSON.parse(line);
    commits.push(result);
    if (!projection && !process.env.TMUX_GPUI_DIRECT_INTERACTIVE && commits.length < 3)
      fleet.typeInPane(fleet.sessionNames[0], `printf 'DIRECT_UPDATE_${commits.length}\\n'`);
  }
  const [code] = await completion;
  assert.equal(code, 0, errors);
  if (process.env.TMUX_GPUI_DIRECT_INTERACTIVE) {
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0], {
      inputAcknowledgements: 2,
      controlledOutput: true,
      coherent: true,
    });
  } else {
    assert(commits.length >= 3);
    assert(commits.every((c, i) => i === 0 || c.revision > commits[i - 1].revision));
  }
  if (projection) {
    assert(
      commits.every((c) => c.alternateScreen === true && c.deferredHistoryRows >= 300),
      "Rust must commit alternate-screen projections with deferred history",
    );
  }
  console.log(
    JSON.stringify({ passed: true, projection, directRustCommits: commits.length, commits }),
  );
} finally {
  child?.kill();
  catalog?.dispose();
  await daemon?.stop();
  await fleet.dispose();
}
