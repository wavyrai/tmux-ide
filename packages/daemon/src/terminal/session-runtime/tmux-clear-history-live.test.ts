import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { MirrorControlChannel } from "../mirror/control-channel.ts";
import { MirrorService } from "../mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const cases = [
  { name: "repeated main-screen clears", prefix: "", limit: 100, enabled: true },
  { name: "disabled history on clear", prefix: "", limit: 100, enabled: false },
  { name: "scroll margins", prefix: "\x1b[2;4r\x1b[5;1HLOW", limit: 100, enabled: true },
  { name: "partial erasure", prefix: "\x1b[3;1HABC\x1b[3;2H\x1b[K", limit: 100, enabled: true },
  { name: "written spaces", prefix: "\x1b[4;1H   ", limit: 100, enabled: true },
  { name: "colored blanks", prefix: "\x1b[4;1H\x1b[41m   \x1b[0m", limit: 100, enabled: true },
  { name: "wrapped Unicode", prefix: "\x1b[H界界界界界界e\u0301", limit: 100, enabled: true },
  { name: "alternate screen", prefix: "\x1b[?1049hALT", limit: 100, enabled: true },
  {
    name: "alternate screen with normal history",
    prefix: "old\x1b[2J\x1b[Hnormal\x1b[?1049hALT",
    limit: 100,
    enabled: true,
  },
  {
    name: "alternate scrolling with normal history",
    prefix: "old\x1b[2J\x1b[Hnormal\x1b[?1049h" + "ALT\r\n".repeat(10),
    limit: 100,
    enabled: true,
  },
  { name: "small history limit", prefix: "", limit: 3, enabled: true },
  { name: "zero history limit", prefix: "", limit: 0, enabled: true },
];

describe.skipIf(!available)("tmux clear/history parser parity", () => {
  it("keeps repeated matching clears incremental across native history checks", async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-ed2-owner-"));
    const socketName = `zz-ed2-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trimEnd();
    const script = join(directory, "echo.mjs");
    writeFileSync(
      script,
      "process.stdin.setRawMode(true);process.stdin.on('data', data => process.stdout.write(data));process.stdout.write('READY');",
    );
    const mirror = new MirrorService({
      createIo: (session, handlers) =>
        new MirrorControlChannel({ session, handlers, socketName, configFile: "/dev/null" }),
    });
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    try {
      tmux(
        "new-session",
        "-d",
        "-s",
        "ed2",
        "-x",
        "12",
        "-y",
        "5",
        `${process.execPath} ${script}`,
      );
      if (
        spawnSync(
          "tmux",
          ["-L", socketName, "show-option", "-p", "-v", "-t", "ed2", "scroll-on-clear"],
          { stdio: "ignore" },
        ).status !== 0
      )
        context.skip();
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", "ed2")).toContain("READY"));
      const description = await mirror.describeSession("ed2");
      owner = new SessionRuntimeTerminalReplicaOwner(
        randomUUID(),
        "ed2",
        description.panes[0]!.semanticPaneId,
        mirror,
        { incarnation: "ed2:0", initialRevision: 0 },
      );
      let seeds = 0;
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") seeds++;
      });
      expect(seeds).toBe(1);
      for (let index = 0; index < 5; index++) {
        const before = owner.qualificationSnapshot().revision;
        tmux("send-keys", "-t", "ed2", "-l", `\x1b[2J\x1b[HSTEP${index}`);
        await vi.waitFor(() =>
          expect(owner!.qualificationSnapshot().revision).toBeGreaterThan(before!),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Allow the final 250ms reconciliation probe to complete, not just its first callback.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(seeds).toBe(1);
      expect(Number(tmux("display-message", "-p", "-t", "ed2", "#{history_size}"))).toBe(5);
    } finally {
      await owner?.dispose();
      await mirror.dispose();
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it.each(cases)(
    "matches $name",
    async ({ prefix, limit, enabled }, context) => {
      const directory = mkdtempSync(join(tmpdir(), "tmux-ed2-parity-"));
      const socket = `zz-ed2-${process.pid}-${randomUUID().slice(0, 8)}`;
      const tmux = (...args: string[]) =>
        execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          env: { ...process.env, TMUX: "" },
        }).trimEnd();
      const interpreter = new TerminalReplicaInterpreter({
        generation: randomUUID(),
        workspaceName: "ed2",
        semanticPaneId: "pane-a",
        incarnation: "ed2:0",
        cols: 12,
        rows: 5,
        onUpdate: () => {},
      });
      const script = join(directory, "echo.mjs");
      writeFileSync(
        script,
        "process.stdin.setRawMode(true);process.stdin.on('data', data => process.stdout.write(data));process.stdout.write('READY');",
      );
      try {
        // Set the limit before pane creation: tmux captures it when allocating its grid.
        tmux("new-session", "-d", "-s", "bootstrap", "sleep 60");
        tmux("set-option", "-g", "history-limit", String(limit));
        tmux(
          "new-session",
          "-d",
          "-s",
          "ed2",
          "-x",
          "12",
          "-y",
          "5",
          `${process.execPath} ${script}`,
        );
        if (!enabled) {
          const option = spawnSync(
            "tmux",
            ["-L", socket, "set-option", "-p", "-t", "ed2", "scroll-on-clear", "off"],
            { stdio: "ignore" },
          );
          if (option.status !== 0) context.skip();
        }
        await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", "ed2")).toContain("READY"));
        await interpreter.enqueue({
          type: "reseed",
          cols: 12,
          rows: 5,
          chunks: [new TextEncoder().encode("READY")],
          historyLimit: limit,
          historySize: 0,
          cursor: { x: 5, y: 0 },
          observedModes: { scrollOnClear: enabled },
          bootstrap: "authoritative-stream",
        });
        for (let index = 0; index < 6; index++) {
          const marker = `STEP${index}`;
          const data = `${index === 0 ? prefix : ""}\x1b[2J\x1b[H${marker}`;
          tmux("send-keys", "-t", "ed2", "-l", data);
          await interpreter.enqueue({ type: "write", data: new TextEncoder().encode(data) });
          await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", "ed2")).toContain(marker));
          const state = interpreter.currentSnapshot();
          const nativeHistory = Number(
            tmux("display-message", "-p", "-t", "ed2", "#{history_size}"),
          );
          expect(state.history.length, `history after ${marker}`).toBe(nativeHistory);
          const nativeRows = tmux("capture-pane", "-p", "-S", "-", "-t", "ed2").split("\n");
          const parsedRows = [...state.history, ...state.grid].map((row) =>
            row.cells
              .map((cell) => cell.grapheme)
              .join("")
              .trimEnd(),
          );
          expect(parsedRows.join("\n").trimEnd(), `cells after ${marker}`).toBe(
            nativeRows.join("\n").trimEnd(),
          );
        }
      } finally {
        await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
        spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
