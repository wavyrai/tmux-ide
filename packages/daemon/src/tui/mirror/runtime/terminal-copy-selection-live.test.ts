import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { MirrorControlChannel } from "../../../terminal/mirror/control-channel.ts";
import { MirrorService } from "../../../terminal/mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../../../terminal/session-runtime/terminal-replica-owner.ts";
import {
  createTerminalCopyCursor,
  moveTerminalCopyCursor,
  pageTerminalCopyCursor,
  scrollTerminalCopyCursor,
  type TerminalCopyMotion,
} from "./terminal-copy-cursor.ts";
import {
  extractTerminalCopySelection,
  terminalCopyLineLength,
  terminalCopyRow,
} from "./terminal-copy-selection.ts";

/** tmux 3.4 keeps vi's cursor one cell past EOL; 3.7 clamps to the last cell.
 * Our local copy mode deliberately follows the pinned 3.7 contract regardless
 * of the backing server. Probe the native behavior, then explicitly move the
 * older reference cursor to that same endpoint before comparing copied bytes.
 */
function nativeViHasExtraEndColumn(
  tmux: (...args: string[]) => string,
  state: TerminalReplicaSnapshot,
): boolean {
  tmux("set-option", "-w", "-t", "reference", "mode-keys", "vi");
  tmux("copy-mode", "-t", "reference");
  tmux("send-keys", "-t", "reference", "-X", "history-top");
  tmux("send-keys", "-t", "reference", "-X", "end-of-line");
  const column = Number(tmux("display-message", "-p", "-t", "reference", "#{copy_cursor_x}"));
  const length = terminalCopyLineLength(terminalCopyRow(state, 0)!);
  expect(length).toBeGreaterThan(0);
  expect([length - 1, length]).toContain(column);
  tmux("send-keys", "-t", "reference", "-X", "cancel");
  return column === length;
}

function clampLegacyNativeViEnd(
  tmux: (...args: string[]) => string,
  state: TerminalReplicaSnapshot,
  point: { row: number; col: number },
): void {
  const length = terminalCopyLineLength(terminalCopyRow(state, point.row)!);
  if (length > 0 && point.col === length) tmux("send-keys", "-t", "reference", "-X", "cursor-left");
}

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "matches fresh native copy buffers for emacs/vi wide and combining endpoints",
  async () => {
    const root = mkdtempSync("/tmp/tmi-copy-selection-");
    const socketPath = join(root, "tmux.sock");
    const raw = (...args: string[]) =>
      execFileSync("tmux", ["-S", socketPath, "-f", "/dev/null", ...args], {
        env: { ...process.env, TMUX: "" },
        timeout: 2_000,
      });
    const tmux = (...args: string[]) =>
      raw(...args)
        .toString("utf8")
        .trimEnd();
    const mirror = new MirrorService({
      createIo: (session, handlers) =>
        new MirrorControlChannel({ session, handlers, socketPath, configFile: "/dev/null" }),
    });
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    try {
      tmux(
        "new-session",
        "-d",
        "-s",
        "reference",
        "-x",
        "20",
        "-y",
        "8",
        "printf 'A界é B\\r\\nalpha beta gamma\\r\\nabcdefghijklmnopqrstuvwxy\\r\\n\\033[1;1H'; sleep 600",
      );
      tmux("set-option", "-g", "set-clipboard", "off");
      await vi.waitFor(() =>
        expect(tmux("capture-pane", "-p", "-t", "reference")).toContain("A界é B"),
      );
      const described = await mirror.describeSession("reference");
      owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        "reference",
        described.panes[0]!.semanticPaneId,
        mirror,
        {
          incarnation: "copy-selection:0",
          initialRevision: 0,
        },
      );
      let snapshot: TerminalReplicaSnapshot | undefined;
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
      });
      await vi.waitFor(() => expect(snapshot?.grid[0]?.cells[1]?.grapheme).toBe("界"));
      const state = snapshot!;
      const legacyViEnd = nativeViHasExtraEndColumn(tmux, state);
      const point = () => {
        const [col, row] = tmux(
          "display-message",
          "-p",
          "-t",
          "reference",
          "#{copy_cursor_x}:#{copy_cursor_y}",
        )
          .split(":")
          .map(Number);
        return { col: col!, row: state.history.length + row! };
      };
      for (const mode of ["emacs", "vi"] as const) {
        tmux("set-option", "-w", "-t", "reference", "mode-keys", mode);
        for (const direction of ["forward", "backward", "line-end", "wrapped-line"] as const) {
          tmux("copy-mode", "-t", "reference");
          let localCursor = createTerminalCopyCursor(state, mode);
          const motion = (...keys: string[]) => {
            for (const key of keys) {
              tmux("send-keys", "-t", "reference", key);
              localCursor = moveTerminalCopyCursor(
                localCursor,
                key.toLowerCase() as TerminalCopyMotion,
              );
              if (mode === "vi" && legacyViEnd) clampLegacyNativeViEnd(tmux, state, point());
              expect(localCursor.position, `${mode}/${direction}/${key}`).toEqual(point());
            }
          };
          motion("Home", "Right");
          if (direction === "wrapped-line") motion("Down", "Down", "Home");
          if (direction === "backward") motion("Right");
          tmux("send-keys", "-t", "reference", mode === "vi" ? "Space" : "C-Space");
          const anchor = point();
          motion(
            direction === "line-end" || direction === "wrapped-line"
              ? "End"
              : direction === "forward"
                ? "Right"
                : "Left",
          );
          const cursor = point();
          for (const name of tmux("list-buffers", "-F", "#{buffer_name}")
            .split("\n")
            .filter(Boolean))
            tmux("delete-buffer", "-b", name);
          expect(tmux("list-buffers", "-F", "#{buffer_name}")).toBe("");
          tmux("send-keys", "-t", "reference", "-X", "copy-selection");
          const names = tmux("list-buffers", "-F", "#{buffer_name}");
          const native = names ? raw("save-buffer", "-") : null;
          if (direction === "wrapped-line")
            expect(native?.toString()).toBe("abcdefghijklmnopqrstuvwxy");
          const local = extractTerminalCopySelection(state, anchor, cursor, mode);
          expect(local ? Buffer.from(local.text) : null, `${mode}/${direction}`).toEqual(native);
          expect(local?.bytes ?? 0).toBe(native?.length ?? 0);
          tmux("send-keys", "-t", "reference", "-X", "cancel");
        }
      }
    } finally {
      await owner?.dispose();
      await mirror.dispose();
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "matches native pages and scroll-only motion at both history boundaries",
  async () => {
    const root = mkdtempSync("/tmp/tmi-copy-selection-");
    const socketPath = join(root, "tmux.sock");
    const raw = (...args: string[]) =>
      execFileSync("tmux", ["-S", socketPath, "-f", "/dev/null", ...args], {
        env: { ...process.env, TMUX: "" },
        timeout: 2_000,
      });
    const tmux = (...args: string[]) =>
      raw(...args)
        .toString("utf8")
        .trimEnd();
    const mirror = new MirrorService({
      createIo: (session, handlers) =>
        new MirrorControlChannel({ session, handlers, socketPath, configFile: "/dev/null" }),
    });
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    try {
      tmux(
        "new-session",
        "-d",
        "-s",
        "reference",
        "-x",
        "20",
        "-y",
        "8",
        "printf 'row0123456789\\r\\n%.0s' $(seq 1 30); sleep 600",
      );
      tmux("set-option", "-g", "set-clipboard", "off");
      await vi.waitFor(() =>
        expect(tmux("capture-pane", "-p", "-t", "reference")).toContain("row0123456789"),
      );
      const described = await mirror.describeSession("reference");
      owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        "reference",
        described.panes[0]!.semanticPaneId,
        mirror,
        {
          incarnation: "copy-selection:0",
          initialRevision: 0,
        },
      );
      let snapshot: TerminalReplicaSnapshot | undefined;
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
      });
      await vi.waitFor(() => expect(snapshot?.history.length).toBeGreaterThan(10));
      const state = snapshot!;
      const legacyViEnd = nativeViHasExtraEndColumn(tmux, state);
      for (const mode of ["emacs", "vi"] as const) {
        tmux("set-option", "-w", "-t", "reference", "mode-keys", mode);
        for (const half of [false, true, "scroll"] as const) {
          tmux("copy-mode", "-t", "reference");
          let cursor = createTerminalCopyCursor(state, mode);
          let originY = 0;
          const steps = half === "scroll" ? 36 : 12;
          for (const direction of [...Array(steps).fill(-1), ...Array(steps).fill(1)] as (
            | -1
            | 1
          )[]) {
            tmux(
              "send-keys",
              "-t",
              "reference",
              "-X",
              half === "scroll"
                ? direction < 0
                  ? "scroll-up"
                  : "scroll-down"
                : half
                  ? direction < 0
                    ? "halfpage-up"
                    : "halfpage-down"
                  : direction < 0
                    ? "page-up"
                    : "page-down",
            );
            const next =
              half === "scroll"
                ? scrollTerminalCopyCursor(cursor, originY, state.rows, direction, 1)
                : pageTerminalCopyCursor(cursor, originY, state.rows, direction, half);
            cursor = next.cursor;
            originY = next.originY;
            if (mode === "vi" && legacyViEnd) {
              const [offset, col, row] = tmux(
                "display-message",
                "-p",
                "-t",
                "reference",
                "#{scroll_position}:#{copy_cursor_x}:#{copy_cursor_y}",
              )
                .split(":")
                .map(Number);
              clampLegacyNativeViEnd(tmux, state, {
                col: col!,
                row: state.history.length - offset! + row!,
              });
            }
            const [offset, col, row] = tmux(
              "display-message",
              "-p",
              "-t",
              "reference",
              "#{scroll_position}:#{copy_cursor_x}:#{copy_cursor_y}",
            )
              .split(":")
              .map(Number);
            expect(originY, `${mode}/${half}/${direction} viewport`).toBe(0 - offset!);
            expect(cursor.position, `${mode}/${half}/${direction} cursor`).toEqual({
              col: col!,
              row: state.history.length - offset! + row!,
            });
          }
          tmux("send-keys", "-t", "reference", "-X", "cancel");
        }
      }
    } finally {
      await owner?.dispose();
      await mirror.dispose();
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
