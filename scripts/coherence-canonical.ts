/** Opt-in correctness qualification; no timing acceptance or performance claims. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createScratchFleet } from "./lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "./lib/product-fixtures/daemon.ts";
import { openPaneStreamRuntimeClient } from "../packages/daemon-client/src/pane-stream-client.ts";
import { createOpenTuiPaneStreamSocket } from "../packages/daemon/src/tui/mirror/open-tui-pane-stream-socket.ts";
import { defaultNodePtyAdapter } from "../packages/daemon/src/terminal/NodePtyAdapter.ts";
import { decodeNativeGridCapture } from "../packages/daemon/src/terminal/mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../packages/daemon/src/terminal/mirror/native-grid-projection.ts";
import { inspectCoherenceTrace } from "./lib/coherence-trace.mjs";
import { createMacProcessIdentity } from "./lib/owned-ssh-fixture.mjs";
import { subscribeTmuxServerInteractions } from "../packages/daemon-client/src/tmux-server-interaction-events.ts";
import { TmuxServersResourceSchemaZ } from "../packages/contracts/src/tmux-server-scope.ts";
import { CoherenceDeliveryClient } from "./lib/coherence-delivery-client.ts";
import type { TerminalReplicaRow } from "../packages/contracts/src/index.ts";

import { PANE_STREAM_PROTOCOL_VERSION } from "../packages/contracts/src/pane-stream.ts";

const output = resolve(process.argv[2] ?? ".tasks/canonical-coherence");
mkdirSync(output, { mode: 0o700 }); // Existing evidence must never be overwritten.
const native = realpathSync(process.env.TMUX_IDE_C4_TMUX_BINARY ?? "");
// This process is a disposable qualification runner. Never inherit live session authority.
for (const key of Object.keys(process.env)) {
  if (key === "TMUX" || key.startsWith("TMUX_") || key === "NODE_OPTIONS" || key === "NODE_PATH")
    delete process.env[key];
}
process.env.TMUX_IDE_NATIVE_OBSERVATION = "1";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const nativeHash = sha(native);
const controlledTmux = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
assert.equal(controlledTmux, native, "PATH must resolve the exact pinned native artifact");
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", timeout: 5000 }).trim();
const requireDaemon = createRequire(resolve("packages/daemon/package.json"));
const artifactPaths = [
  native,
  realpathSync(process.execPath),
  resolve("bin/cli.js"),
  resolve("pnpm-lock.yaml"),
  resolve("node_modules/.modules.yaml"),
  ...["node-pty", "ws", "zod", "hono"].map((name) => realpathSync(requireDaemon.resolve(name))),
];
const provenance = () => ({
  commit: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain", "--untracked-files=all"),
  artifacts: Object.fromEntries(artifactPaths.map((path) => [path, sha(path)])),
});
const before = provenance();
assert.equal(before.dirty, "", "Commit source and deterministic CLI artifact before qualification");
const records = 500;
const shapes = Array.from({ length: 20 }, (_, i) => [80 + i * 2, 25 + (i % 7)] as const);
const producer = join(output, "producer.cjs");
writeFileSync(
  producer,
  `process.stdin.setRawMode(true);let started=false;process.stdout.write('READY\\r\\n');process.stdin.on('data',()=>{if(started)return;started=true;process.stdout.write('\\x1b[?1049hALT\\x1b[?1049l');let i=0;const t=setInterval(()=>{process.stdout.write('REC_'+String(i++).padStart(4,'0')+'\\r\\n');if(i===500){clearInterval(t);process.stdout.write('\\x1b[38;5;196mCOLOR\\x1b[0m 界é\\r\\n\\x1b[?2004h\\x1b[?1h\\x1b=DONE_C4');}},2);});`,
);
const manifest = {
  source,
  provenance: before,
  native,
  nativeHash,
  records,
  shapes,
  clients: [2, 4, 8],
  node: process.version,
  producerHash: sha(producer),
  driverHash: sha(import.meta.filename),
};
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(
  label: string,
  test: () => boolean | Promise<boolean>,
  errors: Error[],
  ms = 15000,
) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (errors.length) throw errors[0];
    if (await test()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}
const text = (rows: readonly TerminalReplicaRow[]) =>
  rows
    .map((r) =>
      r.cells
        .map((c) => (c.width === 0 ? "" : c.grapheme || " "))
        .join("")
        .trimEnd(),
    )
    .join("\n");
const paint = (rows: readonly TerminalReplicaRow[]) =>
  rows.map((r) =>
    r.cells.map((c) => [c.grapheme, c.width, c.foreground, c.background, c.attributes]),
  );
const results: unknown[] = [];
let disposeIdentity: (() => Promise<void>) | undefined;
const identity = await createMacProcessIdentity({
  parent: output,
  onAllocated: (allocation: { disposeFiles: () => Promise<void> }) => {
    disposeIdentity = allocation.disposeFiles;
  },
});
let qualificationFailure: unknown;
try {
  for (const count of [2, 4, 8]) {
    let fleet: Awaited<ReturnType<typeof createScratchFleet>> | undefined;
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let pty: ReturnType<typeof defaultNodePtyAdapter.spawnSync> | undefined;
    const clients: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>>[] = [];
    const decoders: CoherenceDeliveryClient[] = [];
    const errors: Error[] = [];
    const cleanup: Record<string, string> = {};
    let serverPid = 0;
    let serverStart: string | null = null;
    let socketIdentity: { dev: number; ino: number } | undefined;
    let ptyExited = false;
    let observation: ReturnType<typeof subscribeTmuxServerInteractions> | undefined;
    let observationClosed = false;
    let receiptCount = 0;
    const tracePath = join(output, `clients-${count}-runtime.jsonl`);
    writeFileSync(tracePath, "", { flag: "wx", mode: 0o600 });
    const traceCheckpoints: Record<string, ReturnType<typeof inspectCoherenceTrace>> = {};
    let finalHash: string | null = null;
    const traceSnapshot = (complete = false) =>
      inspectCoherenceTrace(readFileSync(tracePath, "utf8"), {
        clients: count,
        finalHash,
        complete,
      });
    let facts: unknown = null;
    let failureProbe: unknown = null;
    const tmux = (...args: string[]) =>
      execFileSync(native, ["-S", fleet!.socketPath, ...args], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 16 << 20,
        env: { ...process.env, TMUX: "" },
      });
    try {
      fleet = await createScratchFleet({
        sessions: 1,
        windowsPerSession: 1,
        slug: `coherence-${count}`,
        initialPaneCommand: { executable: process.execPath, args: [producer] },
      });
      serverPid = Number(tmux("display-message", "-p", "#{pid}").trim());
      serverStart = await identity.identify(serverPid);
      const socket = lstatSync(fleet.socketPath);
      assert(socket.isSocket() && socket.uid === process.getuid!());
      socketIdentity = { dev: socket.dev, ino: socket.ino };
      assert(serverPid > 0 && serverStart);
      const session = fleet.sessionNames[0]!;
      const runtimePane = fleet.initialPanes[0]!.paneId;
      tmux("set-option", "-g", "history-limit", "10000");
      tmux("set-option", "-t", session, "status", "off");
      tmux("set-window-option", "-t", session, "window-size", "latest");
      process.env.TMUX_IDE_SESSION_RUNTIME_TRACE_LOG = tracePath;
      daemon = await startDaemon(fleet);
      assert.deepEqual(provenance(), before, "Mandatory daemon rebuild changed frozen artifacts");
      const workspace = await daemon.promote(session);
      const response = await fetch(`${daemon.baseUrl}/api/v1/tmux-servers`, {
        headers: { Authorization: `Bearer ${daemon.record.authToken}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      assert(response.ok, "Server inventory unavailable");
      const servers = TmuxServersResourceSchemaZ.parse(await response.json()).servers;
      assert.equal(servers.length, 1, "Scratch fixture must contain exactly one server");
      const server = servers[0]!;
      assert(server.state === "online");
      observation = subscribeTmuxServerInteractions({
        baseUrl: daemon.baseUrl,
        ownerToken: daemon.record.authToken,
        server: { serverId: server.serverId, generation: server.generation },
        onBatch: (batch) => {
          receiptCount += batch.receipts.length;
        },
      });
      void observation.done.catch((error) => {
        if (!observationClosed) errors.push(error);
      });
      await observation.ready;
      await waitFor(
        "native journal ready",
        () => observation!.getObservationStatus()?.method === "native-journal",
        errors,
      );
      const initialObservation = observation.getObservationStatus();
      const pane = tmux("show-options", "-p", "-v", "-t", runtimePane, "@tmux_ide_pane_id").trim();
      assert(pane);
      for (let i = 0; i < count; i++) {
        let client: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>> | undefined;
        const earlyAcks: Parameters<CoherenceDeliveryClient["sendAck"]>[0][] = [];
        const decoder = new CoherenceDeliveryClient(workspace, pane, (ack) =>
          client ? client.ack(ack) : earlyAcks.push(ack),
        );
        client = await openPaneStreamRuntimeClient({
          baseUrl: daemon.baseUrl,
          ownerToken: daemon.record.authToken,
          daemonInstanceId: daemon.record.instanceId,
          origin: "tmux-ide://opentui",
          hostClientId: `coherence:${count}:${i}`,
          requestId: randomUUID(),
          requestInitialInputAuthority: false,
          stream: {
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            workspaceName: workspace,
            panes: [pane],
            viewerMode: "read-only",
            terminalDelivery: {
              protocolVersions: [1],
              encodings: ["semantic-v1"],
              richPlacements: false,
            },
          },
          createSocket: createOpenTuiPaneStreamSocket,
          onNegotiated: (_pane, result) => decoder.negotiate(result),
          onTerminalDelivery: (_pane, message) => {
            try {
              decoder.receive(message);
            } catch (e) {
              errors.push(e as Error);
            }
          },
          onFault: (e) => errors.push(e),
        });
        clients.push(client);
        decoders.push(decoder);
        earlyAcks.forEach((ack) => client!.ack(ack));
      }
      await waitFor("initial decoded clients", () => decoders.every((d) => d.commits > 0), errors);
      pty = defaultNodePtyAdapter.spawnSync(
        {
          shell: native,
          args: ["-S", fleet.socketPath, "attach", "-t", `=${session}`],
          cwd: fleet.projectDir,
          cols: 100,
          rows: 30,
          env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
          name: "xterm-256color",
          encoding: null,
        },
        {
          onData: () => undefined,
          onExit: () => {
            ptyExited = true;
          },
        },
      );
      const slowBaseline = decoders.at(-1)!.commits;
      decoders.at(-1)!.hold();
      tmux("send-keys", "-t", runtimePane, "g");
      for (const [cols, rows] of shapes) {
        pty.resize(cols, rows);
        await sleep(5);
      }
      await waitFor(
        "healthy clients reach final output",
        () =>
          decoders
            .slice(0, -1)
            .every((d) => text(d.state!.canonicalSnapshot!.grid).includes("DONE_C4")),
        errors,
      );
      const slowCommits = decoders.at(-1)!.commits;
      assert(decoders.at(-1)!.acknowledgementHeld, "Slow client never held an ACK");
      assert.equal(slowCommits, slowBaseline + 1, "Slow client advanced beyond its held ACK");
      assert(
        !text(decoders.at(-1)!.state!.canonicalSnapshot!.grid).includes("DONE_C4"),
        "Workload failed to exercise a client stalled before final output",
      );
      traceCheckpoints.stalled = traceSnapshot();
      decoders.at(-1)!.release();
      await waitFor(
        "all clients converge",
        () =>
          decoders.every((d) => text(d.state!.canonicalSnapshot!.grid).includes("DONE_C4")) &&
          new Set(decoders.map((d) => d.state!.appliedHash)).size === 1,
        errors,
      );
      const raw = tmux("capture-pane", "-p", "-R", "-S", "-", "-t", runtimePane);
      const oracle = decodeNativeGridCapture(raw);
      assert(oracle && oracle.version === 2, "Invalid native oracle");
      const modeFormats = {
        alternateScreen: "alternate_on",
        applicationCursor: "keypad_cursor_flag",
        applicationKeypad: "keypad_flag",
        bracketedPaste: "bracket_paste_flag",
        insert: "insert_flag",
        origin: "origin_flag",
        wraparound: "wrap_flag",
        mouseTracking: "mouse_any_flag",
        synchronizedOutput: "synchronized_output_flag",
      };
      const modeValues = tmux(
        "display-message",
        "-p",
        "-t",
        runtimePane,
        [...Object.values(modeFormats), "cursor_flag"].map((key) => `#{${key}}`).join("|"),
      )
        .trim()
        .split("|");
      assert.equal(modeValues.length, Object.keys(modeFormats).length + 1);
      assert(
        modeValues.every((value) => value === "0" || value === "1"),
        "Native mode oracle unavailable",
      );
      assert.equal(
        tmux(
          "display-message",
          "-p",
          "-t",
          runtimePane,
          "#{mouse_any_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}",
        ).trim(),
        "0|0|0",
        "Producer unexpectedly enabled mouse reporting",
      );
      const oracleModes = {
        ...Object.fromEntries(
          Object.keys(modeFormats).map((key, index) => [key, modeValues[index] === "1"]),
        ),
        mouseProtocol: "none",
        mouseEncoding: "default",
      };
      assert.equal(oracleModes.bracketedPaste, true, "Producer mode probe did not execute");
      assert.equal(oracleModes.applicationCursor, true);
      assert.equal(oracleModes.applicationKeypad, true);
      const [cols, windowRows] = shapes.at(-1)!;
      const geometry = tmux(
        "display-message",
        "-p",
        "-t",
        runtimePane,
        "#{window_width}|#{window_height}|#{pane-border-status}|#{status}",
      )
        .trim()
        .split("|");
      assert.equal(Number(geometry[0]), cols);
      assert.equal(Number(geometry[1]), windowRows, "Owning PTY final geometry was not applied");
      assert.equal(geometry[3], "off", "Fixture unexpectedly gained a status line");
      assert(["off", "top", "bottom"].includes(geometry[2]!));
      // Workspace promotion installs a pane header; that row belongs to tmux chrome.
      const rows = windowRows - (geometry[2] === "off" ? 0 : 1);
      assert.equal(oracle.cols, cols);
      assert.equal(oracle.rows, rows);
      const oracleGrid = oracle.grid
        .slice(oracle.history)
        .map((row) => projectNativeGridRow(row, oracle.cols)!);
      for (const decoder of decoders) {
        const snapshot = decoder.state!.canonicalSnapshot!;
        assert.equal(snapshot.cols, cols);
        assert.equal(snapshot.rows, rows);
        assert.deepEqual(paint(snapshot.grid), paint(oracleGrid));
        const ids = text([...snapshot.history, ...snapshot.grid]).match(/REC_\d{4}/g);
        assert.deepEqual(
          ids,
          Array.from({ length: records }, (_, i) => `REC_${String(i).padStart(4, "0")}`),
        );
        assert.deepEqual([snapshot.cursor.x, snapshot.cursor.y], oracle.cursor);
        assert.deepEqual(snapshot.modes, oracleModes);
        assert.equal(snapshot.cursor.hidden, modeValues.at(-1) === "0");
      }
      assert.deepEqual(
        observation.getObservationStatus()?.lastGap,
        initialObservation?.lastGap,
        "Native observation recorded a new gap during the workload",
      );
      assert.equal(
        observation.getObservationStatus()?.droppedCount,
        initialObservation?.droppedCount,
      );
      finalHash = decoders[0]!.state!.appliedHash;
      await waitFor(
        "all final acknowledgements recorded by daemon",
        () => {
          const metrics = traceSnapshot();
          return metrics.finalSettledClients === count && metrics.settledWithoutFlights;
        },
        errors,
      );
      traceCheckpoints.converged = traceSnapshot();
      facts = {
        count,
        initialObservation,
        finalObservation: observation.getObservationStatus(),
        receiptCount,
        traceCheckpoints,
        slowCommitsBeforeRelease: slowCommits,
        hashes: decoders.map((d) => d.state!.appliedHash),
        commits: decoders.map((d) => d.commits),
        oracleModes,
        geometry,
        windowRows,
        nativeDigest: createHash("sha256").update(raw).digest("hex"),
        cols,
        rows,
        records,
      };
    } catch (error) {
      errors.push(error as Error);
      if (daemon)
        writeFileSync(join(output, `clients-${count}-daemon.log`), daemon.output().slice(-65536), {
          mode: 0o600,
        });
      if (fleet) {
        try {
          failureProbe = {
            panes: tmux(
              "list-panes",
              "-a",
              "-F",
              "#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_pid}|#{pane_current_command}|#{pane_width}|#{pane_height}",
            ),
            output: tmux("capture-pane", "-p", "-S", "-20", "-t", fleet.initialPanes[0]!.paneId),
            observation: observation?.getObservationStatus(),
          };
        } catch (probeError) {
          failureProbe = {
            unavailable: probeError instanceof Error ? probeError.message : String(probeError),
          };
        }
      }
    } finally {
      for (const client of clients) {
        try {
          client.close();
        } catch (error) {
          errors.push(error as Error);
        }
      }
      if (observation) {
        observationClosed = true;
        observation.close();
        try {
          await observation.done;
          cleanup.observation = "confirmed";
        } catch (error) {
          errors.push(error as Error);
        }
      }
      if (pty) {
        try {
          if (!ptyExited) pty.kill();
          await waitFor("PTY exit", () => ptyExited, [], 5000);
          assert.equal(await identity.identify(pty.pid), null, "PTY process remains alive");
          cleanup.pty = "confirmed";
        } catch (e) {
          errors.push(e as Error);
        }
      }
      if (daemon) {
        try {
          await daemon.stop();
          cleanup.daemon = "confirmed";
          if (finalHash) traceCheckpoints.flushed = traceSnapshot(true);
        } catch (e) {
          errors.push(e as Error);
        }
      }
      if (fleet) {
        try {
          assert.equal(
            await identity.identify(serverPid),
            serverStart,
            "Private server identity changed before cleanup",
          );
          const socket = lstatSync(fleet.socketPath);
          assert(socket.isSocket() && socket.uid === process.getuid!());
          assert.deepEqual(
            { dev: socket.dev, ino: socket.ino },
            socketIdentity,
            "Private socket identity changed before cleanup",
          );
          assert.equal(Number(tmux("display-message", "-p", "#{pid}").trim()), serverPid);
          tmux("kill-server");
          await waitFor(
            "server exit",
            async () => (await identity.identify(serverPid)) === null,
            [],
            5000,
          );
          cleanup.server = "confirmed";
          rmSync(fleet.root, { recursive: true, force: true });
        } catch (e) {
          errors.push(e as Error);
          cleanup.server = "failed";
        }
      }
      try {
        assert.equal(sha(native), nativeHash);
      } catch (error) {
        errors.push(error as Error);
      }
      const report = {
        count,
        facts,
        failureProbe,
        cleanup,
        failures: errors.map((e) => ({ name: e.name, message: e.message })),
      };
      results.push(report);
      writeFileSync(join(output, `clients-${count}.json`), JSON.stringify(report, null, 2));
    }
    if (errors.length)
      throw new AggregateError(errors, `Coherence ${count} failed; retained evidence`);
  }
} catch (error) {
  qualificationFailure = error;
} finally {
  try {
    assert.deepEqual(provenance(), before, "Qualification source or artifacts changed");
  } catch (error) {
    qualificationFailure = new AggregateError(
      [...(qualificationFailure ? [qualificationFailure] : []), error],
      "Qualification identity changed",
    );
  }
  try {
    await disposeIdentity?.();
  } catch (error) {
    qualificationFailure = qualificationFailure
      ? new AggregateError(
          [qualificationFailure, error],
          "Qualification and identity cleanup failed",
        )
      : error;
  }
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(
      {
        completed: !qualificationFailure,
        manifest,
        results,
        failure: qualificationFailure instanceof Error ? qualificationFailure.message : null,
      },
      null,
      2,
    ),
  );
}
if (qualificationFailure) throw qualificationFailure;
writeFileSync(join(output, "complete.json"), JSON.stringify({ manifest, results }, null, 2));
