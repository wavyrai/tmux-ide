import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { InteractionEvidence } from "@tmux-ide/contracts";
import { OwnerInteractionObservation } from "../../../lib/owner-interaction-observation.ts";
import { InteractionObservationStatusStore } from "../../../lib/interaction-observation-status.ts";
import { createOwnedViewerAdapterFactory } from "../../../lib/owned-viewer-factory.ts";
import { MirrorService, type MirrorSubscription } from "../../../terminal/mirror/mirror-service.ts";
import type {
  MirrorChannelIo,
  NativeViewerControlReply,
} from "../../../terminal/mirror/control-channel.ts";

const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "rejects accepted native input queued across physical pane death without replay",
  async () => {
    expect(isAbsolute(binary!)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "tmux-native-input-death-"));
    const socket = join(root, "server.sock");
    const env = { ...process.env, HOME: root, TMUX: "" };
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], {
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
    const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const files = [join(root, "old.bin"), join(root, "replacement.bin")];
    const lock = `input-death-${randomUUID()}`;
    const evidence: InteractionEvidence[] = [];
    const trace: unknown[] = [];
    const nativeCalls: Array<{
      pane: string;
      birth: string;
      commands: readonly (readonly string[])[];
      accepted?: boolean;
      reply?: NativeViewerControlReply;
    }> = [];
    const ordinarySends: string[] = [];
    const wireChunks: string[] = [];
    const pids: number[] = [];
    const identities: unknown[] = [];
    const subs: MirrorSubscription[] = [];
    let mirror: MirrorService | undefined;
    let owner: OwnerInteractionObservation | undefined;
    let status: InteractionObservationStatusStore | undefined;
    let io: MirrorChannelIo | undefined;
    let retained: { close(): Promise<void> } | undefined;
    let failure: string | undefined;
    let lockUsed = false;
    try {
      const script = join(root, "receiver.cjs");
      writeFileSync(
        script,
        "const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdin.on('data', data => fs.appendFileSync(process.argv[2], data)); process.stdout.write('READY');",
      );
      files.forEach((file) => writeFileSync(file, ""));
      const pane = run(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "probe",
        "-P",
        "-F",
        "#{pane_id}",
        `${quote(process.execPath)} ${quote(script)} ${quote(files[0]!)}`,
      );
      const sibling = run("split-window", "-h", "-t", pane, "-P", "-F", "#{pane_id}", "sleep 60");
      run("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.guarded-input");
      const [sessionId, pid, startTime, birth, receiverPid] = run(
        "display-message",
        "-p",
        "-t",
        pane,
        "#{session_id}\t#{pid}\t#{start_time}\t#{pane_birth_id}\t#{pane_pid}",
      ).split("\t") as [string, string, string, string, string];
      pids.push(Number(receiverPid));
      identities.push({ pane, sessionId, pid, startTime, birth });
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toBe("READY"));
      const environmentId = randomUUID();
      const serverScope = { serverId: `tmux-server.${"1".repeat(32)}`, generation: randomUUID() };
      status = new InteractionObservationStatusStore(environmentId, serverScope);
      owner = new OwnerInteractionObservation({
        environmentId,
        serverScope,
        status,
        enabled: true,
        nativeServerIdentity: { pid, startTime },
        tmuxAuthority: { executablePath: binary!, socketSelector: { kind: "path", path: socket } },
        publishEvidence: (value) => evidence.push(value),
      });
      const register = vi.spyOn(owner, "registerOwnedConnection");
      const factory = createOwnedViewerAdapterFactory({
        environmentId,
        serverScope,
        observation: owner,
        status,
      });
      // Preserve the production factory/IO topology. Instrument only delegation;
      // custom createIo would disable the native owned viewer being qualified.
      mirror = new MirrorService({
        executable: binary!,
        socketPath: socket,
        nativeServerIdentity: { pid, startTime },
        createOwnedViewerAdapter: () => {
          const adapter = factory();
          const bind = adapter.bindIo.bind(adapter);
          adapter.bindIo = (bound) => {
            io = bound;
            const start = bound.start.bind(bound);
            bound.start = async () => {
              await start();
              const stdout = (bound as unknown as { proc: ChildProcess }).proc.stdout;
              if (!stdout) throw new Error("real viewer stdout unavailable");
              stdout.on("data", (chunk: Buffer) =>
                wireChunks.push(Buffer.from(chunk).toString("base64")),
              );
            };
            const native = bound.commandNativeViewerInline!.bind(bound);
            bound.commandNativeViewerInline = (request, callback) => {
              const row = {
                pane: request.paneId,
                birth: request.paneBirthId,
                commands: request.commands,
              } as (typeof nativeCalls)[number];
              nativeCalls.push(row);
              row.accepted = native(request, (reply) => {
                row.reply = reply;
                callback(reply);
              });
              return row.accepted;
            };
            const send = bound.send.bind(bound);
            bound.send = (command, callback) => {
              ordinarySends.push(command);
              send(command, callback);
            };
            bind(bound);
          };
          return adapter;
        },
      });
      retained = await mirror.retainSession("probe");
      await mirror.describeTrustedInventory("probe", sessionId);
      await owner.start();
      await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1), { timeout: 5000 });
      trace.push({ viewer: register.mock.calls[0] });
      let seeded = false;
      const sub = await mirror.subscribe({
        session: "probe",
        semanticPaneId: "pane.guarded-input",
        onEvent: (event) => {
          if (event.type === "seed") seeded = true;
        },
      });
      subs.push(sub);
      await vi.waitFor(() => expect(seeded).toBe(true));
      sub.sendText("BASE");
      sub.sendKey("Enter");
      await vi.waitFor(() => expect(readFileSync(files[0]!).toString("hex")).toBe("424153450d"));
      await vi.waitFor(() =>
        expect(
          nativeCalls.some(
            (call) =>
              call.commands[0]?.[0] === "send-keys" &&
              call.accepted &&
              call.reply?.ok &&
              call.reply.metadataStatus === "valid",
          ),
        ).toBe(true),
      );
      expect(
        evidence.some(
          (row) =>
            row.actor.kind === "native" &&
            row.actor.classification.kind === "viewer" &&
            row.effect.kind === "input-enqueued",
        ),
      ).toBe(true);
      run("wait-for", "-L", lock);
      lockUsed = true;
      trace.push("independent-lock-held");
      let waitReleased = false;
      io!.commandInline!(`wait-for -L ${lock}`, (reply) => {
        expect(reply.ok).toBe(true);
        waitReleased = true;
      });
      const before = nativeCalls.length;
      sub.sendText("STALE");
      sub.sendKey("Enter");
      const stale = nativeCalls.slice(before);
      expect(stale).toHaveLength(2);
      expect(
        stale.every(
          (call) => call.accepted && call.pane === pane && call.birth === birth && !call.reply,
        ),
      ).toBe(true);
      trace.push("native-input-accepted-behind-lock");
      run("kill-pane", "-t", pane);
      const replacement = run(
        "split-window",
        "-h",
        "-t",
        sibling,
        "-P",
        "-F",
        "#{pane_id}",
        `${quote(process.execPath)} ${quote(script)} ${quote(files[1]!)}`,
      );
      run("set-option", "-p", "-t", replacement, "@tmux_ide_pane_id", "pane.guarded-input");
      const [replacementBirth, replacementPid] = run(
        "display-message",
        "-p",
        "-t",
        replacement,
        "#{pane_birth_id}\t#{pane_pid}",
      ).split("\t");
      pids.push(Number(replacementPid));
      identities.push({ replacement, replacementBirth });
      expect(replacement).not.toBe(pane);
      expect(replacementBirth).not.toBe(birth);
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", replacement)).toBe("READY"));
      expect(stale.every((call) => !call.reply)).toBe(true);
      expect(readFileSync(files[1]!)).toHaveLength(0);
      trace.push("physical-target-dead-replacement-ready-before-unlock");
      run("wait-for", "-U", lock);
      await vi.waitFor(() => {
        expect(waitReleased).toBe(true);
        expect(stale.every((call) => call.reply?.ok === false)).toBe(true);
      });
      const fence = await io!.request('display-message -p -l "INPUT-DEATH-FENCE"');
      expect(fence).toEqual(["INPUT-DEATH-FENCE"]);
      expect(
        Buffer.concat(wireChunks.map((chunk) => Buffer.from(chunk, "base64"))).toString("utf8"),
      ).toContain("operation pane lifetime mismatch");
      expect(ordinarySends.filter((command) => command.startsWith("send-keys"))).toEqual([]);
      expect(readFileSync(files[0]!).toString("hex")).toBe("424153450d");
      expect(readFileSync(files[1]!)).toHaveLength(0);
      trace.push("native-rejected-no-fallback-fence-aligned");
      await vi.waitFor(async () =>
        expect(
          (await mirror!.describeSession("probe")).panes.some(
            (p) => p.semanticPaneId === "pane.guarded-input",
          ),
        ).toBe(true),
      );
      let freshSeeded = false;
      const fresh = await mirror.subscribe({
        session: "probe",
        semanticPaneId: "pane.guarded-input",
        onEvent: (event) => {
          if (event.type === "seed") freshSeeded = true;
        },
      });
      subs.push(fresh);
      await vi.waitFor(() => expect(freshSeeded).toBe(true));
      fresh.sendText("FRESH");
      fresh.sendKey("Enter");
      await vi.waitFor(() => expect(readFileSync(files[1]!).toString("hex")).toBe("46524553480d"));
      await vi.waitFor(() =>
        expect(
          nativeCalls.some(
            (call) =>
              call.pane === replacement &&
              call.commands[0]?.[0] === "send-keys" &&
              call.accepted &&
              call.reply?.ok &&
              call.reply.metadataStatus === "valid",
          ),
        ).toBe(true),
      );
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const errors: string[] = [];
      // Release the real queue even if assertions fail before normal unlock.
      if (lockUsed) {
        const unlock = spawnSync(binary!, ["-S", socket, "wait-for", "-U", lock], {
          env,
          timeout: 5000,
          stdio: "ignore",
        });
        if (unlock.error) errors.push(String(unlock.error));
      }
      try {
        for (const sub of subs) {
          try {
            await sub.close();
          } catch (error) {
            errors.push(String(error));
          }
        }
        try {
          await retained?.close();
        } catch (error) {
          errors.push(String(error));
        }
        try {
          await mirror?.dispose();
        } catch (error) {
          errors.push(String(error));
        }
        try {
          await owner?.dispose();
        } catch (error) {
          errors.push(String(error));
        }
        status?.dispose();
      } finally {
        const kill = spawnSync(binary!, ["-S", socket, "kill-server"], {
          env,
          timeout: 5000,
          stdio: "ignore",
        });
        if (kill.error) errors.push(String(kill.error));
      }
      const serverAbsentStatus = spawnSync(binary!, ["-S", socket, "has-session"], {
        env,
        timeout: 5000,
        stdio: "ignore",
      }).status;
      try {
        await vi.waitFor(() => pids.forEach((pid) => expect(absent(pid)).toBe(true)));
      } catch (error) {
        errors.push(String(error));
      }
      const receipt = {
        root,
        socket,
        binary,
        binarySha256: hash(binary!),
        version: execFileSync(binary!, ["-V"], { encoding: "utf8", timeout: 5000 }).trim(),
        ownedViewerSha256: hash(
          fileURLToPath(
            new URL("../../../terminal/mirror/owned-viewer-adapter.ts", import.meta.url),
          ),
        ),
        sessionChannelSha256: hash(
          fileURLToPath(new URL("../../../terminal/mirror/session-channel.ts", import.meta.url)),
        ),
        testSha256: hash(fileURLToPath(import.meta.url)),
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim(),
        identities,
        trace,
        nativeCalls,
        ordinarySends,
        wireChunks,
        evidence,
        expectedHex: ["424153450d", "46524553480d"],
        receivedHex: files.map((file) => {
          try {
            return readFileSync(file).toString("hex");
          } catch {
            return null;
          }
        }),
        failure,
        cleanup: { errors, serverAbsentStatus, receiverProcessesAbsent: pids.map(absent) },
      };
      writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
      console.log(`Native input death receipt: ${join(root, "receipt.json")}`);
      expect(serverAbsentStatus).toBe(1);
      expect(errors).toEqual([]);
    }
  },
  30000,
);
