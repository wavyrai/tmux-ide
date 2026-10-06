import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { MirrorService, type MirrorSubscription } from "../../../terminal/mirror/mirror-service.ts";
import { MirrorControlChannel } from "../../../terminal/mirror/control-channel.ts";
import { terminalInputsForPaste } from "./terminal-input-adapter.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary)(
  "delivers exact mixed input to explicit panes despite native navigation",
  async () => {
    expect(isAbsolute(binary!)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "tmux-input-ordering-"));
    const socket = `zz-input-${process.pid}-${randomUUID().slice(0, 8)}`;
    const env = { ...process.env, HOME: root, TMUX: "" };
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const paths = [join(root, "A.bin"), join(root, "B.bin")];
    const expected = [Buffer.alloc(0), Buffer.alloc(0)];
    const operations: unknown[] = [];
    const commands: string[] = [];
    const subscriptions: MirrorSubscription[] = [];
    let mirror: MirrorService | undefined;
    let failure: string | undefined;
    let panes: string[] = [];
    let semantic: string[] = [];
    let serverPid = "";
    let receiverPids: number[] = [];
    const processAbsent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    try {
      const script = join(root, "receiver.cjs");
      writeFileSync(
        script,
        "const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdin.on('data', data => fs.appendFileSync(process.argv[2], data)); process.stdout.write('READY');",
      );
      for (const path of paths) writeFileSync(path, "");
      panes = [
        run(
          "new-session",
          "-d",
          "-s",
          "input",
          "-x",
          "120",
          "-y",
          "24",
          "-P",
          "-F",
          "#{pane_id}",
          `${quote(process.execPath)} ${quote(script)} ${quote(paths[0]!)}`,
        ),
      ];
      panes.push(
        run(
          "split-window",
          "-h",
          "-t",
          panes[0]!,
          "-P",
          "-F",
          "#{pane_id}",
          `${quote(process.execPath)} ${quote(script)} ${quote(paths[1]!)}`,
        ),
      );
      serverPid = run("display-message", "-p", "#{pid}");
      receiverPids = panes.map((pane) =>
        Number(run("display-message", "-p", "-t", pane, "#{pane_pid}")),
      );
      for (const pane of panes)
        await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toBe("READY"));
      mirror = new MirrorService({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        // Custom IO deliberately qualifies stock-compatible send-keys on both
        // servers. Native guarded OwnedViewer dispatch is a separate path.
        createIo: (session, handlers) => {
          const io = new MirrorControlChannel({
            executable: binary!,
            socketName: socket,
            configFile: "/dev/null",
            session,
            handlers,
          });
          const send = io.send.bind(io);
          io.send = (command, callback) => {
            commands.push(command);
            send(command, callback);
          };
          return io;
        },
      });
      const description = await mirror.describeSession("input");
      semantic = panes.map((pane) => run("show-options", "-pqv", "-t", pane, "@tmux_ide_pane_id"));
      for (const id of semantic) {
        expect(description.panes.some((p) => p.semanticPaneId === id)).toBe(true);
        let seeded = false;
        subscriptions.push(
          await mirror.subscribe({
            session: "input",
            semanticPaneId: id,
            onEvent: (event) => {
              if (event.type === "seed") seeded = true;
            },
          }),
        );
        await vi.waitFor(() => expect(seeded).toBe(true));
      }
      const check = async () => {
        await vi.waitFor(
          () =>
            paths.forEach((path, i) =>
              expect(readFileSync(path).toString("hex")).toBe(expected[i]!.toString("hex")),
            ),
          { timeout: 5000 },
        );
      };
      const navigate = (target: number) => {
        // A separate native client deliberately selects the opposite target.
        run("select-pane", "-t", panes[1 - target]!);
        operations.push({ navigate: panes[1 - target], inputTarget: panes[target] });
      };
      const textA = "界😀".repeat(70) + " '$HOME' `echo NO` ; \\ \"\nend";
      navigate(0);
      mirror.sendText("input", semantic[0]!, textA);
      expected[0] = Buffer.from(textA);
      // Same-turn pane switch must flush A without redirecting it to active B.
      navigate(1);
      const binaryB = Buffer.from([0, 0x80, 0xff, 0x1b, 0x7f]);
      mirror.sendBytes("input", semantic[1]!, binaryB);
      expected[1] = binaryB;
      await check();
      const paste = "a".repeat(1017) + "😀界e\u0301" + "z".repeat(1100);
      const frames = terminalInputsForPaste(paste);
      navigate(0);
      for (const frame of frames) {
        mirror.sendText("input", semantic[0]!, frame.data);
        operations.push({ pasteMessageChars: frame.data.length });
        // Independently delivered transport messages can flush in separate turns.
        await new Promise<void>((resolve) => setImmediate(resolve));
        navigate(0);
      }
      expected[0] = Buffer.concat([expected[0]!, Buffer.from("\x1b[200~" + paste + "\x1b[201~")]);
      navigate(1);
      mirror.sendText("input", semantic[1]!, "B界");
      mirror.sendKey("input", semantic[1]!, "Enter");
      mirror.sendKey("input", semantic[1]!, "C-c");
      expected[1] = Buffer.concat([expected[1]!, Buffer.from("B界\r\x03")]);
      navigate(0);
      mirror.sendKey("input", semantic[0]!, "Enter");
      mirror.sendKey("input", semantic[0]!, "C-c");
      expected[0] = Buffer.concat([expected[0]!, Buffer.from([13, 3])]);
      await check();
      // Sanity check: these two distinct streams are not interchangeable.
      expect(readFileSync(paths[0]!).equals(expected[1]!)).toBe(false);
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      for (const sub of subscriptions) {
        try {
          sub.close();
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
      try {
        await mirror?.dispose();
      } catch (error) {
        cleanupErrors.push(String(error));
      } finally {
        const killed = spawnSync(binary!, ["-L", socket, "kill-server"], {
          env,
          stdio: "ignore",
          timeout: 5000,
        });
        if (killed.error) cleanupErrors.push(String(killed.error));
      }
      const absent = spawnSync(binary!, ["-L", socket, "has-session"], {
        env,
        stdio: "ignore",
        timeout: 5000,
      }).status;
      try {
        await vi.waitFor(() => {
          for (const pid of receiverPids) expect(processAbsent(pid)).toBe(true);
        });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      const receipt = {
        route:
          "MirrorService custom IO: stock-compatible control send-keys; no OwnedViewer dispatch",
        binary,
        version: execFileSync(binary!, ["-V"], { encoding: "utf8" }).trim(),
        binarySha256: hash(binary!),
        testSha256: hash(fileURLToPath(import.meta.url)),
        adapterSha256: hash(fileURLToPath(new URL("./terminal-input-adapter.ts", import.meta.url))),
        coalescerSha256: hash(
          fileURLToPath(new URL("../../../terminal/protocol/input-coalescer.ts", import.meta.url)),
        ),
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        root,
        socket,
        serverPid,
        panes,
        semantic,
        operations,
        commands,
        expectedHex: expected.map((b) => b.toString("hex")),
        receivedHex: paths.map((path) => {
          try {
            return readFileSync(path).toString("hex");
          } catch {
            return null;
          }
        }),
        cleanup: {
          errors: cleanupErrors,
          serverAbsentStatus: absent,
          receiverPids,
          receiverProcessesAbsent: receiverPids.map(processAbsent),
        },
        failure,
      };
      writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
      console.log(`Input ordering receipt: ${join(root, "receipt.json")}`);
      expect(absent).toBe(1);
      expect(cleanupErrors).toEqual([]);
    }
  },
  20000,
);
