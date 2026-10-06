import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
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

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary)(
  "preserves post-capture output during ordinary reseed behind sibling output backlog",
  async () => {
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
    let snapshot: TerminalReplicaSnapshot | null = null;
    let slowReader: ChildProcess["stdout"] = null;
    let armed = false;
    let captureSeen = false;
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
          "    ? 'B'.repeat(2000000) + '\\r\\nFLOOD_DONE' : '\\rAFTER!');",
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
          const commandList = channel.commandListInline.bind(channel);
          channel.commandListInline = (command, count, index, callback) => {
            if (
              armed &&
              !captureSeen &&
              command.includes("capture-pane") &&
              command.includes(`-t ${target}`)
            ) {
              captureSeen = true;
              // The option is an execution fence, observed through another
              // client while this reader is stalled. Account for its reply.
              return commandList(
                `${command} ; set-option -g @boundary_capture_taken 1`,
                count + 1,
                index,
                (reply) => {
                  const capture = decodeNativeGridCapture(reply.lines.join("\n"));
                  const captureText = capture
                    ? capture.grid
                        .map((row) =>
                          row.cells.map((cell) => (cell.width === 0 ? "" : cell.text)).join(""),
                        )
                        .join("\n")
                        .trimEnd()
                    : reply.lines.join("\n").trimEnd();
                  trace.push({ kind: "capture", text: captureText });
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
        subscription = await subscribe(request);
        return subscription;
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
      // Controlled slow-reader injection into the real child pipe. No synthetic
      // output or callback reordering: tmux itself schedules every wire byte.
      slowReader = (channel as unknown as { proc: ChildProcess }).proc.stdout;
      expect(slowReader).not.toBeNull();
      slowReader!.pause();
      armed = true;
      run("send-keys", "-t", sibling, "-l", "B");
      await waitFor(() =>
        expect(run("capture-pane", "-p", "-t", sibling)).toContain("BBBBBBBBBBBBBBBB"),
      );
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
        },
        { timeout: 1500, interval: 25 },
      );
    } finally {
      slowReader?.resume();
      try {
        try {
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
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
  20000,
);
