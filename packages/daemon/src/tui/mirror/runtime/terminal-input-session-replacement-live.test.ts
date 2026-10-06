import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { MirrorService, type MirrorSubscription } from "../../../terminal/mirror/mirror-service.ts";
import { MirrorControlChannel } from "../../../terminal/mirror/control-channel.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
it.skipIf(!binary)(
  "does not deliver closed subscription input to a same-name replacement session",
  async () => {
    expect(isAbsolute(binary!)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "tmux-input-replacement-"));
    const socket = `zz-input-replacement-${process.pid}-${randomUUID().slice(0, 8)}`;
    const env = { ...process.env, HOME: root, TMUX: "" };
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const absent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const files = [join(root, "old.bin"), join(root, "replacement.bin")];
    const events: string[] = [];
    const identities: Array<{ pane: string; session: string; pid: number }> = [];
    const subscriptions: MirrorSubscription[] = [];
    let mirror: MirrorService | undefined;
    let failure: string | undefined;
    const stamp = "pane.input-replacement";
    const oldExpected = Buffer.from("OLD-BASE\r");
    const freshExpected = Buffer.concat([Buffer.from("FRESH界\r"), Buffer.from([0, 0x80, 0xff])]);
    try {
      const script = join(root, "receiver.cjs");
      writeFileSync(
        script,
        "const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdin.on('data', data => fs.appendFileSync(process.argv[2], data)); process.stdout.write('READY');",
      );
      files.forEach((file) => writeFileSync(file, ""));
      run("new-session", "-d", "-s", "keeper", "sleep 60");
      const create = async (index: number) => {
        const pane = run(
          "new-session",
          "-d",
          "-s",
          "victim",
          "-P",
          "-F",
          "#{pane_id}",
          `${quote(process.execPath)} ${quote(script)} ${quote(files[index]!)}`,
        );
        run("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", stamp);
        identities.push({
          pane,
          session: run("display-message", "-p", "-t", pane, "#{session_id}"),
          pid: Number(run("display-message", "-p", "-t", pane, "#{pane_pid}")),
        });
        await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toBe("READY"));
      };
      await create(0);
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
      await mirror.describeSession("victim");
      let oldSeed = false,
        oldClosed = false;
      const old = await mirror.subscribe({
        session: "victim",
        semanticPaneId: stamp,
        onEvent: (event) => {
          events.push(`old:${event.type}`);
          if (event.type === "seed") oldSeed = true;
          if (event.type === "closed") oldClosed = true;
        },
      });
      subscriptions.push(old);
      await vi.waitFor(() => expect(oldSeed).toBe(true));
      old.sendText("OLD-BASE");
      old.sendKey("Enter");
      await vi.waitFor(() => expect(readFileSync(files[0]!).equals(oldExpected)).toBe(true));
      run("kill-session", "-t", "victim");
      await vi.waitFor(() => {
        expect(oldClosed).toBe(true);
        expect(absent(identities[0]!.pid)).toBe(true);
      });
      events.push("old-close-observed");
      await create(1);
      expect(identities[1]!.session).not.toBe(identities[0]!.session);
      expect(identities[1]!.pane).not.toBe(identities[0]!.pane);
      await mirror.describeSession("victim");
      let freshSeed = false;
      const fresh = await mirror.subscribe({
        session: "victim",
        semanticPaneId: stamp,
        onEvent: (event) => {
          events.push(`fresh:${event.type}`);
          if (event.type === "seed") freshSeed = true;
        },
      });
      subscriptions.push(fresh);
      await vi.waitFor(() => expect(freshSeed).toBe(true));
      events.push("stale-input-after-close");
      // Retained subscriptions have text/key only, no byte API. These calls occur
      // AFTER observed closure; this does not test already-admitted input races.
      old.sendText("STALE-TEXT");
      old.sendKey("Enter");
      old.sendKey("C-c");
      fresh.sendText("FRESH界");
      fresh.sendKey("Enter");
      mirror.sendBytes("victim", stamp, Buffer.from([0, 0x80, 0xff]));
      await vi.waitFor(() =>
        expect(readFileSync(files[1]!).toString("hex")).toBe(freshExpected.toString("hex")),
      );
      expect(readFileSync(files[0]!).equals(oldExpected)).toBe(true);
      // A second old-handle call and fresh acknowledgement prevent an accidental
      // first-use-only guard from satisfying the lifecycle assertion.
      old.sendText("STALE-AGAIN");
      old.sendKey("Enter");
      fresh.sendText("DONE");
      fresh.sendKey("Enter");
      await vi.waitFor(() =>
        expect(readFileSync(files[1]!).toString("hex")).toBe(
          Buffer.concat([freshExpected, Buffer.from("DONE\r")]).toString("hex"),
        ),
      );
      events.push("replacement-exact-bytes");
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      for (const sub of subscriptions) {
        try {
          await sub.close();
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
      const serverAbsentStatus = spawnSync(binary!, ["-L", socket, "has-session"], {
        env,
        stdio: "ignore",
        timeout: 5000,
      }).status;
      try {
        await vi.waitFor(() =>
          identities.forEach((identity) => expect(absent(identity.pid)).toBe(true)),
        );
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      const receipt = {
        route:
          "MirrorService custom IO, stock-compatible control; post-close retained text/key input only",
        root,
        socket,
        binary,
        binarySha256: hash(binary!),
        version: execFileSync(binary!, ["-V"], { encoding: "utf8", timeout: 5000 }).trim(),
        testSha256: hash(fileURLToPath(import.meta.url)),
        sessionChannelSha256: hash(
          fileURLToPath(new URL("../../../terminal/mirror/session-channel.ts", import.meta.url)),
        ),
        mirrorServiceSha256: hash(
          fileURLToPath(new URL("../../../terminal/mirror/mirror-service.ts", import.meta.url)),
        ),
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim(),
        stamp,
        identities,
        events,
        expectedHex: [
          oldExpected.toString("hex"),
          Buffer.concat([freshExpected, Buffer.from("DONE\r")]).toString("hex"),
        ],
        receivedHex: files.map((file) => {
          try {
            return readFileSync(file).toString("hex");
          } catch {
            return null;
          }
        }),
        failure,
        cleanup: {
          errors: cleanupErrors,
          serverAbsentStatus,
          receiverProcessesAbsent: identities.map((identity) => absent(identity.pid)),
        },
      };
      writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
      console.log(`Input replacement receipt: ${join(root, "receipt.json")}`);
      expect(serverAbsentStatus).toBe(1);
      expect(cleanupErrors).toEqual([]);
    }
  },
  20000,
);
