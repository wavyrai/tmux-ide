import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { MirrorControlChannel } from "../mirror/control-channel.ts";
import type { MirrorFlowRecoveryObservation } from "../mirror/session-channel.ts";
import { SessionRuntimeRegistry } from "./registry.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-runtime-opening-${process.pid}-${randomUUID().slice(0, 8)}`;
const directory = mkdtempSync(join(tmpdir(), "tmux-runtime-opening-"));
const configFile = join(directory, "tmux.conf");
writeFileSync(configFile, "set-option -g history-limit 30000\n");
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-L", socketName, "-f", configFile, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
afterAll(() => {
  spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  rmSync(directory, { recursive: true, force: true });
});

function text(snapshot: TerminalReplicaSnapshot, includeHistory = false): string {
  return (includeHistory ? [...snapshot.history, ...snapshot.grid] : snapshot.grid)
    .map((row) =>
      row.cells
        .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
        .join("")
        .trimEnd(),
    )
    .join("\n")
    .trimEnd();
}

describe.skipIf(!available)("native concurrent runtime opening", () => {
  it.each(
    ["off", "top", "bottom"].flatMap((border) =>
      [0, 20000].map((historyLines) => ({ border, historyLines })),
    ),
  )(
    "shares native pane replicas across two clients with $border borders and $historyLines history lines",
    async ({ border, historyLines }) => {
      const session = `opening-${border}-${historyLines}`;
      const script = join(directory, `${session}.mjs`);
      writeFileSync(
        script,
        `process.stdin.setRawMode(true);process.stdin.on('data', data=>process.stdout.write(data));process.stdout.write(Array.from({length:${historyLines}},(_,i)=>process.argv[2]+'-'+i+'\\r\\n').join('')+process.argv[2]);setInterval(()=>{},10000);`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "120",
        "-y",
        "40",
        `${process.execPath} ${script} ALPHA`,
      );
      tmux("set-option", "-t", session, "status", "off");
      tmux("split-window", "-h", "-t", session, `${process.execPath} ${script} BETA`);
      tmux("split-window", "-v", "-t", session, `${process.execPath} ${script} GAMMA`);
      tmux("set-option", "-w", "-t", session, "pane-border-status", border);
      const panes = tmux("list-panes", "-t", session, "-F", "#{pane_id}").split("\n");
      const labels = ["ALPHA", "BETA", "GAMMA"];
      panes.forEach((pane, index) =>
        tmux("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", `pane.opening.${index}`),
      );
      await vi.waitFor(() =>
        panes.forEach((pane, index) =>
          expect(tmux("capture-pane", "-p", "-t", pane).split("\n").at(-1)).toBe(labels[index]),
        ),
      );
      let channels = 0;
      let captures = 0;
      const recoveries: MirrorFlowRecoveryObservation[] = [];
      const registry = new SessionRuntimeRegistry({
        generation: randomUUID(),
        mirror: {
          onFlowRecoveryObserved: (_session, observation) => {
            recoveries.push(observation);
            if (recoveries.length > 64) recoveries.shift();
          },
          createIo: (target, handlers) => {
            channels++;
            const io = new MirrorControlChannel({
              session: target,
              handlers,
              socketName,
              configFile,
            });
            const capture = io.commandListInline.bind(io);
            io.commandListInline = (command, count, index, onReply) => {
              if (command.includes("capture-pane -p -e -J")) captures++;
              capture(command, count, index, onReply);
            };
            return io;
          },
          internalReadHookEmission: (pane, marker) => ({
            bufferName: "opening-observer",
            signalChannel: "opening-observer",
            record: `${pane}|${marker}|workspace.pane.read|`,
          }),
        },
      });
      const clients = [
        registry.connect(session, "opentui", "opening:tui"),
        registry.connect(session, "web", "opening:web"),
      ];
      const snapshots = clients.map(() => new Map<number, TerminalReplicaSnapshot>());
      const incarnations = clients.map(() => new Map<number, string>());
      try {
        // Start all six subscriptions in the same turn. Real control replies
        // must remain correctly associated despite different pane dimensions.
        const started = performance.now();
        const subscriptions = await Promise.all(
          clients.flatMap((client, clientIndex) =>
            panes.map((_pane, paneIndex) =>
              client.subscribeReplica(`pane.opening.${paneIndex}`, (update) => {
                const target = snapshots[clientIndex]!;
                if (update.type === "terminal.seed") target.set(paneIndex, update.snapshot);
                else if (update.type === "terminal.patch" && target.has(paneIndex))
                  target.set(
                    paneIndex,
                    applyTerminalReplicaPatch(target.get(paneIndex)!, update.patch),
                  );
                incarnations[clientIndex]!.set(paneIndex, update.incarnation);
              }),
            ),
          ),
        );
        const openingMs = performance.now() - started;
        expect(captures).toBe(panes.length);
        console.info(
          JSON.stringify({
            border,
            historyLines,
            openingMs: Math.round(openingMs),
            captures,
            channels,
          }),
        );
        let stage = "opening";
        const verifyNative = () => {
          // Check every pane's cheap convergence signals before walking any
          // full history. Repeatedly comparing already-ready 20k-line siblings
          // would block the control reader that the remaining pane needs.
          for (const [index, pane] of panes.entries()) {
            const [cols, rows] = tmux(
              "display-message",
              "-p",
              "-t",
              pane,
              "#{pane_width} #{pane_height}",
            )
              .split(" ")
              .map(Number);
            const historySize = Number(
              tmux("display-message", "-p", "-t", pane, "#{history_size}"),
            );
            if (historyLines > 0) expect(historySize).toBeGreaterThan(historyLines - 100);
            for (const snapshot of snapshots) {
              expect(snapshot.get(index)!.history, `${stage}: ${pane} history`).toHaveLength(
                historySize,
              );
              expect(snapshot.get(index)).toMatchObject({ cols, rows });
            }
          }
          for (const [index, pane] of panes.entries()) {
            const nativeHistory = tmux("capture-pane", "-p", "-S", "-", "-t", pane);
            const nativeVisible = tmux("capture-pane", "-p", "-t", pane);
            for (const snapshot of snapshots) {
              expect(text(snapshot.get(index)!)).toBe(nativeVisible);
              expect(text(snapshot.get(index)!, true)).toBe(nativeHistory);
            }
            expect(incarnations[0]!.get(index)).toBe(incarnations[1]!.get(index));
          }
        };
        verifyNative();
        const priorIncarnations = new Map(incarnations[0]);
        await clients[1]!.close();
        clients[1] = registry.connect(session, "web", "opening:web:reconnected");
        snapshots[1]!.clear();
        incarnations[1]!.clear();
        const reconnecting = panes.map((_pane, paneIndex) =>
          clients[1]!.subscribeReplica(`pane.opening.${paneIndex}`, (update) => {
            if (update.type === "terminal.seed") snapshots[1]!.set(paneIndex, update.snapshot);
            else if (update.type === "terminal.patch" && snapshots[1]!.has(paneIndex))
              snapshots[1]!.set(
                paneIndex,
                applyTerminalReplicaPatch(snapshots[1]!.get(paneIndex)!, update.patch),
              );
            incarnations[1]!.set(paneIndex, update.incarnation);
          }),
        );
        const pendingReconnect = Promise.all(reconnecting);
        void pendingReconnect.catch(() => undefined);
        tmux("send-keys", "-t", panes[0]!, "-l", "--", "-LIVE");
        const reconnected = await pendingReconnect;
        await vi.waitFor(
          () => {
            expect(text(snapshots[0]!.get(0)!)).toContain("ALPHA-LIVE");
            verifyNative();
          },
          { timeout: 3000 },
        );
        expect(incarnations[1]).toEqual(priorIncarnations);
        expect(captures).toBe(panes.length);
        stage = "resize";
        const resizeStarted = performance.now();
        tmux("resize-window", "-t", session, "-x", "93", "-y", "31");
        // This is a functional convergence test, not a reference-host latency
        // budget. Shared Linux runners need about seven seconds even for the
        // initial 20k-line capture above; allow the full reseed to finish while
        // preserving exact native history, geometry and both-client assertions.
        await vi.waitFor(verifyNative, { timeout: 10000 });
        console.info(
          JSON.stringify({
            border,
            historyLines,
            resizeMs: Math.round(performance.now() - resizeStarted),
          }),
        );
        expect(channels).toBe(1);
        expect(registry.qualificationSnapshot().controlChannels).toBe(1);
        expect(Object.keys(registry.qualificationSnapshot().sessions[0]!.replicas)).toHaveLength(3);
        await Promise.all(
          [...subscriptions, ...reconnected].map((subscription) => subscription.close()),
        );
      } catch (error) {
        console.error(JSON.stringify({ border, historyLines, captures, recoveries }));
        throw error;
      } finally {
        await Promise.all(clients.map((client) => client.close()));
        await registry.dispose();
      }
    },
    30000,
  );
});

describe.skipIf(!available)("native pane replacement during opening", () => {
  it("rejects both pending clients and fences late capture replies from a replacement pane", async () => {
    const session = "opening-replacement";
    const script = join(directory, "replacement.mjs");
    writeFileSync(
      script,
      "process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write(data));process.stdout.write(process.argv[2]);setInterval(()=>{},10000);",
    );
    tmux(
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "120",
      "-y",
      "40",
      `${process.execPath} ${script} SIBLING`,
    );
    const siblingPane = tmux("display-message", "-p", "-t", session, "#{pane_id}");
    const oldPane = tmux(
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      session,
      `${process.execPath} ${script} OLD`,
    );
    tmux("set-option", "-p", "-t", siblingPane, "@tmux_ide_pane_id", "pane.race.sibling");
    tmux("set-option", "-p", "-t", oldPane, "@tmux_ide_pane_id", "pane.race.replaced");
    await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", oldPane)).toBe("OLD"));
    const lateReplies: Array<() => void> = [];
    let channels = 0;
    const registry = new SessionRuntimeRegistry({
      generation: randomUUID(),
      mirror: {
        createIo: (target, handlers) => {
          channels++;
          const io = new MirrorControlChannel({
            session: target,
            handlers,
            socketName,
            configFile,
          });
          const capture = io.commandListInline.bind(io);
          io.commandListInline = (command, count, index, onReply) => {
            if (command.includes("capture-pane -p -e -J") && command.endsWith(`-t ${oldPane}`))
              capture(command, count, index, (reply) => lateReplies.push(() => onReply(reply)));
            else capture(command, count, index, onReply);
          };
          return io;
        },
      },
    });
    const clients = [
      registry.connect(session, "opentui", "race:tui"),
      registry.connect(session, "web", "race:web"),
    ];
    let sibling: TerminalReplicaSnapshot | undefined;
    let siblingIncarnation: string | undefined;
    try {
      await clients[0]!.subscribeReplica("pane.race.sibling", (update) => {
        if (update.type === "terminal.seed") sibling = update.snapshot;
        else if (update.type === "terminal.patch" && sibling)
          sibling = applyTerminalReplicaPatch(sibling, update.patch);
        siblingIncarnation = update.incarnation;
      });
      const originalSiblingIncarnation = siblingIncarnation;
      let failures: PromiseSettledResult<unknown>[] | undefined;
      void Promise.allSettled(
        clients.map((client) => client.subscribeReplica("pane.race.replaced", () => undefined)),
      ).then((results) => {
        failures = results;
      });
      await vi.waitFor(() => expect(lateReplies.length).toBeGreaterThan(0));
      tmux("kill-pane", "-t", oldPane);
      await vi.waitFor(
        () => expect(failures?.map((result) => result.status)).toEqual(["rejected", "rejected"]),
        { timeout: 3000 },
      );
      const replacement = tmux(
        "split-window",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        session,
        `${process.execPath} ${script} NEW`,
      );
      tmux("set-option", "-p", "-t", replacement, "@tmux_ide_pane_id", "pane.race.replaced");
      await vi.waitFor(async () => {
        expect(tmux("capture-pane", "-p", "-t", replacement)).toBe("NEW");
        expect(
          (await clients[0]!.describe()).panes.some(
            (pane) => pane.semanticPaneId === "pane.race.replaced",
          ),
        ).toBe(true);
      });
      const snapshots: Array<TerminalReplicaSnapshot | undefined> = [];
      const replacementPublications: string[] = [];
      await Promise.all(
        clients.map((client, index) =>
          client.subscribeReplica("pane.race.replaced", (update) => {
            if (update.type === "terminal.seed") snapshots[index] = update.snapshot;
            else if (update.type === "terminal.patch" && snapshots[index])
              snapshots[index] = applyTerminalReplicaPatch(snapshots[index]!, update.patch);
            if (snapshots[index]) replacementPublications.push(text(snapshots[index]!));
          }),
        ),
      );
      for (const release of lateReplies) release();
      tmux("send-keys", "-t", replacement, "-l", "--", "-LIVE");
      tmux("send-keys", "-t", siblingPane, "-l", "--", "-LIVE");
      await vi.waitFor(() => {
        expect(snapshots.map((snapshot) => text(snapshot!))).toEqual(["NEW-LIVE", "NEW-LIVE"]);
        expect(text(sibling!)).toBe("SIBLING-LIVE");
      });
      expect(replacementPublications.length).toBeGreaterThanOrEqual(4);
      expect(
        replacementPublications.every(
          (value) => value.startsWith("NEW") && "NEW-LIVE".startsWith(value),
        ),
      ).toBe(true);
      expect(siblingIncarnation).toBe(originalSiblingIncarnation);
      expect(channels).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await registry.dispose();
    }
  }, 10000);
});
