import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { TerminalDeliveryEnvelope, TerminalDeliveryServerMessage } from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryEnvelope,
  admitTerminalDeliveryChunk,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  TerminalDeliveryAssembler,
  type TerminalDeliveryClientState,
} from "@tmux-ide/core";
import { MirrorService } from "../mirror/mirror-service.ts";
import { MirrorControlChannel } from "../mirror/control-channel.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliveryConnection,
} from "./terminal-delivery-hub.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
// This tests semantic visibility through the real delivery hub and native pane.
// It does not attach a renderer or physical WebSocket, or claim zero render work.
it.skipIf(!binary)(
  "reveals a complete current native snapshot after another viewer advances while hidden",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-hidden-viewer-"));
    const socket = `zz-hidden-${process.pid}-${randomUUID().slice(0, 8)}`;
    const env = { ...process.env, HOME: root, TMUX: "", TERM: "xterm-256color" };
    const native = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
      }).trimEnd();
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const generation = randomUUID();
    const messages: TerminalDeliveryServerMessage[][] = [[], []];
    const clients: TerminalDeliveryConnection[] = [];
    const states: (TerminalDeliveryClientState | null)[] = [null, null];
    const consumed = [0, 0];
    const commits: { viewer: number; envelope: TerminalDeliveryEnvelope }[] = [];
    const checkpoints: unknown[] = [];
    const faults: string[] = [];
    let mirror: MirrorService | undefined;
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let hub: SessionRuntimeTerminalDeliveryHub | undefined;
    let producerPid = 0;
    let failure: string | undefined;
    const absent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    // Consume only complete actual transactions. The server ACK is the supported
    // client reducer's result, not an invented successful acknowledgment.
    const drain = (viewer: number) => {
      while (consumed[viewer]! < messages[viewer]!.length) {
        const envelope = messages[viewer]![consumed[viewer]!]!;
        expect(envelope.type).toBe("terminal.delivery");
        if (envelope.type !== "terminal.delivery") throw new Error("unexpected delivery framing");
        if (messages[viewer]!.length - consumed[viewer]! < envelope.chunkCount + 1) return;
        let admitted = admitTerminalDeliveryEnvelope(states[viewer]!, envelope);
        const assembler = new TerminalDeliveryAssembler(envelope);
        for (let i = 1; i <= envelope.chunkCount; i++) {
          const chunk = messages[viewer]![consumed[viewer]! + i]!;
          expect(chunk.type).toBe("terminal.delivery.chunk");
          if (chunk.type !== "terminal.delivery.chunk") throw new Error("unexpected nonchunk");
          admitted = admitTerminalDeliveryChunk(admitted, chunk);
          assembler.write(chunk);
        }
        const committed = commitTerminalDelivery(
          admitted,
          completeTerminalDelivery(admitted, assembler),
        );
        states[viewer] = committed.state;
        consumed[viewer]! += envelope.chunkCount + 1;
        commits.push({ viewer, envelope });
        clients[viewer]!.ack(committed.ack);
      }
    };
    const row = (viewer: number, y: number) =>
      states[viewer]?.canonicalSnapshot?.grid[y]?.cells
        .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
        .join("")
        .trimEnd();
    try {
      const script = join(root, "producer.cjs");
      writeFileSync(
        script,
        "let n=0;process.stdin.setRawMode(true);const draw=()=>process.stdout.write('\\x1b[2J\\x1b[HSTEP-'+n+'\\x1b[2;1HEND 漢 Z\\x1b[3;1H');process.stdin.on('data',b=>{for(const c of b){n++;draw();}});draw();",
      );
      const pane = native(
        "new-session",
        "-d",
        "-s",
        "hidden",
        "-x",
        "40",
        "-y",
        "8",
        "-P",
        "-F",
        "#{pane_id}",
        `${quote(process.execPath)} ${quote(script)}`,
      );
      producerPid = Number(native("display-message", "-p", "-t", pane, "#{pane_pid}"));
      native("set-option", "-t", "hidden", "status", "off");
      await vi.waitFor(() =>
        expect(native("capture-pane", "-p", "-t", pane)).toBe("STEP-0\nEND 漢 Z"),
      );
      const geometry = () =>
        native(
          "display-message",
          "-p",
          "-t",
          pane,
          "#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window-size}",
        );
      const baselineGeometry = geometry();
      expect(baselineGeometry.split("|").slice(0, 4)).toEqual(["40", "8", "40", "8"]);
      mirror = new MirrorService({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        createIo: (session, handlers) =>
          new MirrorControlChannel({
            executable: binary!,
            socketName: socket,
            configFile: "/dev/null",
            session,
            handlers,
          }),
      });
      const semanticPane = (await mirror.describeSession("hidden")).panes[0]!.semanticPaneId;
      owner = new SessionRuntimeTerminalReplicaOwner(generation, "hidden", semanticPane, mirror, {
        incarnation: "hidden:0",
        initialRevision: 0,
        onFault: (error) => faults.push(String(error)),
      });
      hub = new SessionRuntimeTerminalDeliveryHub(generation, "hidden", () => owner!);
      const offer = {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1"],
        richPlacements: false,
      } as const;
      for (const viewer of [0, 1]) {
        const connection = await hub.open(`viewer-${viewer}`, semanticPane, offer, (message) =>
          messages[viewer]!.push(message),
        );
        clients.push(connection);
        if (!connection.negotiation.accepted) throw new Error("semantic negotiation failed");
        states[viewer] = createTerminalDeliveryClientState(
          connection.negotiation.negotiated,
          "hidden",
          semanticPane,
        );
      }
      await vi.waitFor(() => {
        drain(0);
        drain(1);
        expect(row(0, 0)).toBe("STEP-0");
        expect(row(1, 0)).toBe("STEP-0");
        expect(hub!.metrics().inFlight).toBe(0);
      });
      expect(states[0]!.appliedRevision).toBe(states[1]!.appliedRevision);
      expect(geometry()).toBe(baselineGeometry);
      const initialRevision = states[1]!.appliedRevision;
      clients[1]!.setVisibility("hidden");
      const hiddenCount = messages[1]!.length;
      for (let step = 1; step <= 3; step++) {
        native("send-keys", "-t", pane, "-l", "x");
        await vi.waitFor(() => {
          drain(0);
          expect(native("capture-pane", "-p", "-t", pane)).toBe(`STEP-${step}\nEND 漢 Z`);
          expect(row(0, 0)).toBe(`STEP-${step}`);
          expect(hub!.metrics().inFlight).toBe(0);
        });
        expect(messages[1]).toHaveLength(hiddenCount);
        expect(states[1]!.appliedRevision).toBe(initialRevision);
        expect(geometry()).toBe(baselineGeometry);
        checkpoints.push({
          step,
          native: native("capture-pane", "-p", "-t", pane),
          geometry: geometry(),
          healthyRevision: states[0]!.appliedRevision,
          hiddenRevision: states[1]!.appliedRevision,
          hiddenMessageCount: messages[1]!.length,
          metrics: hub.metrics(),
        });
      }
      const currentRevision = states[0]!.appliedRevision;
      expect(currentRevision).toBeGreaterThan(initialRevision);
      const beforeRevealCommits = commits.filter((commit) => commit.viewer === 1).length;
      clients[1]!.setVisibility("visible");
      await vi.waitFor(() => {
        drain(0);
        drain(1);
        expect(row(1, 0)).toBe("STEP-3");
        expect(states[1]!.appliedRevision).toBe(currentRevision);
        expect(hub!.metrics().inFlight).toBe(0);
      });
      const revealed = commits.filter((commit) => commit.viewer === 1).slice(beforeRevealCommits);
      expect(revealed).toHaveLength(1);
      expect(revealed[0]!.envelope.frame).toBe("seed");
      expect(states[1]!.canonicalSnapshot).toEqual(states[0]!.canonicalSnapshot);
      // Independent literal cell oracle includes the entire erased region.
      // A shared stale row in A and B must not pass merely because they agree.
      for (const viewer of [0, 1]) {
        const snapshot = states[viewer]!.canonicalSnapshot!;
        expect([snapshot.cols, snapshot.rows, snapshot.grid.length]).toEqual([40, 8, 8]);
        for (let y = 0; y < 8; y++) {
          const expected = Array.from({ length: 40 }, () => ({ grapheme: " ", width: 1 }));
          if (y === 0)
            for (const [x, grapheme] of Array.from("STEP-3").entries())
              expected[x] = { grapheme, width: 1 };
          if (y === 1) {
            for (const [x, grapheme] of Array.from("END ").entries())
              expected[x] = { grapheme, width: 1 };
            expected[4] = { grapheme: "漢", width: 2 };
            expected[5] = { grapheme: "", width: 0 };
            expected[7] = { grapheme: "Z", width: 1 };
          }
          expect(
            snapshot.grid[y]!.cells.map((cell) => ({
              grapheme: cell.width === 0 ? cell.grapheme : cell.grapheme || " ",
              width: cell.width,
            })),
          ).toEqual(expected);
        }
      }
      expect(row(1, 1)).toBe("END 漢 Z");
      expect(states[1]!.canonicalSnapshot!.grid[1]!.cells[4]).toMatchObject({
        grapheme: "漢",
        width: 2,
      });
      expect(states[1]!.canonicalSnapshot!.grid[1]!.cells[5]).toMatchObject({ width: 0 });
      expect(states[1]!.canonicalSnapshot!.cursor).toMatchObject({ x: 0, y: 2 });
      expect(native("display-message", "-p", "-t", pane, "#{cursor_x}|#{cursor_y}")).toBe("0|2");
      expect(geometry()).toBe(baselineGeometry);
      expect(faults).toEqual([]);
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      const bounded = async (work: Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            work,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("cleanup deadline")), 1500);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      for (const client of clients)
        try {
          await bounded(client.close());
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      const closedMetrics = hub?.metrics();
      try {
        if (owner) await bounded(owner.dispose());
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        if (mirror) await bounded(mirror.dispose());
      } catch (error) {
        cleanupErrors.push(String(error));
      } finally {
        spawnSync(binary!, ["-L", socket, "kill-server"], { env, timeout: 5000, stdio: "ignore" });
      }
      const serverAbsentStatus = spawnSync(binary!, ["-L", socket, "has-session"], {
        env,
        timeout: 5000,
        stdio: "ignore",
      }).status;
      try {
        if (producerPid > 0) await vi.waitFor(() => expect(absent(producerPid)).toBe(true));
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      writeFileSync(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            root,
            socket,
            binary,
            binarySha256: hash(binary!),
            sourceSha256: hash(fileURLToPath(import.meta.url)),
            sourceHashes: Object.fromEntries(
              [
                "terminal-delivery-hub.ts",
                "terminal-replica-owner.ts",
                "../mirror/session-channel.ts",
              ].map((path) => [path, hash(fileURLToPath(new URL(path, import.meta.url)))]),
            ),
            checkpoints,
            commits,
            states,
            messages,
            faults,
            failure,
            cleanup: {
              errors: cleanupErrors,
              serverAbsentStatus,
              producerAbsent: producerPid > 0 ? absent(producerPid) : null,
              closedMetrics,
            },
            scope:
              "Actual native producer, mirror owner and semantic delivery hub; no physical WebSocket or renderer. Hidden viewer has no deliveries while healthy viewer advances; reveal seed checked against literal content and native checkpoint.",
          },
          null,
          2,
        ),
      );
      console.log(`Hidden viewer receipt: ${join(root, "receipt.json")}`);
      expect(serverAbsentStatus).toBe(1);
      expect(cleanupErrors).toEqual([]);
      expect(faults).toEqual([]);
      if (hub)
        expect(closedMetrics).toMatchObject({
          clients: 0,
          connections: 0,
          inFlight: 0,
          canonicalRevisions: 0,
          representationCacheBytes: 0,
        });
    }
  },
  20000,
);
