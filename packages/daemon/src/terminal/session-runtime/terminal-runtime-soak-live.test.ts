import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, loadavg, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  type TerminalDeliveryEnvelope,
  type TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryEnvelope,
  admitTerminalDeliveryChunk,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  TerminalDeliveryAssembler,
  type TerminalDeliveryClientState,
} from "@tmux-ide/core";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";
import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import {
  createNativeTmuxServerOwner,
  type NativeTmuxServerOwner,
} from "../../lib/tmux-server-owner.ts";
import { attachPaneStreamWebSocket } from "../../server/pane-stream-upgrade.ts";
import { runtimeSoakConfiguration } from "../../../test-support/terminal-runtime-soak-config.ts";

// Opt-in runtime qualification, not daemon detection or physical renderer cost.
// Run each pane count in a fresh worker. Smoke is explicitly not soak evidence.
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
const enabled = process.env.TMUX_IDE_RUNTIME_SOAK === "1" && !!binary;
const workload =
  process.env.TMUX_IDE_RUNTIME_SOAK_WORKLOAD === "full-clear" ? "full-clear" : "row-overwrite";
const { smoke, profile, config } = runtimeSoakConfiguration(process.env);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + config.budgets.operationMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await sleep(25);
  }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cleanup timeout")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
// Report robust windows and least-squares slope; the original safety cap remains
// unchanged. A smoke has insufficient warmup for a sustained-leak verdict.
function resourceTrend(samples: { phase: string; rss: number; heap: number; at: number }[]) {
  const measured = samples.filter((s) => s.phase === "measured"),
    trailing = samples.filter((s) => s.phase === "trailing");
  const median = (xs: number[]) => {
    const ys = [...xs].sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(ys.length / 2)]! : null;
  };
  const slope = (field: "rss" | "heap") => {
    if (measured.length < 3) return null;
    const origin = measured[0]!.at;
    const xs = measured.map((s) => (s.at - origin) / 3600000),
      ys = measured.map((s) => s[field]);
    const x = xs.reduce((a, b) => a + b, 0) / xs.length,
      y = ys.reduce((a, b) => a + b, 0) / ys.length;
    return (
      xs.reduce((n, v, i) => n + (v - x) * (ys[i]! - y), 0) /
      xs.reduce((n, v) => n + (v - x) ** 2, 0)
    );
  };
  return {
    measuredSamples: measured.length,
    trailingSamples: trailing.length,
    firstWindowMedian: {
      rss: median(measured.slice(0, 12).map((s) => s.rss)),
      heap: median(measured.slice(0, 12).map((s) => s.heap)),
    },
    trailingMedian: {
      rss: median(trailing.map((s) => s.rss)),
      heap: median(trailing.map((s) => s.heap)),
    },
    slopeBytesPerHour: { rss: slope("rss"), heap: slope("heap") },
  };
}
type Viewer = {
  client?: PaneStreamRuntimeClient;
  deliveryLaneId?: string;
  states: Map<string, TerminalDeliveryClientState>;
  pending: Map<string, TerminalDeliveryServerMessage[]>;
  envelopes: Map<string, TerminalDeliveryEnvelope>;
  deliveries: number;
};
for (const count of [1, 15])
  it.skipIf(!enabled || (process.env.TMUX_IDE_RUNTIME_SOAK_PANES ?? "1") !== String(count))(
    `qualifies populated ${count}-pane runtime resource and viewer lifecycle soak`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), `tmux-soak-${count}-`));
      const socket = join(root, "tmux.sock");
      const receipt = process.env.TMUX_IDE_RUNTIME_SOAK_RECEIPT ?? join(root, "receipt.json");
      const series = `${receipt}.jsonl`;
      const env = { ...process.env, TMUX: "", HOME: root, TERM: "xterm-256color" };
      const native = (...args: string[]) =>
        execFileSync(binary!, ["-S", socket, "-f", "/dev/null", ...args], {
          env,
          encoding: "utf8",
          timeout: 5000,
        }).trimEnd();
      const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      const panes: { native: string; semantic: string; pid: number }[] = [];
      const retired: unknown[] = [],
        transientPids: number[] = [];
      const sockets: WebSocket[] = [],
        viewers: Viewer[] = [];
      const faults: unknown[] = [],
        checkpoints: unknown[] = [],
        cleanup: string[] = [];
      const ledgerBefore = runtimeResourceSnapshot();
      const server = createServer();
      let owner: NativeTmuxServerOwner | undefined;
      let boundary: ReturnType<typeof attachPaneStreamWebSocket> | undefined;
      let serverPid = 0,
        failure: string | undefined;
      const samples: { phase: string; rss: number; heap: number; cpu: number; at: number }[] = [];
      const absent = (pid: number) => {
        if (!pid) return true;
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      let cpuPrevious = process.cpuUsage(),
        timePrevious = performance.now();
      const { sampleProcessTree } = await import(
        new URL("../../../../../scripts/lib/comparative-terminal-resources.mjs", import.meta.url)
          .href
      );
      const sample = async (phase: string) => {
        const now = performance.now(),
          cpu = process.cpuUsage(),
          memory = process.memoryUsage();
        const cpuPercent =
          ((cpu.user - cpuPrevious.user + cpu.system - cpuPrevious.system) /
            1000 /
            (now - timePrevious)) *
          100;
        cpuPrevious = cpu;
        timePrevious = now;
        const qualification = owner?.sessionRuntimeRegistry.qualificationSnapshot();
        const processes = await sampleProcessTree(
          [process.pid, ...(serverPid ? [serverPid] : [])],
          panes.map((p) => p.pid),
        );
        const fds = spawnSync("lsof", ["-p", String(process.pid), "-Ff"], {
          encoding: "utf8",
          timeout: 5000,
        });
        const fdCount =
          fds.status === 0
            ? fds.stdout.split("\n").filter((line) => /^f[0-9]/.test(line)).length
            : null;
        for (const session of qualification?.sessions ?? []) {
          expect(
            session.delivery.inFlightBytes +
              session.delivery.representationCacheBytes +
              session.delivery.rawJournalBytes,
          ).toBeLessThan(config.budgets.deliveryQueueBytes);
          expect(session.delivery.inFlight).toBeLessThanOrEqual(2 * count);
          expect(session.delivery.latestPointers).toBeLessThanOrEqual(2 * count);
        }
        appendFileSync(
          series,
          JSON.stringify({
            at: new Date().toISOString(),
            phase,
            memory,
            cpuPercent,
            host: { loadavg: loadavg(), logicalCpus: cpus().length, totalMemory: totalmem() },
            resources: process.getActiveResourcesInfo(),
            ledger: runtimeResourceSnapshot(),
            qualification,
            nativeHistory: panes
              .filter((p) => !absent(p.pid))
              .map((p) => ({
                pane: p.native,
                history: native(
                  "display-message",
                  "-p",
                  "-t",
                  p.native,
                  "#{history_size}|#{history_limit}|#{scroll-on-clear}",
                ),
              })),
            socketListeners: sockets.map((ws) => ({
              state: ws.readyState,
              buffered: ws.bufferedAmount,
              listeners: ws.eventNames().map((name) => [String(name), ws.listenerCount(name)]),
            })),
            processes,
            fdCount,
          }) + "\n",
        );
        samples.push({
          phase,
          rss: memory.rss,
          heap: memory.heapUsed,
          cpu: cpuPercent,
          at: Date.now(),
        });
        expect(memory.rss).toBeLessThan(config.budgets.rssBytes);
        expect(memory.heapUsed).toBeLessThan(config.budgets.heapBytes);
        expect(qualification?.controlChannels ?? 0).toBeLessThanOrEqual(1);
      };
      const drain = (v: Viewer, pane: string) => {
        if (!v.client) return;
        const queue = v.pending.get(pane);
        if (!queue) return;
        while (queue.length) {
          const envelope = queue[0]!;
          if (envelope.type !== "terminal.delivery") throw new Error("Expected envelope");
          if (queue.length < envelope.chunkCount + 1) return;
          let state = admitTerminalDeliveryEnvelope(v.states.get(pane)!, envelope);
          const assembler = new TerminalDeliveryAssembler(envelope);
          for (const chunk of queue.slice(1, envelope.chunkCount + 1)) {
            if (chunk.type !== "terminal.delivery.chunk") throw new Error("Expected chunk");
            state = admitTerminalDeliveryChunk(state, chunk);
            assembler.write(chunk);
          }
          const committed = commitTerminalDelivery(
            state,
            completeTerminalDelivery(state, assembler),
          );
          v.states.set(pane, committed.state);
          v.envelopes.set(pane, envelope);
          v.deliveries++;
          queue.splice(0, envelope.chunkCount + 1);
          v.client.ack(committed.ack);
        }
      };
      const open = async (interactive: boolean) => {
        const v: Viewer = {
          states: new Map(),
          pending: new Map(),
          envelopes: new Map(),
          deliveries: 0,
        };
        viewers.push(v);
        const requestId = randomUUID(),
          hostClientId = `soak:${requestId}`;
        const stream = {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "soak",
          panes: panes.map((p) => p.semantic),
          viewerMode: interactive ? ("interactive" as const) : ("read-only" as const),
          terminalDelivery: {
            protocolVersions: [1],
            encodings: ["semantic-compact-v1"],
            richPlacements: false,
          } as const,
        };
        const descriptor = await owner!.paneStreamRuntime.coordinator.issue(stream, {
          requestId,
          projectIdentity: "soak",
          sessionName: "soak",
          rendererOrigin: "tmux-ide://app",
          hostClientId,
        });
        v.client = await connectIssuedPaneStreamRuntimeClient(
          {
            origin: "tmux-ide://app",
            hostClientId,
            stream,
            requestInitialInputAuthority: interactive,
            createSocket: (d, headers) => {
              const ws = new WebSocket(d.webSocketUrl, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], {
                headers,
              });
              sockets.push(ws);
              ws.once("close", () => {
                retired.push({
                  kind: "socket",
                  state: ws.readyState,
                  listeners: ws.eventNames().map((name) => [String(name), ws.listenerCount(name)]),
                });
                const index = sockets.indexOf(ws);
                if (index >= 0) sockets.splice(index, 1);
              });
              return ws;
            },
            onNegotiated: (pane, n) => {
              if (!n.accepted) throw new Error("Delivery negotiation failed");
              v.states.set(pane, createTerminalDeliveryClientState(n.negotiated, "soak", pane));
              v.pending.set(pane, []);
            },
            onTerminalDelivery: (pane, message) => {
              v.pending.get(pane)!.push(message);
              drain(v, pane);
            },
            onFault: (fault) => faults.push(fault),
          },
          descriptor,
        );
        for (const pane of panes) drain(v, pane.semantic);
        await until(
          () => panes.every((p) => !!v.states.get(p.semantic)?.canonicalSnapshot),
          "viewer initial snapshots",
        );
        const entries = owner!.sessionRuntimeRegistry
          .qualificationSnapshot()
          .sessions.flatMap((session) => session.convergence.clients)
          .filter((client) => client.clientId.startsWith(`${v.client!.connectionClientId}:`));
        const lanes = [...new Set(entries.map((client) => client.clientId))];
        expect(lanes).toHaveLength(1);
        expect(entries).toHaveLength(count);
        expect(
          panes.every((pane) => entries.some((client) => client.semanticPaneId === pane.semantic)),
        ).toBe(true);
        v.deliveryLaneId = lanes[0]!;
        return v;
      };
      const row = (v: Viewer, pane: string, y: number) =>
        v.states
          .get(pane)
          ?.canonicalSnapshot?.grid[y]?.cells.map((c) => (c.width === 0 ? "" : c.grapheme || " "))
          .join("")
          .trimEnd();
      const visibility = (v: Viewer, visibility: "hidden" | "visible") => {
        for (const p of panes) {
          const e = v.envelopes.get(p.semantic)!;
          v.client!.setVisibility(
            {
              workspaceName: "soak",
              pane: p.semantic,
              generation: e.generation,
              incarnation: e.incarnation,
              deliveryNonce: e.deliveryNonce,
            },
            visibility,
          );
        }
      };
      try {
        writeFileSync(`${receipt}.source.ts`, readFileSync(fileURLToPath(import.meta.url)));
        writeFileSync(
          `${receipt}.identity.json`,
          JSON.stringify(
            {
              binary: hash(binary!),
              sources: Object.fromEntries(
                [
                  "./registry.ts",
                  "./terminal-replica-owner.ts",
                  "./terminal-delivery-hub.ts",
                  "../../lib/tmux-server-owner.ts",
                  "../../../../../scripts/lib/comparative-terminal-resources.mjs",
                ].map((path) => [path, hash(fileURLToPath(new URL(path, import.meta.url)))]),
              ),
            },
            null,
            2,
          ),
        );
        writeFileSync(
          receipt,
          JSON.stringify(
            {
              status: "declared-before-workload",
              config,
              count,
              smoke,
              profile,
              workload,
              root,
              binary: hash(binary!),
              source: hash(fileURLToPath(import.meta.url)),
            },
            null,
            2,
          ),
        );
        const script = join(root, "producer.cjs");
        writeFileSync(
          script,
          `const fs=require('node:fs');let n=0,input='';process.stdin.setRawMode(true);process.stdout.write('\\x1b[2J');function draw(){process.stdout.write(${workload === "full-clear" ? "'\\x1b[2J'" : "''"}+'\\x1b[H\\x1b[2K'+process.argv[2]+' '+n+'\\x1b[2;1H\\x1b[2KINPUT '+input+'\\x1b[3;1H');}process.stdin.on('data',b=>{input=b.toString('hex');draw()});setInterval(()=>{if(!fs.existsSync(process.argv[3])){n++;draw()}},100);draw();`,
        );
        const stop = join(root, "stop-ticks");
        for (let i = 0; i < count; i++) {
          const command = `${quote(process.execPath)} ${quote(script)} P${i} ${quote(stop)}`;
          const pane =
            i === 0
              ? native(
                  "new-session",
                  "-d",
                  "-s",
                  "soak",
                  "-x",
                  "100",
                  "-y",
                  "24",
                  "-P",
                  "-F",
                  "#{pane_id}",
                  command,
                )
              : native("new-window", "-d", "-t", "soak", "-P", "-F", "#{pane_id}", command);
          native("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", `pane.soak${i}`);
          native("set-option", "-w", "-t", pane, "@tmux_ide_window_id", `win.soak${i}`);
          panes.push({
            native: pane,
            semantic: `pane.soak${i}`,
            pid: Number(native("display-message", "-p", "-t", pane, "#{pane_pid}")),
          });
        }
        serverPid = Number(native("display-message", "-p", "#{pid}"));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("HTTP address missing");
        owner = await createNativeTmuxServerOwner({
          environmentId: "00000000-0000-4000-8000-000000000001",
          serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
          generation: randomUUID(),
          tmuxAuthority: {
            executablePath: binary!,
            socketSelector: { kind: "path", path: socket },
          },
          stateDirectory: join(root, "state"),
          webSocketUrl: `ws://127.0.0.1:${address.port}${PANE_STREAM_REDEEM_PATH}`,
        });
        boundary = attachPaneStreamWebSocket(server, owner.paneStreamRuntime.coordinator);
        const active = await open(true);
        let observer = await open(false),
          cycle = 0,
          inputHex = "";
        const started = Date.now(),
          end = started + config.warmupMs + config.measuredMs;
        let nextCycle = started,
          nextSample = started;
        while (Date.now() < end) {
          if (Date.now() >= nextCycle) {
            visibility(observer, "hidden");
            // Hiding prevents new transactions; an already admitted flight may
            // finish. Establish its ACK/drain boundary before counting silence.
            await until(() => {
              if (!observer.deliveryLaneId) return false;
              const entries = owner!.sessionRuntimeRegistry
                .qualificationSnapshot()
                .sessions.flatMap((session) => session.convergence.clients)
                .filter((client) => client.clientId === observer.deliveryLaneId);
              return (
                entries.length === count &&
                panes.every((pane) =>
                  entries.some((client) => client.semanticPaneId === pane.semantic),
                ) &&
                entries.every(
                  (client) =>
                    client.visibility === "hidden" &&
                    client.inFlightRevision === null &&
                    client.queueDepth === 0,
                ) &&
                panes.every((pane) => observer.pending.get(pane.semantic)?.length === 0)
              );
            }, "observer hidden transactions drained");
            const hidden = observer.deliveries,
              before = row(active, panes[0]!.semantic, 0);
            const text = String.fromCharCode(97 + (cycle % 26));
            inputHex = Buffer.from(text).toString("hex");
            active.client!.sendText(panes[0]!.semantic, text);
            await until(
              () =>
                row(active, panes[0]!.semantic, 1) === `INPUT ${inputHex}` &&
                row(active, panes[0]!.semantic, 0) !== before,
              "active input while observer hidden",
            );
            expect(observer.deliveries).toBe(hidden);
            writeFileSync(stop, "checkpoint");
            await sleep(150);
            const expected = panes.map((p) => ({
              pane: p.semantic,
              rows: native("capture-pane", "-p", "-t", p.native).split("\n"),
            }));
            visibility(observer, "visible");
            await until(
              () =>
                expected.every(
                  (p) =>
                    row(observer, p.pane, 0) === p.rows[0] &&
                    row(observer, p.pane, 1) === p.rows[1],
                ),
              "all revealed panes at independent checkpoint",
            );
            unlinkSync(stop);
            await until(
              () => row(observer, panes[0]!.semantic, 1) === `INPUT ${inputHex}`,
              "revealed input checkpoint",
            );
            if (cycle % 2 === 1) {
              observer.client!.close();
              observer.states.clear();
              observer.pending.clear();
              observer.envelopes.clear();
              retired.push({ kind: "viewer", deliveries: observer.deliveries });
              viewers.splice(viewers.indexOf(observer), 1);
              observer = await open(false);
            }
            await active.client!.requestAuthority("geometry");
            expect(await active.client!.fitViewport(cycle % 2 ? 100 : 92, 24, "win.soak0")).toBe(
              "ok",
            );
            const transient = native(
              "new-window",
              "-d",
              "-t",
              "soak",
              "-P",
              "-F",
              "#{pane_id}",
              "exec sleep 30",
            );
            transientPids.push(
              Number(native("display-message", "-p", "-t", transient, "#{pane_pid}")),
            );
            native("kill-pane", "-t", transient);
            checkpoints.push({ cycle, inputHex, hiddenDeliveries: hidden });
            cycle++;
            nextCycle += config.cycleMs;
          }
          if (Date.now() >= nextSample) {
            await sample(Date.now() - started < config.warmupMs ? "warmup" : "measured");
            nextSample += config.sampleMs;
          }
          await sleep(50);
        }
        writeFileSync(stop, "stop");
        await sleep(200);
        for (const p of panes) {
          const nativeRows = native("capture-pane", "-p", "-t", p.native).split("\n");
          await until(
            () =>
              [active, observer].every(
                (v) =>
                  row(v, p.semantic, 0) === nativeRows[0] &&
                  row(v, p.semantic, 1) === nativeRows[1],
              ),
            "final native checkpoint",
          );
          for (const v of [active, observer]) {
            const snapshot = v.states.get(p.semantic)!.canonicalSnapshot!;
            for (let y = 2; y < snapshot.rows; y++) expect(row(v, p.semantic, y)).toBe("");
          }
        }
        const trailingEnd = Date.now() + config.trailingMs;
        while (Date.now() < trailingEnd) {
          await sample("trailing");
          await sleep(config.sampleMs);
        }
        expect(faults).toEqual([]);
        const measured = samples.filter((s) => s.phase === "measured");
        expect(measured.length).toBeGreaterThan(0);
        expect(measured.reduce((sum, s) => sum + s.cpu, 0) / measured.length).toBeLessThan(
          config.budgets.maxCpuCorePercent,
        );
        const first = measured[0]!,
          last = samples.at(-1)!;
        expect(last.rss - first.rss).toBeLessThan(config.budgets.trailingRssGrowthBytes);
        expect(last.heap - first.heap).toBeLessThan(config.budgets.trailingHeapGrowthBytes);
      } catch (error) {
        failure = error instanceof Error ? error.stack : String(error);
      } finally {
        for (const v of viewers) {
          try {
            v.client?.close();
            v.states.clear();
            v.pending.clear();
            v.envelopes.clear();
          } catch (e) {
            cleanup.push(String(e));
          }
        }
        try {
          await bounded(owner?.dispose() ?? Promise.resolve());
        } catch (e) {
          cleanup.push(String(e));
        }
        try {
          const after = owner?.sessionRuntimeRegistry.qualificationSnapshot();
          expect(after?.controlChannels ?? 0).toBe(0);
          expect(after?.sessions ?? []).toEqual([]);
          await sample("postclose");
        } catch (e) {
          cleanup.push(String(e));
        }
        for (const ws of [...sockets]) ws.terminate();
        try {
          await bounded(boundary?.close() ?? Promise.resolve());
        } catch (e) {
          cleanup.push(String(e));
        }
        server.closeAllConnections();
        try {
          if (server.listening)
            await bounded(
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
            );
        } catch (e) {
          cleanup.push(String(e));
        }
        spawnSync(binary!, ["-S", socket, "kill-server"], { env, timeout: 5000, stdio: "ignore" });
        try {
          await until(
            () =>
              absent(serverPid) && panes.every((p) => absent(p.pid)) && transientPids.every(absent),
            "owned process cleanup",
          );
        } catch (e) {
          cleanup.push(String(e));
        }
        try {
          await until(() => sockets.length === 0, "all physical sockets closed");
          const after = runtimeResourceSnapshot();
          for (const kind of Object.keys(ledgerBefore) as (keyof typeof ledgerBefore)[])
            expect(after[kind].active).toBe(ledgerBefore[kind].active);
          await sample("postcleanup");
        } catch (e) {
          cleanup.push(String(e));
        }
        writeFileSync(
          receipt,
          JSON.stringify(
            {
              config,
              count,
              smoke,
              profile,
              workload,
              failure,
              cleanup,
              faults,
              checkpoints,
              samples,
              trend: resourceTrend(samples),
              binary: hash(binary!),
              source: hash(fileURLToPath(import.meta.url)),
              retired,
              transientPids: transientPids.map((pid) => ({ pid, absent: absent(pid) })),
              ledgerBefore,
              ledgerAfter: runtimeResourceSnapshot(),
              serverAbsent: absent(serverPid),
              producers: panes.map((p) => ({ ...p, absent: absent(p.pid) })),
              series,
              limitations: [
                "Runtime plus test/client process costs; no detector or renderer attribution",
                "Socket listener ledger is not internal owner/registry listener cardinality",
                profile === "long"
                  ? "Thirty-minute measured soak is bounded evidence, not proof for arbitrary session durations"
                  : "Five-minute bounded soak is not long-session leak qualification",
                "Raw ps snapshots retain producer and process-tree attribution; RSS shared pages and exited child CPU are not resolved",
              ],
            },
            null,
            2,
          ),
        );
      }
      expect(failure).toBeUndefined();
      expect(cleanup).toEqual([]);
    },
    config.warmupMs + config.measuredMs + config.trailingMs + 120_000,
  );
