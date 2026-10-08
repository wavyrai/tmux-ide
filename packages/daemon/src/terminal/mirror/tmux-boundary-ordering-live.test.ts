import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService, type MirrorSubscription } from "./mirror-service.ts";
import { decodeNativeGridCapture } from "./native-grid-capture.ts";
import type { MirrorPaneEvent } from "./events.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary).each([false, true])(
  "preserves post-capture output behind sibling backlog (mixed subscribers=%s)",
  async (mixedSubscribers) => {
    expect(isAbsolute(binary!)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "tmux-boundary-ordering-"));
    const socket = `zz-boundary-order-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const trace: Array<{ kind: "output" | "capture"; text: string }> = [];
    const faults: unknown[] = [];
    let channel: MirrorControlChannel | undefined;
    let mirror: MirrorService | undefined;
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let subscription: MirrorSubscription | undefined;
    let plainSubscription: MirrorSubscription | undefined;
    const plainEvents: MirrorPaneEvent[] = [];
    const nativeEvents: MirrorPaneEvent[] = [];
    let snapshot: TerminalReplicaSnapshot | null = null;
    let slowReader: ChildProcess["stdout"] = null;
    let passive: ChildProcess | undefined;
    let armed = false;
    let captureSeen = false;
    let hookPending = false;
    let readerStalled = false;
    let target = "";
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
    const waitFor = (assertion: () => void) =>
      vi.waitFor(assertion, { timeout: 4500, interval: 10 });
    try {
      // Raw input makes each producer action explicit: no prompt or tty echo.
      const producer = join(root, "producer.cjs");
      writeFileSync(
        producer,
        [
          "process.stdin.setRawMode(true);",
          "process.stdout.write('BEFORE');",
          "process.stdin.on('data', bytes => {",
          "  for (const byte of bytes) process.stdout.write(byte === 66",
          "    ? 'B'.repeat(2000000) + '\\r\\nFLOOD_DONE' : '\\rAFTER!\\x1b[?2004h');",
          "});",
        ].join("\n"),
      );
      const command = `${quote(process.execPath)} ${quote(producer)}`;
      target = run(
        "new-session",
        "-d",
        "-s",
        "boundary",
        "-x",
        "80",
        "-y",
        "24",
        "-P",
        "-F",
        "#{pane_id}",
        command,
      );
      const sibling = run(
        "split-window",
        "-d",
        "-t",
        "boundary",
        "-P",
        "-F",
        "#{pane_id}",
        command,
      );
      await waitFor(() => {
        expect(run("capture-pane", "-p", "-t", target)).toBe("BEFORE");
        expect(run("capture-pane", "-p", "-t", sibling)).toBe("BEFORE");
      });
      const nativeProbe = spawnSync(
        binary!,
        ["-L", socket, "capture-pane", "-p", "-R", "-t", target],
        { encoding: "utf8", timeout: 5000, env: { ...process.env, TMUX: "" } },
      );
      const supportsNative =
        nativeProbe.status === 0 && decodeNativeGridCapture(nativeProbe.stdout) !== null;
      // Keep PTY reads enabled while the tested reader is stalled. Otherwise
      // tmux can stop reading the producer before the post-capture write.
      passive = spawn(
        binary!,
        ["-L", socket, "-C", "attach", "-t", "boundary", "-f", "no-output,ignore-size"],
        { env: { ...process.env, TMUX: "" }, stdio: ["pipe", "ignore", "ignore"] },
      );
      await waitFor(() => {
        expect(passive!.exitCode).toBeNull();
        expect(run("list-clients", "-t", "boundary", "-F", "#{client_pid}").split("\n")).toContain(
          String(passive!.pid),
        );
      });
      mirror = new MirrorService({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        // Real IO, including real byte order. Custom IO deliberately qualifies
        // ordinary -R capture rather than the separately negotiated guarded -Q.
        createIo: (session, handlers) => {
          channel = new MirrorControlChannel({
            executable: binary!,
            socketName: socket,
            configFile: "/dev/null",
            session,
            handlers: {
              ...handlers,
              onOutput: (pane, data, ...rest) => {
                if (armed && pane === target)
                  trace.push({ kind: "output", text: Buffer.from(data).toString() });
                handlers.onOutput(pane, data, ...rest);
              },
            },
          });
          const recordCapture = (lines: readonly string[]) => {
            const capture = decodeNativeGridCapture(lines.join("\n"));
            const captureText = capture
              ? capture.grid
                  .map((row) =>
                    row.cells.map((cell) => (cell.width === 0 ? "" : cell.text)).join(""),
                  )
                  .join("\n")
                  .trimEnd()
              : lines.join("\n").trimEnd();
            trace.push({ kind: "capture", text: captureText });
          };
          const stallReader = () => {
            if (readerStalled) return;
            readerStalled = true;
            slowReader = (channel as unknown as { proc: ChildProcess }).proc.stdout;
            expect(slowReader).not.toBeNull();
            slowReader!.pause();
            run("send-keys", "-t", sibling, "-l", "B");
            // Keep this injection synchronous: the actual capture is dispatched
            // only after sibling output has begun. tmux still schedules every
            // byte; no received event is fabricated or reordered.
            const deadline = Date.now() + 3000;
            let content: string;
            do {
              content = run("capture-pane", "-p", "-t", sibling);
            } while (!content.includes("BBBBBBBBBBBBBBBB") && Date.now() < deadline);
            expect(content).toContain("BBBBBBBBBBBBBBBB");
          };
          const commandList = channel.commandListInline.bind(channel);
          const commandInline = channel.commandInline.bind(channel);
          const armCollector = channel.armAtomicPaneSnapshotCollector.bind(channel);
          channel.armAtomicPaneSnapshotCollector = (spec, timeout) => {
            // A pause collector must finish while the reader is running. Stall
            // only when the subsequent authenticated snapshot is armed.
            if (!armed || captureSeen || spec.kind === "pause") return armCollector(spec, timeout);
            const accepted = armCollector(
              {
                ...spec,
                onSettled: (result) => {
                  if (result.ok) recordCapture(result.captureLines);
                  spec.onSettled(result);
                },
              },
              timeout,
            );
            if (accepted) {
              captureSeen = true;
              hookPending = true;
              stallReader();
            }
            return accepted;
          };
          channel.commandInline = (command, callback) => {
            if (hookPending && command.includes("set-hook")) {
              hookPending = false;
              return commandList(
                `${command} ; set-option -g @boundary_capture_taken 1`,
                2,
                0,
                callback,
              );
            }
            return commandInline(command, callback);
          };
          channel.commandListInline = (command, count, index, callback) => {
            if (hookPending && command.includes("set-hook")) {
              hookPending = false;
              return commandList(
                `${command} ; set-option -g @boundary_capture_taken 1`,
                count + 1,
                index,
                callback,
              );
            }
            if (
              armed &&
              !captureSeen &&
              command.includes("capture-pane") &&
              command.includes(`-t ${target}`)
            ) {
              captureSeen = true;
              stallReader();
              // Ordinary capture baseline and the owned-hook path use the
              // same real execution fence and preserve reply-slot accounting.
              return commandList(
                `${command} ; set-option -g @boundary_capture_taken 1`,
                count + 1,
                index,
                (reply) => {
                  recordCapture(reply.lines);
                  callback(reply);
                },
              );
            }
            return commandList(command, count, index, callback);
          };
          return channel;
        },
      });
      const description = await mirror.describeSession("boundary");
      // split-window -d preserves the target as the active pane.
      const pane = description.panes.find((candidate) => candidate.active);
      expect(pane).toBeDefined();
      const subscribe = mirror.subscribe.bind(mirror);
      mirror.subscribe = async (request) => {
        const retained = await subscribe({
          ...request,
          onEvent: (event) => {
            if (request.nativeBootstrap) nativeEvents.push(event);
            request.onEvent(event);
          },
        });
        subscription ??= retained;
        return retained;
      };
      owner = new SessionRuntimeTerminalReplicaOwner(
        randomUUID(),
        "boundary",
        pane!.semanticPaneId,
        mirror,
        { incarnation: randomUUID(), initialRevision: 0, onFault: (fault) => faults.push(fault) },
      );
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
        else if (update.type === "terminal.patch" && snapshot)
          snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
      });
      await waitFor(() => expect(text()).toBe("BEFORE"));
      if (mixedSubscribers) {
        plainSubscription = await mirror.subscribe({
          session: "boundary",
          semanticPaneId: pane!.semanticPaneId,
          nativeBootstrap: false,
          onEvent: (event) => plainEvents.push(event),
        });
        await waitFor(() => expect(plainEvents.some((event) => event.type === "seed")).toBe(true));
        plainEvents.length = 0;
      }
      nativeEvents.length = 0;
      armed = true;
      subscription!.reseed();
      await waitFor(() => expect(run("show-options", "-gqv", "@boundary_capture_taken")).toBe("1"));
      const coordinates = () =>
        run("display-message", "-p", "-t", target, "#{history_size} #{cursor_x} #{cursor_y}");
      const before = coordinates();
      run("send-keys", "-t", target, "-l", "A");
      await waitFor(() => expect(run("capture-pane", "-p", "-t", target)).toBe("AFTER!"));
      expect(coordinates()).toBe(before);
      slowReader!.resume();
      await waitFor(() => expect(trace.some((event) => event.kind === "capture")).toBe(true));
      expect(trace.find((event) => event.kind === "capture")?.text).toBe("BEFORE");
      await vi.waitFor(
        () => {
          expect(text(), JSON.stringify(trace)).toBe("AFTER!");
          expect(faults).toEqual([]);
          expect(snapshot?.modes.bracketedPaste).toBe(true);
          if (supportsNative) {
            expect(nativeEvents.some((event) => event.type === "seed" && event.native)).toBe(true);
            expect(
              nativeEvents.some((event) => event.type === "seed" && event.requiresNativeRecapture),
            ).toBe(false);
          }
          if (mixedSubscribers) {
            const plainSeed = plainEvents.find((event) => event.type === "seed");
            expect(
              plainSeed?.type === "seed" && Buffer.from(plainSeed.data).toString().trimEnd(),
            ).toBe("BEFORE");
            expect(plainSeed?.type === "seed" && plainSeed.native).toBeUndefined();
            expect(
              plainEvents
                .filter((event) => event.type === "delta")
                .map((event) => Buffer.from(event.data).toString())
                .join(""),
            ).toBe("\rAFTER!\x1b[?2004h");
          }
        },
        { timeout: 1500, interval: 25 },
      );
    } finally {
      slowReader?.resume();
      try {
        try {
          await plainSubscription?.close();
          await owner?.dispose();
        } finally {
          await mirror?.dispose();
        }
      } finally {
        try {
          spawnSync(binary!, ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5000 });
          expect(
            spawnSync(binary!, ["-L", socket, "has-session"], { stdio: "ignore", timeout: 5000 })
              .status,
          ).toBe(1);
        } finally {
          passive?.stdin?.end();
          if (passive && passive.exitCode === null) passive.kill();
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
  20000,
);
