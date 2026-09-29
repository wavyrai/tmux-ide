import { collectStockOracle } from "./collect-stock.mjs";
import { verifyStockSemanticSnapshot } from "./semantic-oracle.mjs";
import {
  admitStockCapabilities,
  assertStockObservation,
  stockObservationDiagnostics,
} from "./stock-admission.mjs";
import { admit } from "./admission.mjs";
import { fenceNativeTmuxCommand } from "./source/packages/daemon/src/lib/tmux-server-generation-runner.ts";
const admitted = admit(process.argv[3]);
/** Opt-in correctness qualification; no timing acceptance or performance claims. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createScratchFleet } from "./scratch-fleet.ts";
import { startDaemon } from "./daemon.ts";
import { openPaneStreamRuntimeClient } from "./source/packages/daemon-client/src/pane-stream-client.ts";
import { createOpenTuiPaneStreamSocket } from "./source/packages/daemon/src/tui/mirror/open-tui-pane-stream-socket.ts";
import { defaultNodePtyAdapter } from "./source/packages/daemon/src/terminal/NodePtyAdapter.ts";
import { inspectCoherenceTrace } from "./source/scripts/lib/coherence-trace.mjs";
import { createLinuxProcessIdentity } from "../linux-identity.mjs";
import { subscribeTmuxServerInteractions } from "./source/packages/daemon-client/src/tmux-server-interaction-events.ts";
import { TmuxServersResourceSchemaZ } from "./source/packages/contracts/src/tmux-server-scope.ts";
import { CoherenceDeliveryClient } from "./source/scripts/lib/coherence-delivery-client.ts";
import type { TerminalReplicaRow } from "./source/packages/contracts/src/index.ts";

import { PANE_STREAM_PROTOCOL_VERSION } from "./source/packages/contracts/src/pane-stream.ts";

const output = resolve(process.argv[2] ?? ".tasks/canonical-coherence");
mkdirSync(output, { mode: 0o700 }); // Existing evidence must never be overwritten.
const tmuxBinary = admitted.native;
// This process is a disposable qualification runner. Never inherit live session authority.
for (const key of Object.keys(process.env)) {
  if (key === "TMUX" || key.startsWith("TMUX_") || key === "NODE_OPTIONS" || key === "NODE_PATH")
    delete process.env[key];
}
process.env.TMUX_IDE_NATIVE_OBSERVATION = "0";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tmuxHash = sha(tmuxBinary);
const controlledTmux = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
assert.equal(controlledTmux, tmuxBinary, "PATH must resolve the exact pinned stock artifact");
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", timeout: 5000 }).trim();
const requireDaemon = createRequire(resolve("packages/daemon/package.json"));
const artifactPaths = [
  tmuxBinary,
  realpathSync(process.execPath),
  admitted.cli,
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
  mode: "stock-observation-off",
  oracleScope: "finite-producer-stock-visible-semantics",
  source,
  provenance: before,
  tmuxBinary,
  tmuxHash,
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
const results: unknown[] = [];
let disposeIdentity: (() => Promise<void>) | undefined;
const identity = await createLinuxProcessIdentity({
  descriptor: admitted.processHost,
  parent: output,
  onAllocated: (allocation: { disposeFiles: () => Promise<void> }) => {
    disposeIdentity = allocation.disposeFiles;
  },
});
let qualificationFailure: unknown;
try {
  for (const count of [2, 4, 8]) {
    let fleet: Awaited<ReturnType<typeof createScratchFleet>> | undefined;
    let allocation: { root: string; socketPath: string } | undefined;
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
      (
        inspectCoherenceTrace as (
          text: string,
          options: { clients: number; finalHash: string | null; complete: boolean },
        ) => ReturnType<typeof inspectCoherenceTrace>
      )(readFileSync(tracePath, "utf8"), {
        clients: count,
        finalHash,
        complete,
      });
    let facts: unknown = null;
    let failureProbe: unknown = null;
    let tmuxIdentity: { pid: string; startTime: string } | undefined;
    const tmux = (...args: string[]) => {
      const fenced = tmuxIdentity
        ? fenceNativeTmuxCommand(["-N", "-u", ...args], tmuxIdentity)
        : null;
      const output = execFileSync(
        tmuxBinary,
        ["-S", (fleet ?? allocation)!.socketPath, ...(fenced?.argv ?? ["-N", "-u", ...args])],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 16 << 20,
          env: { ...process.env, TMUX: "" },
        },
      );
      return fenced ? fenced.verify(output) : output;
    };
    try {
      fleet = await createScratchFleet({
        onAllocated(value) {
          allocation = value;
          writeFileSync(join(output, `clients-${count}-allocation.json`), JSON.stringify(value), {
            flag: "wx",
            mode: 0o600,
          });
        },
        async onServer(generation) {
          tmuxIdentity = generation;
          serverPid = Number(generation.pid);
          const socket = lstatSync(allocation!.socketPath);
          assert(socket.isSocket() && socket.uid === process.getuid!());
          socketIdentity = { dev: socket.dev, ino: socket.ino };
          let captureError: unknown;
          try {
            writeFileSync(
              join(output, `clients-${count}-server-attempt.json`),
              JSON.stringify({ generation, socketIdentity }),
              { flag: "wx", mode: 0o600 },
            );
          } catch (error) {
            captureError = error;
          }
          try {
            serverStart = await identity.identify(serverPid);
          } catch (error) {
            throw new AggregateError(
              captureError ? [captureError, error] : [error],
              "Owned server witness/capture failed",
            );
          }
          if (captureError) throw captureError;
          assert(serverStart);
          writeFileSync(
            join(output, `clients-${count}-server.json`),
            JSON.stringify({ generation, kernelWitness: serverStart, socketIdentity }),
            { flag: "wx", mode: 0o600 },
          );
        },
        sessions: 1,
        windowsPerSession: 1,
        slug: `coherence-${count}`,
        initialPaneCommand: { executable: process.execPath, args: [producer] },
      });
      assert.equal(Number(tmux("display-message", "-p", "#{pid}").trim()), serverPid);
      assert.equal(await identity.identify(serverPid), serverStart);
      const session = fleet.sessionNames[0]!;
      const runtimePane = fleet.initialPanes[0]!.paneId;
      const stockCapabilities = admitStockCapabilities(tmux);
      writeFileSync(
        join(output, `clients-${count}-stock-capabilities.json`),
        JSON.stringify(stockCapabilities),
        { flag: "wx", mode: 0o600 },
      );
      tmux("set-option", "-g", "history-limit", "10000");
      tmux("set-option", "-t", session, "status", "off");
      tmux("set-window-option", "-t", session, "window-size", "latest");
      process.env.TMUX_IDE_SESSION_RUNTIME_TRACE_LOG = tracePath;
      daemon = await startDaemon(fleet, identity.identify, admitted);
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
        "stock observation ready",
        () => observation!.getObservationStatus()?.method === "stock-hooks",
        errors,
      );
      const initialObservation = observation.getObservationStatus();
      assertStockObservation(initialObservation);
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
          shell: tmuxBinary,
          args: [
            "-S",
            fleet.socketPath,
            ...fenceNativeTmuxCommand(["-N", "-u", "attach", "-t", `=${session}`], tmuxIdentity!)
              .argv,
          ],
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
      const stockOracle = collectStockOracle(tmux, runtimePane);
      writeFileSync(
        join(output, `clients-${count}-stock-oracle.json`),
        JSON.stringify(stockOracle),
        { flag: "wx", mode: 0o600 },
      );
      for (const decoder of decoders)
        verifyStockSemanticSnapshot(decoder.state!.canonicalSnapshot!, stockOracle.stock);
      assertStockObservation(observation.getObservationStatus());
      const { cols, rows } = stockOracle.stock;
      const windowRows = stockOracle.evidence.windowRows;
      const geometry = [String(cols), String(windowRows), stockOracle.stock.border, "off"];
      const oracleModes = stockOracle.stock.modes;
      const partialObservation = stockObservationDiagnostics(
        initialObservation,
        observation.getObservationStatus(),
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
        partialObservation,
        traceCheckpoints,
        slowCommitsBeforeRelease: slowCommits,
        hashes: decoders.map((d) => d.state!.appliedHash),
        commits: decoders.map((d) => d.commits),
        oracleModes,
        geometry,
        windowRows,
        mode: "stock-observation-off",
        oracleScope: "finite-producer-stock-visible-semantics",
        stockCapabilities,
        stockOracleDigest: createHash("sha256").update(JSON.stringify(stockOracle)).digest("hex"),
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
      if (!fleet && allocation)
        failureProbe = {
          partialAllocation: allocation,
          serverPid,
          kernelWitness: serverStart,
          socketIdentity,
        };
      for (const client of clients) {
        try {
          client.close();
        } catch (error) {
          errors.push(error as Error);
        }
      }
      if (observation) {
        observationClosed = true;
        try {
          observation.close();
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
      const ownedFleet = fleet ?? allocation;
      if (ownedFleet) {
        try {
          assert(
            serverPid > 0 && serverStart && socketIdentity,
            "Partial server ownership is uncertain; retain evidence",
          );
          assert.equal(
            await identity.identify(serverPid),
            serverStart,
            "Private server identity changed before cleanup",
          );
          const socket = lstatSync(ownedFleet.socketPath);
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
          rmSync(ownedFleet.root, { recursive: true, force: true });
        } catch (e) {
          errors.push(e as Error);
          cleanup.server = "failed";
        }
      }
      try {
        assert.equal(sha(tmuxBinary), tmuxHash);
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
