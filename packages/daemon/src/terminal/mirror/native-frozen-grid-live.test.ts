import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeNativeGridCapture } from "./native-grid-capture.ts";
import { resizeNativeFrozenGrid } from "./native-frozen-grid.ts";
import { projectNativeGridRow } from "./native-grid-projection.ts";

const executable = process.env.TMUX_IDE_NATIVE_GRID_TMUX;
describe.skipIf(!executable)("native v2 allocated backing oracle", () => {
  it.each([
    "\x1b[48;5;17m\x1b[2J\x1b[Habc",
    "\x1b[48;5;17m\x1b[2J\x1b[Habcdefghijk  ",
    "\x1b[48;5;17m\x1b[2J\x1b[H界é🙂abcdefgh  ",
    "\x1b[2J\x1b[Habc\x1b[48;5;17m\x1b[K",
  ])("preserves actual native paint through repeated resize: %j", async (output) => {
    const directory = mkdtempSync(join(tmpdir(), "tmi-v2-"));
    const socket = join(directory, "s");
    const fixture = join(directory, "paint.cjs");
    writeFileSync(
      fixture,
      `process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},10000);`,
    );
    const tmux = (...args: string[]) =>
      execFileSync(executable!, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      });
    try {
      tmux(
        "new-session",
        "-d",
        "-s",
        "proof",
        "-x",
        "10",
        "-y",
        "4",
        `${process.execPath} ${fixture}`,
      );
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", "proof")).toContain("abc"));
      tmux("copy-mode", "-t", "proof");
      const capture = () =>
        decodeNativeGridCapture(tmux("capture-pane", "-p", "-R", "-M", "-S", "-", "-t", "proof"))!;
      let retained = capture();
      expect(retained.version).toBe(2);
      for (const cols of [5, 3, 12, 2, 10, 1, 10]) {
        tmux("resize-window", "-t", "proof", "-x", String(cols), "-y", "4");
        retained = resizeNativeFrozenGrid(retained, cols, 4)!;
        const native = capture();
        expect(retained.history, `history at width ${cols}`).toBe(native.history);
        expect(
          retained.grid.map((row) => row.used ?? row.cells.length),
          `used at width ${cols}`,
        ).toEqual(native.grid.map((row) => row.used));
        const project = (grid: typeof native.grid) =>
          grid.map((row, index) =>
            projectNativeGridRow(row, cols, 0, index > 0 && (grid[index - 1]!.flags & 1) !== 0),
          );
        expect(project(retained.grid), `paint at width ${cols}`).toEqual(project(native.grid));
      }
    } finally {
      spawnSync(executable!, ["-S", socket, "kill-server"], { stdio: "ignore" });
      expect(
        spawnSync(executable!, ["-S", socket, "has-session"], { stdio: "ignore" }).status,
      ).not.toBe(0);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
