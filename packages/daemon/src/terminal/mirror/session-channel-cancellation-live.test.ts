import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService, type MirrorSubscription } from "./mirror-service.ts";
import type { MirrorPaneEvent } from "./events.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary)(
  "drains cancelled unread pane A before admitting pane B through SessionChannel",
  async () => {
    expect(isAbsolute(binary!)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "tmux-session-cancellation-"));
    const socket = `zz-session-cancel-${process.pid}-${randomUUID().slice(0, 8)}`;
    const env = { ...process.env, HOME: root, TMUX: "" };
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const trace: Array<{ phase: string; [key: string]: unknown }> = [];
    const commands: string[] = [];
    const wireChunks: string[] = [];
    const record = (phase: string, data: Record<string, unknown> = {}) =>
      trace.push({ phase, ...data });
    const waitFor = (assertion: () => void) =>
      vi.waitFor(assertion, { timeout: 4500, interval: 10 });
    let channel: MirrorControlChannel | undefined;
    let mirror: MirrorService | undefined;
    let a: MirrorSubscription | undefined;
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let reader: ChildProcess["stdout"] = null;
    let snapshot: TerminalReplicaSnapshot | null = null;
    let paneA = "",
      paneB = "",
      semanticB = "";
    let armed = false;
    let cancelledNonce: string | null = null;
    let sawCancelledStart = false;
    let markerQueued = false;
    let bSubscribed = false;
    let serverPid = "";
    let failure: string | undefined;
    const aEvents: MirrorPaneEvent[] = [],
      bEvents: MirrorPaneEvent[] = [];
    const faults: string[] = [];
    const markerOption = `@tmux_ide_cancel_executed_${randomUUID().replaceAll("-", "")}`;
    const text = () =>
      snapshot
        ? [...snapshot.history, ...snapshot.grid]
            .map((row) =>
              row.cells
                .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                .join("")
                .trimEnd(),
            )
            .join("\n")
            .trimEnd()
        : "";
    const identity = {
      binary,
      version: execFileSync(binary!, ["-V"], { encoding: "utf8" }).trim(),
      sha256: createHash("sha256").update(readFileSync(binary!)).digest("hex"),
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      socket,
      testSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      sessionChannelSha256: createHash("sha256")
        .update(readFileSync(new URL("./session-channel.ts", import.meta.url)))
        .digest("hex"),
    };
    try {
      const producer = join(root, "producer.cjs");
      writeFileSync(
        producer,
        "process.stdin.setRawMode(true); process.stdout.write(process.argv[2]); process.stdin.on('data', bytes => { for (const _byte of bytes) process.stdout.write('|B-TAIL|'); });\n",
      );
      paneA = run(
        "new-session",
        "-d",
        "-s",
        "cancellation",
        "-x",
        "160",
        "-y",
        "24",
        "-P",
        "-F",
        "#{pane_id}",
        `${quote(process.execPath)} ${quote(producer)} A-BASE`,
      );
      paneB = run(
        "split-window",
        "-d",
        "-h",
        "-t",
        paneA,
        "-P",
        "-F",
        "#{pane_id}",
        `${quote(process.execPath)} ${quote(producer)} B-BASE`,
      );
      run("set-option", "-t", "cancellation", "status", "off");
      serverPid = run("display-message", "-p", "#{pid}");
      await waitFor(() => {
        expect(run("capture-pane", "-p", "-t", paneA)).toBe("A-BASE");
        expect(run("capture-pane", "-p", "-t", paneB)).toBe("B-BASE");
      });
      const nativeProbe = spawnSync(
        binary!,
        ["-L", socket, "capture-pane", "-p", "-R", "-t", paneB],
        { encoding: "utf8", timeout: 5000, env },
      );
      const supportsNative = nativeProbe.status === 0 && nativeProbe.stdout.includes('"version":2');
      mirror = new MirrorService({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        // Custom real IO qualifies the stock-compatible path on both servers;
        // native-Q has its own retained live qualification.
        createIo: (session, handlers) => {
          channel = new MirrorControlChannel({
            executable: binary!,
            socketName: socket,
            configFile: "/dev/null",
            session,
            handlers,
          });
          const start = channel.start.bind(channel);
          channel.start = async () => {
            await start();
            reader = (channel as unknown as { proc: ChildProcess }).proc.stdout;
            expect(reader).not.toBeNull();
            reader!.on("data", (chunk: Buffer) =>
              wireChunks.push(Buffer.from(chunk).toString("base64")),
            );
          };
          const arm = channel.armAtomicPaneSnapshotCollector.bind(channel);
          channel.armAtomicPaneSnapshotCollector = (spec, timeout) => {
            const accepted = arm(
              {
                ...spec,
                onProgress: (progress) => {
                  if (spec.nonce === cancelledNonce && progress.started) sawCancelledStart = true;
                  spec.onProgress?.(progress);
                },
                onSettled: (result) => {
                  record("collector-settled", {
                    nonce: spec.nonce,
                    pane: spec.runtimePaneId,
                    ok: result.ok,
                  });
                  spec.onSettled(result);
                },
                onDrained: (reason) => {
                  record("collector-drained", {
                    nonce: spec.nonce,
                    pane: spec.runtimePaneId,
                    reason,
                  });
                  spec.onDrained?.(reason);
                },
              },
              timeout,
            );
            if (accepted) {
              record("collector-admitted", {
                nonce: spec.nonce,
                pane: spec.runtimePaneId,
                kind: spec.kind ?? "snapshot",
              });
              if (
                armed &&
                !cancelledNonce &&
                spec.runtimePaneId === paneA &&
                spec.kind !== "pause"
              ) {
                cancelledNonce = spec.nonce;
                reader!.pause();
                record("snapshot-wire-held", { nonce: cancelledNonce });
              }
            }
            return accepted;
          };
          const commandInline = channel.commandInline.bind(channel);
          channel.commandInline = (command, reply) => {
            commands.push(command);
            commandInline(command, reply);
          };
          const commandList = channel.commandListInline.bind(channel);
          channel.commandListInline = (command, count, resultIndex, callback) => {
            commands.push(command);
            commandList(command, count, resultIndex, callback);
            if (
              cancelledNonce &&
              !markerQueued &&
              command.includes(`set-hook -Rp -t ${paneA} @tmux_ide_atomic_${cancelledNonce}`)
            ) {
              markerQueued = true;
              // This separate same-client command executes after the non-WAIT
              // hook children. Its ordinary reply slot is retained while unread.
              channel!.commandInline(`set-option -g ${markerOption} ${cancelledNonce}`, (reply) => {
                expect(reply.ok).toBe(true);
                record("execution-marker-reply");
              });
            }
          };
          const bounded = channel.commandBoundedInline.bind(channel);
          channel.commandBoundedInline = (command, limits, callback) => {
            commands.push(command);
            const fence = command.startsWith("display-message -p -l tmux-ide-collector-drain-v1:");
            if (fence) record("drain-fence-queued", { nonce: cancelledNonce, command });
            bounded(command, limits, (reply) => {
              if (fence) record("drain-fence-reply", { nonce: cancelledNonce, command, ...reply });
              callback(reply);
            });
          };
          const boundedList = channel.commandListBoundedInline.bind(channel);
          channel.commandListBoundedInline = (command, count, index, limits, callback) => {
            commands.push(command);
            boundedList(command, count, index, limits, callback);
          };
          const request = channel.request.bind(channel);
          channel.request = (command) => {
            commands.push(command);
            return request(command);
          };
          const send = channel.send.bind(channel);
          channel.send = (command, callback) => {
            commands.push(command);
            send(command, callback);
          };
          return channel;
        },
      });
      const description = await mirror.describeSession("cancellation");
      record("description", { panes: description.panes, paneA, paneB });
      const stampedA = run("show-options", "-pqv", "-t", paneA, "@tmux_ide_pane_id");
      const stampedB = run("show-options", "-pqv", "-t", paneB, "@tmux_ide_pane_id");
      const targetA = description.panes.find((p) => p.semanticPaneId === stampedA);
      const targetB = description.panes.find((p) => p.semanticPaneId === stampedB);
      expect(targetA).toBeDefined();
      expect(targetB).toBeDefined();
      semanticB = targetB!.semanticPaneId;
      a = await mirror.subscribe({
        session: "cancellation",
        semanticPaneId: targetA!.semanticPaneId,
        onEvent: (event) => aEvents.push(event),
      });
      await waitFor(() => expect(aEvents.some((e) => e.type === "seed")).toBe(true));
      record("subscribe-A-stable");
      aEvents.length = 0;
      armed = true;
      record("reseed-A");
      a.reseed();
      await waitFor(() => {
        expect(cancelledNonce).not.toBeNull();
        expect(run("show-options", "-gqv", markerOption)).toBe(cancelledNonce);
      });
      record("snapshot-executed-unread", { nonce: cancelledNonce });
      expect(sawCancelledStart).toBe(false);
      expect(aEvents.some((e) => e.type === "seed")).toBe(false);
      const subscribe = mirror.subscribe.bind(mirror);
      mirror.subscribe = async (request) => {
        const sub = await subscribe({
          ...request,
          onEvent: (event) => {
            bEvents.push(event);
            request.onEvent(event);
          },
        });
        if (request.semanticPaneId === semanticB) {
          bSubscribed = true;
          record("subscribe-B-queued");
        }
        return sub;
      };
      owner = new SessionRuntimeTerminalReplicaOwner(
        randomUUID(),
        "cancellation",
        semanticB,
        mirror,
        {
          incarnation: randomUUID(),
          initialRevision: 0,
          onFault: (fault) => faults.push(String(fault)),
        },
      );
      const ready = owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
        else if (update.type === "terminal.patch" && snapshot)
          snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
      });
      void ready.catch(() => {});
      await waitFor(() => expect(bSubscribed).toBe(true));
      expect(trace.some((e) => e.phase === "collector-admitted" && e.pane === paneB)).toBe(false);
      record("close-A");
      await a.close();
      const aCount = aEvents.length;
      expect(trace.some((e) => e.phase === "collector-drained" && e.nonce === cancelledNonce)).toBe(
        false,
      );
      expect(trace.some((e) => e.phase === "collector-admitted" && e.pane === paneB)).toBe(false);
      record("resume-wire");
      reader!.resume();
      await ready;
      await waitFor(() => expect(text()).toBe("B-BASE"));
      const drained = trace.findIndex(
        (e) =>
          e.phase === "collector-drained" && e.nonce === cancelledNonce && e.reason === "fence",
      );
      const admitted = trace.findIndex((e) => e.phase === "collector-admitted" && e.pane === paneB);
      expect(drained).toBeGreaterThanOrEqual(0);
      expect(admitted).toBeGreaterThan(drained);
      const fenceReply = trace.findIndex(
        (e) => e.phase === "drain-fence-reply" && e.nonce === cancelledNonce,
      );
      expect(fenceReply).toBeGreaterThanOrEqual(0);
      expect(drained).toBeGreaterThan(fenceReply);
      const fence = trace[fenceReply]!;
      expect(fence.ok).toBe(true);
      expect(fence.lines).toEqual([String(fence.command).slice("display-message -p -l ".length)]);
      expect(
        Buffer.concat(wireChunks.map((chunk) => Buffer.from(chunk, "base64"))).toString(),
      ).toContain(`%tmux-ide-atomic-v1 ${cancelledNonce} start`);
      expect(aEvents).toHaveLength(aCount);
      expect(aEvents.some((e) => e.type === "seed" || e.type === "delta")).toBe(false);
      expect(
        bEvents.filter((e) => ["reset", "seed", "cursor"].includes(e.type)).map((e) => e.type),
      ).toEqual(["reset", "seed", "cursor"]);
      if (supportsNative) expect(bEvents.some((e) => e.type === "seed" && e.native)).toBe(true);
      record("B-baseline");
      run("send-keys", "-t", paneB, "-l", "x");
      await waitFor(() => expect(run("capture-pane", "-p", "-t", paneB)).toBe("B-BASE|B-TAIL|"));
      record("produce-B-tail");
      await waitFor(() => expect(text()).toBe("B-BASE|B-TAIL|"));
      expect(
        bEvents
          .filter((e) => e.type === "delta")
          .map((e) => Buffer.from(e.data).toString())
          .join(""),
      ).toBe("|B-TAIL|");
      expect(aEvents).toHaveLength(aCount);
      expect(faults).toEqual([]);
      const aligned = `ordinary-aligned-${randomUUID()}`;
      expect(await channel!.request(`display-message -p -l ${aligned}`)).toEqual([aligned]);
      record("ordinary-reply-aligned");
    } catch (error) {
      failure = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally {
      reader?.resume();
      try {
        await a?.close();
        await owner?.dispose();
      } finally {
        try {
          await mirror?.dispose();
        } finally {
          spawnSync(binary!, ["-L", socket, "kill-server"], {
            stdio: "ignore",
            timeout: 5000,
            env,
          });
          const absentStatus = spawnSync(binary!, ["-L", socket, "has-session"], {
            stdio: "ignore",
            timeout: 5000,
            env,
          }).status;
          writeFileSync(
            join(root, "receipt.json"),
            JSON.stringify(
              {
                schema: 1,
                witness: "cancel-A-queued-B",
                identity: { ...identity, serverPid },
                failure,
                trace,
                commands,
                wireChunks,
                aEvents,
                bEvents,
                faults,
                cleanup: { serverAbsent: absentStatus === 1 },
              },
              null,
              2,
            ),
          );
          console.info(`Session cancellation witness retained at ${join(root, "receipt.json")}`);
          expect(absentStatus).toBe(1);
        }
      }
    }
  },
  20000,
);
