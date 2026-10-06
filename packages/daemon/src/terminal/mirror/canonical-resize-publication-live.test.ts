import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import {
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  type TerminalReplicaState,
} from "@tmux-ide/core";
import { MirrorService, type MirrorSubscription } from "./mirror-service.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { defaultNodePtyAdapter } from "../NodePtyAdapter.ts";
import type { SessionRuntimeTraceContext } from "../session-runtime/runtime-observability.ts";
import type { PtyProcess } from "../PtyAdapter.ts";

type Publication = {
  type: string;
  revision: number;
  layoutEpoch: number;
  batchEpoch: number;
  batchId?: number;
  publicationSeq?: number;
  baselineReplay?: boolean;
  layoutCols: number;
  layoutRows: number;
  snapshot: TerminalReplicaSnapshot;
};
function checkPublication(p: Publication): void {
  const s = p.snapshot;
  if (s.grid.length !== s.rows || s.grid.some((row) => row.cells.length !== s.cols))
    throw Error("grid dimensions incoherent");
  if (s.cursor.x < 0 || s.cursor.x >= s.cols || s.cursor.y < 0 || s.cursor.y >= s.rows)
    throw Error("cursor outside frame");
  if (
    p.type === "terminal.seed" &&
    !p.baselineReplay &&
    (p.batchEpoch !== p.layoutEpoch || s.cols !== p.layoutCols || s.rows !== p.layoutRows)
  )
    throw Error("obsolete capture layout epoch");
  for (const row of s.grid)
    for (let x = 0; x < row.cells.length; x++) {
      if (row.cells[x]!.width === 0 && (x === 0 || row.cells[x - 1]!.width !== 2))
        throw Error("orphan continuation");
      if (row.cells[x]!.width === 2 && row.cells[x + 1]?.width !== 0)
        throw Error("missing continuation");
    }
  if (
    !s.grid[0]!.cells.map((cell) => cell.grapheme)
      .join("")
      .startsWith("SENTINEL")
  )
    throw Error("retained sentinel disappeared");
}
it("detects incoherent cursor and obsolete same-size capture epochs", () => {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(12, 4));
  "SENTINEL".split("").forEach((c, x) => {
    snapshot.grid[0]!.cells[x]!.grapheme = c;
  });
  const row: Publication = {
    type: "terminal.seed",
    revision: 3,
    layoutEpoch: 3,
    batchEpoch: 3,
    layoutCols: 12,
    layoutRows: 4,
    snapshot,
  };
  expect(() => checkPublication(row)).not.toThrow();
  expect(() =>
    checkPublication({ ...row, snapshot: { ...snapshot, cursor: { ...snapshot.cursor, y: 4 } } }),
  ).toThrow("cursor outside frame");
  expect(() => checkPublication({ ...row, batchEpoch: 1 })).toThrow(
    "obsolete capture layout epoch",
  );
  expect(() => checkPublication({ ...row, snapshot: { ...snapshot, cols: 13 } })).toThrow(
    "grid dimensions incoherent",
  );
});

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
it.skipIf(!binary)(
  "publishes coherent canonical states while attached PTY resize crosses active captures",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-canonical-resize-"));
    const socket = `zz-canonical-resize-${process.pid}-${randomUUID().slice(0, 8)}`;
    const env = { ...process.env, HOME: root, TMUX: "", TERM: "xterm-256color" };
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const negativeControls: unknown[] = [];
    const trace: unknown[] = [],
      publications: Publication[] = [],
      errors: string[] = [];
    let service: MirrorService | undefined,
      owner: SessionRuntimeTerminalReplicaOwner | undefined,
      client: PtyProcess | undefined,
      upstream: MirrorSubscription | undefined;
    let canonicalSubscription: { close(): Promise<void> } | undefined;
    let state: TerminalReplicaState | null = null;
    let layoutEpoch = 0,
      layoutCols = 0,
      layoutRows = 0;
    type Batch = {
      id: number;
      epoch: number;
      cols: number;
      rows: number;
      marker: string;
      x: number;
      y: number;
      complete: boolean;
    };
    const batches: Batch[] = [];
    let outputTrace: SessionRuntimeTraceContext | null = null;
    const generation = randomUUID();
    const tracedBatches = new Map<string, Batch>();
    let pendingBatch: Batch | null = null;
    let committedBatch: Batch | null = null;
    let layoutKey = "",
      batchReset = false,
      batchSeed = false;
    let pendingResize: readonly [number, number] | null = null;
    let overlap = 0,
      sequence = 0,
      producerPid = 0,
      clientExited = false;
    let failure: string | undefined;
    const absent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    try {
      const script = join(root, "producer.cjs");
      writeFileSync(
        script,
        "let n=0; process.stdin.setRawMode(true); process.stdin.on('data',data=>{for(const c of data){n++;process.stdout.write('\\x1b[2;1HOUT'+n+'\\x1b[K\\x1b]2;tick-'+n+'\\x07');}}); process.stdout.write('\\x1b[2J\\x1b[HSENTINEL\\x1b[2;1HREADY');",
      );
      const pane = run(
        "new-session",
        "-d",
        "-s",
        "resize",
        "-x",
        "120",
        "-y",
        "34",
        "-P",
        "-F",
        "#{pane_id}",
        `${quote(process.execPath)} ${quote(script)}`,
      );
      run("set-option", "-t", "resize", "status", "off");
      producerPid = Number(run("display-message", "-p", "-t", pane, "#{pane_pid}"));
      client = defaultNodePtyAdapter.spawnSync(
        {
          shell: binary!,
          args: ["-L", socket, "-f", "/dev/null", "attach", "-t", "=resize"],
          cwd: root,
          cols: 120,
          rows: 34,
          env,
          name: "xterm-256color",
          encoding: null,
        },
        {
          onData: () => {},
          onExit: () => {
            clientExited = true;
          },
        },
      );
      const policy = run("show-options", "-wv", "-t", "resize", "window-size");
      expect(policy).not.toBe("manual");
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toContain("SENTINEL"));
      expect(run("capture-pane", "-p", "-R", "-S", "-", "-t", pane)).toContain('"version":2');
      service = new MirrorService({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        createIo: (session, handlers) => {
          const io = new MirrorControlChannel({
            executable: binary!,
            socketName: socket,
            configFile: "/dev/null",
            session,
            handlers,
          });
          const arm = io.armAtomicPaneSnapshotCollector.bind(io);
          io.armAtomicPaneSnapshotCollector = (spec, timeout) =>
            arm(
              {
                ...spec,
                onProgress: (progress) => {
                  spec.onProgress?.(progress);
                  if (spec.kind !== "pause" && progress.started && pendingResize) {
                    const [cols, rows] = pendingResize;
                    pendingResize = null;
                    try {
                      trace.push({
                        seq: ++sequence,
                        kind: "capture-active",
                        nonce: spec.nonce,
                        progress,
                        cols,
                        rows,
                      });
                      client!.resize(cols, rows);
                      run("send-keys", "-t", pane, "-l", "x");
                      // Native commands progress while this reader callback is still in
                      // the real collector: prove both server resize and producer output.
                      let seen = false;
                      for (let i = 0; i < 30; i++) {
                        const observed = run(
                          "display-message",
                          "-p",
                          "-t",
                          pane,
                          "#{window_width}|#{window_height}|#{pane_title}",
                        );
                        if (observed === `${cols}|${rows}|tick-${overlap + 1}`) {
                          seen = true;
                          break;
                        }
                      }
                      if (!seen) throw Error("resize/output did not overlap active collector");
                      overlap++;
                      trace.push({
                        seq: ++sequence,
                        kind: "native-resize-output-before-collector-return",
                        cols,
                        rows,
                        overlap,
                      });
                    } catch (error) {
                      errors.push(String(error));
                    }
                  }
                },
              },
              timeout,
            );
          return io;
        },
      });
      const describe = await service.describeSession("resize");
      const semantic = describe.panes[0]!.semanticPaneId;
      const subscribe = service.subscribe.bind(service);
      service.subscribe = async (request) => {
        const sub = await subscribe({
          ...request,
          onLayout: (event) => {
            const p = event.panes.find((p) => p.semanticPaneId === semantic);
            if (p) {
              const key = JSON.stringify([
                event.semanticWindowId,
                event.cols,
                event.rows,
                event.zoomed,
                event.paneBorderStatus,
                p.left,
                p.top,
                p.width,
                p.height,
              ]);
              if (key !== layoutKey) {
                layoutKey = key;
                layoutEpoch++;
              }
              layoutCols = p.width;
              layoutRows = p.height;
            }
            trace.push({ seq: ++sequence, kind: "layout", epoch: layoutEpoch, event });
            request.onLayout?.(event);
          },
          onEvent: (event) => {
            if (event.type === "reset") {
              pendingBatch = {
                id: batches.length + 1,
                epoch: layoutEpoch,
                cols: event.cols,
                rows: event.rows,
                marker: "",
                x: -1,
                y: -1,
                complete: false,
              };
              batches.push(pendingBatch);
              const traceId = randomUUID();
              tracedBatches.set(traceId, pendingBatch);
              outputTrace = {
                traceId,
                scenario: "fixture-capture-provenance",
                authority: { generation, incarnation: "resize:0" },
              };
              batchReset = true;
              batchSeed = false;
            }
            if (event.type === "seed") {
              if (!batchReset) errors.push("seed without reset");
              batchSeed = true;
              if (!event.native) errors.push("native fixture received nonnative seed");
              if (pendingBatch && event.native)
                pendingBatch.marker = event.native.grid[event.native.history + 1]!.cells.map(
                  (cell) => cell.text,
                )
                  .join("")
                  .trimEnd();
            }
            if (event.type === "cursor") {
              if (!batchReset || !batchSeed) errors.push("cursor without snapshot batch");
              batchReset = false;
              if (pendingBatch) {
                pendingBatch.x = Math.min(event.x, pendingBatch.cols - 1);
                pendingBatch.y = event.y;
                pendingBatch.complete = true;
              }
            }
            trace.push({
              seq: ++sequence,
              kind: "pane",
              event: event.type,
              epoch: layoutEpoch,
              ...(event.type === "reset" ? { cols: event.cols, rows: event.rows } : {}),
            });
            request.onEvent(event);
          },
        });
        upstream = sub;
        return sub;
      };
      owner = new SessionRuntimeTerminalReplicaOwner(generation, "resize", semantic, service, {
        incarnation: "resize:0",
        initialRevision: 0,
        takeOutputTrace: () => {
          const result = outputTrace;
          outputTrace = null;
          return result;
        },
        onFault: (error) => errors.push(String(error)),
      });
      canonicalSubscription = await owner.subscribe((update, publicationTrace) => {
        try {
          if (state && update.revision <= state.revision)
            throw Error("canonical revision did not advance");
          const priorSnapshot = state?.snapshot;
          const priorImage = JSON.stringify(priorSnapshot);
          const applied = applyTerminalReplicaUpdate(state, update);
          if (JSON.stringify(priorSnapshot) !== priorImage)
            throw Error("previous published state mutated");
          if (update.generation !== generation || update.incarnation !== "resize:0")
            throw Error("canonical owner identity changed");
          if (applied.status !== "applied") throw Error(`canonical admission ${applied.status}`);
          state = applied.state;
          if (!state.snapshot) {
            throw Error("unexpected tombstone for surviving pane");
          }
          const marker = state.snapshot.grid[1]!.cells.map((cell) => cell.grapheme)
            .join("")
            .trimEnd();
          if (update.type === "terminal.seed") {
            if (publicationTrace) {
              committedBatch = tracedBatches.get(publicationTrace.traceId) ?? null;
            } else if (publications.length === 0) {
              // subscribe() replays currentSeed without trace. Before any race,
              // require one unambiguous bootstrap batch, not a latest-size guess.
              const matches = batches.filter((batch) => batch.complete);
              if (matches.length !== 1) throw Error("ambiguous bootstrap replay");
              committedBatch = matches[0]!;
            } else throw Error("seed lost capture provenance trace");
            if (
              !committedBatch?.complete ||
              committedBatch.cols !== state.snapshot.cols ||
              committedBatch.rows !== state.snapshot.rows ||
              committedBatch.marker !== marker ||
              committedBatch.x !== state.snapshot.cursor.x ||
              committedBatch.y !== state.snapshot.cursor.y
            )
              throw Error("published seed differs from its captured batch");
          }
          if (
            update.type === "terminal.patch" &&
            update.patch.dimensions &&
            (update.patch.dimensions.cols !== state.snapshot.cols ||
              update.patch.dimensions.rows !== state.snapshot.rows)
          )
            throw Error("patch dimensions differ from published snapshot");
          const p: Publication = {
            type: update.type,
            revision: update.revision,
            layoutEpoch,
            batchEpoch: committedBatch?.epoch ?? -1,
            batchId: committedBatch?.id,
            publicationSeq: sequence + 1,
            baselineReplay: publications.length === 0,
            layoutCols,
            layoutRows,
            snapshot: structuredClone(state.snapshot),
          };
          publications.push(p);
          trace.push({
            seq: ++sequence,
            kind: "canonical",
            revision: update.revision,
            type: update.type,
            layoutEpoch,
            batchEpoch: p.batchEpoch,
            batchId: p.batchId,
            cols: p.snapshot.cols,
            rows: p.snapshot.rows,
          });
          checkPublication(p);
        } catch (error) {
          errors.push(String(error));
        }
      });
      for (const size of [
        [92, 28],
        [136, 38],
        [92, 28],
        [136, 38],
      ] as const) {
        pendingResize = size;
        upstream!.reseed();
        await vi.waitFor(
          () => {
            expect(errors).toEqual([]);
            expect(pendingResize).toBeNull();
            expect(state?.snapshot?.cols).toBe(size[0]);
            expect(state?.snapshot?.rows).toBe(size[1]);
          },
          { timeout: 5000 },
        );
        expect(run("show-options", "-wv", "-t", "resize", "window-size")).toBe(policy);
      }
      expect(overlap).toBe(4);
      expect(publications.length).toBeGreaterThan(4);
      expect(errors).toEqual([]);
      expect(run("capture-pane", "-p", "-t", pane)).toContain("OUT4");
      const nativeCursor = run("display-message", "-p", "-t", pane, "#{cursor_x},#{cursor_y}")
        .split(",")
        .map(Number);
      await vi.waitFor(() =>
        expect(state?.snapshot?.grid[1]!.cells.map((cell) => cell.grapheme).join("")).toContain(
          "OUT4",
        ),
      );
      expect([state!.snapshot!.cursor.x, state!.snapshot!.cursor.y]).toEqual(nativeCursor);
      // Mutation controls use copies of actual successful publications. The
      // stale publication has a fresh plausible revision, but original batch
      // provenance from an earlier occurrence of the SAME dimensions.
      const last = publications.filter((p) => p.type === "terminal.seed").at(-1)!;
      const older = publications.find(
        (p) =>
          p.type === "terminal.seed" &&
          p.snapshot.cols === last.snapshot.cols &&
          p.snapshot.rows === last.snapshot.rows &&
          p.batchEpoch < last.batchEpoch,
      );
      expect(older).toBeDefined();
      const stale = {
        ...structuredClone(older!),
        revision: last.revision + 1,
        publicationSeq: sequence + 1,
        layoutEpoch: last.layoutEpoch,
        layoutCols: last.layoutCols,
        layoutRows: last.layoutRows,
      };
      expect(() => checkPublication(stale)).toThrow("obsolete capture layout epoch");
      const cursorFault = structuredClone(last);
      cursorFault.snapshot.cursor.y = cursorFault.snapshot.rows;
      expect(() => checkPublication(cursorFault)).toThrow("cursor outside frame");
      negativeControls.push(
        {
          kind: "stale-same-size-real-publication",
          sourceBatchId: older!.batchId,
          againstBatchId: last.batchId,
          mutated: stale,
        },
        { kind: "cursor-real-publication", mutated: cursorFault },
      );
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      const bounded = async (operation: Promise<unknown> | undefined) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            operation,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("fixture disposal deadline")), 1500);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      try {
        await bounded(canonicalSubscription?.close());
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        await bounded(owner?.dispose());
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        await bounded(service?.dispose());
      } catch (error) {
        cleanupErrors.push(String(error));
      } finally {
        try {
          client?.kill("SIGKILL");
        } catch (error) {
          cleanupErrors.push(String(error));
        }
        spawnSync(binary!, ["-L", socket, "kill-server"], { env, timeout: 5000, stdio: "ignore" });
      }
      const serverAbsentStatus = spawnSync(binary!, ["-L", socket, "has-session"], {
        env,
        timeout: 5000,
        stdio: "ignore",
      }).status;
      try {
        await vi.waitFor(() => {
          if (client) expect(clientExited).toBe(true);
          if (producerPid > 0) expect(absent(producerPid)).toBe(true);
        });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
      writeFileSync(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            root,
            socket,
            binary,
            binarySha256: hash(binary!),
            testSha256: hash(fileURLToPath(import.meta.url)),
            version: execFileSync(binary!, ["-V"], { encoding: "utf8", timeout: 5000 }).trim(),
            gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
              timeout: 5000,
            }).trim(),
            sourceHashes: Object.fromEntries(
              ["session-channel.ts", "../session-runtime/terminal-replica-owner.ts"].map((path) => [
                path,
                hash(fileURLToPath(new URL(path, import.meta.url))),
              ]),
            ),
            scope:
              "Delivered canonical callbacks between subscription and teardown; bootstrap replay explicit. Four individually converged capture overlaps, not autonomous continuous output or unquiesced reversals; no host paint claim.",
            trace,
            batches,
            publications,
            negativeControls,
            overlap,
            errors,
            failure,
            cleanup: {
              errors: cleanupErrors,
              serverAbsentStatus,
              clientExited,
              producerAbsent: producerPid > 0 ? absent(producerPid) : null,
            },
          },
          null,
          2,
        ),
      );
      console.log(`Canonical resize receipt: ${join(root, "receipt.json")}`);
      expect(serverAbsentStatus).toBe(1);
      expect(cleanupErrors).toEqual([]);
    }
  },
  30000,
);
