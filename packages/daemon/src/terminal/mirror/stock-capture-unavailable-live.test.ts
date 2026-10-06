import { qualifyStockTabWire } from "./__tests__/stock-tab-wire.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { expect, it, vi } from "vitest";
import { STOCK_CAPTURE_TAB_UNAVAILABLE, type TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { MirrorService } from "./mirror-service.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import {
  TAB_INITIAL_BYTES,
  knownTabFrame,
  readDeliveredFrame,
  comparePhysicalFrame,
} from "./__tests__/native-physical-cell-oracle.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
it.skipIf(!binary)(
  "keeps existing server and healthy input alive when stock tab capture is unavailable",
  async () => {
    expect(isAbsolute(binary!)).toBe(true);
    const expectedNative = process.env.TMUX_IDE_ORACLE_EXPECT_NATIVE;
    expect(["0", "1"]).toContain(expectedNative);
    const root = mkdtempSync("/tmp/tcu-");
    const socket = "zz-tcu-" + randomUUID().slice(0, 8);
    const env = { ...process.env, HOME: root, TMUX: "", LC_ALL: "en_US.UTF-8" };
    const commands: unknown[] = [];
    const runResult = (...args: string[]) => {
      const r = spawnSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      commands.push({ args, status: r.status, stdout: r.stdout, stderr: r.stderr });
      return r;
    };
    const run = (...args: string[]) => {
      const r = runResult(...args);
      if (r.status !== 0) throw Error(r.stderr);
      return r.stdout.trim();
    };
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    let mirror: MirrorService | undefined;
    const owners: SessionRuntimeTerminalReplicaOwner[] = [];
    let before = "",
      after = "",
      failure: string | undefined;
    let cleanup: unknown;
    let wire: unknown;
    const faults: string[] = [];
    let badSnapshot: TerminalReplicaSnapshot | null = null;
    let goodSnapshot: TerminalReplicaSnapshot | null = null;
    let badPublications = 0;
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    try {
      const badScript = join(root, "bad.cjs"),
        goodScript = join(root, "good.cjs");
      const lateScript = join(root, "late.cjs");
      writeFileSync(
        lateScript,
        `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify("LATE\x1b]2;late-ready\x07")});process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(TAB_INITIAL_BYTES)}));`,
      );
      writeFileSync(
        badScript,
        `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify(TAB_INITIAL_BYTES)});`,
      );
      writeFileSync(
        goodScript,
        `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify("HEALTHY\x1b]2;healthy-ready\x07")});process.stdin.on('data',data=>process.stdout.write(${JSON.stringify("\r\nACK:")}+data));`,
      );
      before = run(
        "new-session",
        "-P",
        "-F",
        "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}",
        "-d",
        "-s",
        "tabs",
        "-n",
        "bad",
        "-x",
        "8",
        "-y",
        "4",
        `${quote(process.execPath)} ${quote(badScript)}`,
      );
      run("set-option", "-t", "tabs", "status", "off");
      run("resize-window", "-t", "tabs:bad", "-x", "8", "-y", "4");
      before +=
        "\n" +
        run(
          "new-window",
          "-P",
          "-F",
          "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}",
          "-t",
          "tabs",
          "-n",
          "good",
          `${quote(process.execPath)} ${quote(goodScript)}`,
        );
      run("resize-window", "-t", "tabs:good", "-x", "40", "-y", "8");
      before +=
        "\n" +
        run(
          "new-window",
          "-P",
          "-F",
          "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}",
          "-t",
          "tabs",
          "-n",
          "late",
          `${quote(process.execPath)} ${quote(lateScript)}`,
        );
      run("resize-window", "-t", "tabs:late", "-x", "8", "-y", "4");
      await vi.waitFor(
        () =>
          expect(run("display-message", "-p", "-t", "tabs:late", "#{pane_title}")).toBe(
            "late-ready",
          ),
        { timeout: 4000 },
      );
      await vi.waitFor(
        () =>
          expect(run("display-message", "-p", "-t", "tabs:bad", "#{pane_title}")).toBe(
            "tm04-initial",
          ),
        { timeout: 4000 },
      );
      await vi.waitFor(
        () =>
          expect(run("display-message", "-p", "-t", "tabs:good", "#{pane_title}")).toBe(
            "healthy-ready",
          ),
        { timeout: 4000 },
      );
      const identity = () =>
        run("list-panes", "-a", "-F", "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}");
      before = identity();
      const probe = runResult("capture-pane", "-p", "-R", "-S", "-", "-t", "tabs:bad");
      expect(probe.status === 0).toBe(expectedNative === "1");
      await qualifyStockTabWire({
        binary: binary!,
        socket,
        native: expectedNative === "1",
        record: (evidence) => {
          wire = evidence;
        },
        nativeText: () => run("capture-pane", "-p", "-t", "tabs:good"),
        paintLate: async () => {
          run("send-keys", "-t", "tabs:late", "-l", "paint");
          await vi.waitFor(
            () =>
              expect(run("display-message", "-p", "-t", "tabs:late", "#{pane_title}")).toBe(
                "tm04-initial",
              ),
            { timeout: 4000 },
          );
        },
        resizeLate: () => {
          run("capture-pane", "-p", "-e", "-J", "-t", "tabs:late");
          run("resize-window", "-t", "tabs:late", "-y", "5");
        },
      });
      expect(identity()).toBe(before);
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
      const description = await mirror.describeSession("tabs");
      const bad = description.panes.find((p) => p.windowName === "bad")!,
        good = description.panes.find((p) => p.windowName === "good")!;
      const make = (pane: string) => {
        const owner = new SessionRuntimeTerminalReplicaOwner(randomUUID(), "tabs", pane, mirror!, {
          incarnation: randomUUID(),
          initialRevision: 0,
          onFault: (e) => faults.push(String(e)),
        });
        owners.push(owner);
        return owner;
      };
      const goodOwner = make(good.semanticPaneId);
      await goodOwner.subscribe((u) => {
        if (u.type === "terminal.seed") goodSnapshot = u.snapshot;
        else if (u.type === "terminal.patch" && goodSnapshot)
          goodSnapshot = applyTerminalReplicaPatch(goodSnapshot, u.patch);
      });
      const badOwner = make(bad.semanticPaneId);
      const subscribeBad = (owner: SessionRuntimeTerminalReplicaOwner) =>
        owner.subscribe((u) => {
          badPublications++;
          if (u.type === "terminal.seed") badSnapshot = u.snapshot;
        });
      if (expectedNative === "0") {
        await expect(subscribeBad(badOwner)).rejects.toThrow(STOCK_CAPTURE_TAB_UNAVAILABLE);
        await badOwner.dispose();
        const reopened = make(bad.semanticPaneId);
        await expect(subscribeBad(reopened)).rejects.toThrow(STOCK_CAPTURE_TAB_UNAVAILABLE);
        await reopened.dispose();
        expect(badPublications).toBe(0);
        expect(faults).toHaveLength(2);
      } else {
        await subscribeBad(badOwner);
        expect(badSnapshot).not.toBeNull();
        comparePhysicalFrame(readDeliveredFrame(badSnapshot!), {
          ...knownTabFrame("initial"),
          cursor: [7, 0],
        });
        expect(faults).toEqual([]);
      }
      mirror.sendText("tabs", good.semanticPaneId, "healthy-123");
      await vi.waitFor(
        () => expect(run("capture-pane", "-p", "-t", "tabs:good")).toContain("ACK:healthy-123"),
        { timeout: 4000 },
      );
      await vi.waitFor(
        () =>
          expect(
            goodSnapshot?.grid.map((r) => r.cells.map((c) => c.grapheme).join("")).join("\n"),
          ).toContain("ACK:healthy-123"),
        { timeout: 4000 },
      );
      after = identity();
      expect(after).toBe(before);
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const errors: string[] = [];
      const boundedDispose = async (operation: Promise<unknown>, label: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            operation,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} disposal timed out`)), 1500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      for (const owner of owners)
        try {
          await boundedDispose(owner.dispose(), "owner");
        } catch (e) {
          errors.push(String(e));
        }
      try {
        if (mirror) await boundedDispose(mirror.dispose(), "mirror");
      } catch (e) {
        errors.push(String(e));
      }
      const [serverPid, serverStart] = before.split("\n")[0]!.split("|");
      if (/^[1-9]\d*$/.test(serverPid ?? "") && /^[1-9]\d*$/.test(serverStart ?? "")) {
        const retired = runResult(
          "if-shell",
          "-F",
          `#{&&:#{==:#{pid},${serverPid}},#{==:#{start_time},${serverStart}}}`,
          "kill-server",
          "display-message -p identity-mismatch",
        );
        if (retired.error || retired.signal || retired.stdout.trim())
          errors.push("server retirement unconfirmed");
      } else errors.push("missing creation identity; retained private root");
      const absent = runResult("has-session");
      const pids = before
        .split("\n")
        .flatMap((line) => {
          const f = line.split("|");
          return [f[0], f[4]];
        })
        .filter(Boolean);
      let ownedProcessesAbsent = false;
      try {
        await vi.waitFor(
          () => {
            for (const pid of pids) {
              let code: string | undefined;
              try {
                process.kill(Number(pid), 0);
              } catch (e) {
                code = (e as NodeJS.ErrnoException).code;
              }
              expect(code).toBe("ESRCH");
            }
          },
          { timeout: 3000 },
        );
        ownedProcessesAbsent = pids.length > 0;
      } catch (error) {
        errors.push(String(error));
      }
      cleanup = {
        serverAbsent: absent.status === 1 && !absent.error,
        ownedProcessesAbsent,
        errors,
      };
      if (process.env.TMUX_IDE_STOCK_TAB_RECEIPT)
        writeFileSync(
          process.env.TMUX_IDE_STOCK_TAB_RECEIPT,
          JSON.stringify(
            {
              binary,
              binarySha256: hash(readFileSync(binary!)),
              sourceSha256: hash(readFileSync(new URL(import.meta.url))),
              expectedNative,
              before,
              after,
              wire,
              badPublications,
              faults,
              commands,
              failure,
              cleanup,
            },
            null,
            2,
          ),
        );
      expect(errors).toEqual([]);
      expect(absent.status).toBe(1);
      rmSync(root, { recursive: true });
    }
  },
  20000,
);
