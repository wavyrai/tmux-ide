// Differential test written by review-393 for #430: the replica's history after
// a byte stream must equal real tmux's after the same stream, size and every
// row. tmux runs on a private -S socket in a fresh temporary directory.
//
// It drives the backend alone, so it says nothing about owner-side repairs.
// #430's reverted size-only trim (option B) stays out unless an owner-level
// test shows a real negative history gap under production conditions.
//
// The backend gets tmux's scroll-on-clear mode as the mirror reports it in
// production (default on). Without it, xterm's own ED2 does not push the
// screen into history, which is not what tmux or the daemon does.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";

// /tmp, not tmpdir(): a macOS tmpdir pushes the -S socket past sun_path.
const root = mkdtempSync("/tmp/tmi-history-vs-tmux-");
// The bundled tmux this replica must agree with (as the other boundary tests).
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (tag: string, from: number, count: number, width = 0) =>
  Array.from(
    { length: count },
    (_, i) => `${tag}${from + i}${width ? "-".repeat((from + i) % width) : ""}\r\n`,
  ).join("");

type Scenario = { name: string; limit: number; cols: number; rows: number; input: string };
const scenarios: Scenario[] = [
  { name: "scroll past a small limit", limit: 20, cols: 30, rows: 6, input: lines("a", 0, 200) },
  { name: "scroll at limit 2000", limit: 2000, cols: 30, rows: 10, input: lines("b", 0, 2600) },
  { name: "limit 7 (tenth < 1)", limit: 7, cols: 30, rows: 4, input: lines("c", 0, 50) },
  {
    name: "ED2 at the limit, twice",
    limit: 20,
    cols: 30,
    rows: 6,
    input:
      lines("d", 0, 60) + "\x1b[H\x1b[2J" + lines("e", 0, 30) + "\x1b[H\x1b[2J" + lines("f", 0, 41),
  },
  {
    name: "ED2 with rows > tenth of limit",
    limit: 30,
    cols: 30,
    rows: 12,
    input: lines("g", 0, 80) + "\x1b[2J" + lines("h", 0, 25),
  },
  {
    name: "ED3 clears history",
    limit: 20,
    cols: 30,
    rows: 6,
    input: lines("i", 0, 60) + "\x1b[3J" + lines("j", 0, 30),
  },
  {
    name: "alternate screen at the limit",
    limit: 20,
    cols: 30,
    rows: 6,
    input:
      lines("k", 0, 50) + "\x1b[?1049h" + lines("l", 0, 40) + "\x1b[?1049l" + lines("m", 0, 30),
  },
  {
    name: "wrapped lines at the limit",
    limit: 25,
    cols: 20,
    rows: 5,
    input: lines("n", 0, 120, 45),
  },
  {
    name: "scroll region (DECSTBM) at the limit",
    limit: 20,
    cols: 30,
    rows: 8,
    input:
      lines("o", 0, 40) +
      "\x1b[2;7r\x1b[7;1H" +
      lines("p", 0, 20) +
      "\x1b[r\x1b[8;1H" +
      lines("q", 0, 20),
  },
  {
    name: "home + ED2 with rows > tenth of limit",
    limit: 30,
    cols: 30,
    rows: 12,
    input: lines("r", 0, 80) + "\x1b[H\x1b[2J" + lines("s", 0, 25),
  },
  {
    name: "ED2 without home at limit 2000, 50 rows",
    limit: 2000,
    cols: 30,
    rows: 50,
    input: lines("t", 0, 2300) + "\x1b[2J" + lines("u", 0, 100),
  },
  {
    name: "home + ED2 at limit 2000, 50 rows",
    limit: 2000,
    cols: 30,
    rows: 50,
    input: lines("v", 0, 2300) + "\x1b[H\x1b[2J" + lines("w", 0, 100),
  },
];

let n = 0;
function tmuxHistory(s: Scenario): { size: number; rows: string[] } {
  n += 1;
  const dir = join(root, `t${n}`);
  execFileSync("mkdir", [dir]);
  const sock = join(dir, "s");
  const input = join(dir, "in");
  writeFileSync(input, s.input);
  const conf = join(dir, "conf");
  writeFileSync(conf, `set -g history-limit ${s.limit}\nset -g status off\n`);
  const tmux = (...args: string[]) =>
    execFileSync(binary!, ["-S", sock, ...args], {
      encoding: "utf8",
      env: { ...process.env, TMUX: "" },
    });
  tmux(
    "-f",
    conf,
    "new-session",
    "-d",
    "-x",
    String(s.cols),
    "-y",
    String(s.rows),
    `stty -opost -echo; cat '${input}'; printf '\\033]2;DONE\\007'; exec sleep 600`,
  );
  try {
    const deadline = Date.now() + 15_000;
    while (tmux("display", "-p", "#{pane_title}").trim() !== "DONE") {
      if (Date.now() > deadline) throw new Error("tmux did not finish");
      execFileSync("sleep", ["0.05"]);
    }
    const size = Number(tmux("display", "-p", "#{history_size}").trim());
    const rows =
      size > 0
        ? tmux("capture-pane", "-p", "-S", `-${size}`, "-E", "-1").replace(/\n$/u, "").split("\n")
        : [];
    return { size, rows: rows.map((r) => r.replace(/\s+$/u, "")) };
  } finally {
    tmux("kill-server");
  }
}

async function replicaHistory(s: Scenario): Promise<{ size: number; rows: string[] }> {
  const backend = createXtermTerminalInterpreterBackend({
    cols: s.cols,
    rows: s.rows,
    scrollback: s.limit,
    historyLimit: s.limit,
  });
  // As the mirror reports tmux's modes: scroll-on-clear is on by default.
  backend.setAuthoritativeModes?.({ scrollOnClear: true });
  backend.startHistoryCollection?.();
  try {
    await backend.write(s.input);
    const history = backend.project(blankTerminalReplicaSnapshot(s.cols, s.rows)).history;
    return {
      size: history.length,
      rows: history.map((row) =>
        row.cells
          .map((c) => c.grapheme)
          .join("")
          .replace(/\s+$/u, ""),
      ),
    };
  } finally {
    backend.dispose();
  }
}

describe.skipIf(!binary)("replica history equals real tmux", () => {
  it("uses an absolute tmux binary", () => expect(isAbsolute(binary!)).toBe(true));
  it.each(scenarios.map((s) => [s.name, s] as const))(
    "%s",
    async (_name, s) => {
      const real = tmuxHistory(s);
      const replica = await replicaHistory(s);
      expect(replica.size).toBe(real.size);
      expect(replica.rows).toEqual(real.rows);
    },
    30_000,
  );
});

describe.skipIf(!binary)("a replica rebuilt from a capture (reconnect) then follows tmux", () => {
  it.each([
    [20, 6, 60, 50],
    [2000, 20, 2300, 400],
  ])(
    "limit %i rows %i: %i lines, capture, %i more",
    async (limit, rows, first, second) => {
      const cols = 30;
      n += 1;
      const dir = join(root, `r${n}`);
      execFileSync("mkdir", [dir]);
      const sock = join(dir, "s");
      const in1 = join(dir, "in1");
      const fifo = join(dir, "fifo");
      writeFileSync(in1, lines("x", 0, first));
      execFileSync("mkfifo", [fifo]);
      const conf = join(dir, "conf");
      writeFileSync(conf, `set -g history-limit ${limit}\nset -g status off\n`);
      const tmux = (...args: string[]) =>
        execFileSync(binary!, ["-S", sock, ...args], {
          encoding: "utf8",
          env: { ...process.env, TMUX: "" },
        });
      tmux(
        "-f",
        conf,
        "new-session",
        "-d",
        "-x",
        String(cols),
        "-y",
        String(rows),
        `stty -opost -echo; cat '${in1}'; printf '\\033]2;ONE\\007'; cat '${fifo}'; printf '\\033]2;TWO\\007'; exec sleep 600`,
      );
      const wait = (title: string) => {
        const deadline = Date.now() + 15_000;
        while (tmux("display", "-p", "#{pane_title}").trim() !== title) {
          if (Date.now() > deadline) throw new Error(`tmux did not reach ${title}`);
          execFileSync("sleep", ["0.05"]);
        }
      };
      try {
        wait("ONE");
        const hsize = Number(tmux("display", "-p", "#{history_size}").trim());
        const captured = tmux("capture-pane", "-p", "-S", `-${hsize}`)
          .replace(/\n$/u, "")
          .split("\n");
        const backend = createXtermTerminalInterpreterBackend({
          cols,
          rows,
          scrollback: Math.max(limit, hsize),
          historyLimit: limit,
        });
        // Replay the capture, then place the cursor where tmux has it; then collect.
        const cy = Number(tmux("display", "-p", "#{cursor_y}").trim());
        const cx = Number(tmux("display", "-p", "#{cursor_x}").trim());
        await backend.write(captured.join("\r\n") + `\x1b[${cy + 1};${cx + 1}H`);
        backend.startHistoryCollection?.();
        const more = lines("y", 0, second);
        writeFileSync(fifo, more);
        wait("TWO");
        await backend.write(more);
        const size = Number(tmux("display", "-p", "#{history_size}").trim());
        const real =
          size > 0
            ? tmux("capture-pane", "-p", "-S", `-${size}`, "-E", "-1")
                .replace(/\n$/u, "")
                .split("\n")
                .map((r) => r.replace(/\s+$/u, ""))
            : [];
        const history = backend
          .project(blankTerminalReplicaSnapshot(cols, rows))
          .history.map((row) =>
            row.cells
              .map((c) => c.grapheme)
              .join("")
              .replace(/\s+$/u, ""),
          );
        backend.dispose();
        expect(history.length).toBe(size);
        expect(history).toEqual(real);
      } finally {
        tmux("kill-server");
      }
    },
    60_000,
  );
});
