import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WindowLinkAuthority } from "../terminal/mirror/window-link-authority.ts";

import {
  buildNativeWindowLinkGuard,
  buildNativeWindowLinkPaneSelectGuard,
  classifyNativeWindowLinkGuardResult,
} from "./tmux-window-link-guard.ts";

function guarded(
  sessionId: string,
  windowIndex: number,
  expectedWindowId: string,
  action: "select" | "unlink",
) {
  return buildNativeWindowLinkGuard({ sessionId, windowIndex, expectedWindowId }, action);
}

const bundled = fileURLToPath(
  new URL(`../../dist/native/tmux/${process.platform}-${process.arch}/tmux`, import.meta.url),
);
for (const executable of [bundled, "tmux"]) {
  const available = spawnSync(executable, ["-V"], { stdio: "ignore" }).status === 0;
  describe.skipIf(!available)(`native window link guard (${executable})`, () => {
    function fixture() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "tmi-link-")));
      const env = { PATH: process.env.PATH, TERM: "xterm-256color", TMUX_TMPDIR: root };
      const result = (args: string[]) =>
        spawnSync(executable, ["-L", "guard", ...args], { env, encoding: "utf8", timeout: 5000 });
      const run = (args: string[]) =>
        execFileSync(executable, ["-L", "guard", ...args], {
          env,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trimEnd();
      run(["-f", "/dev/null", "new-session", "-d", "-s", "zz-guard", "exec sleep 300"]);
      const snapshot = () =>
        run([
          "list-windows",
          "-t",
          "$0",
          "-F",
          "#{window_index}|#{window_id}|#{window_active}|#{pane_id}|#{pane_pid}",
        ]);
      const runAsync = (args: string[]) =>
        promisify(execFile)(executable, ["-L", "guard", ...args], { env, timeout: 5000 });
      return {
        run,
        runAsync,
        result,
        snapshot,
        close() {
          result(["kill-server"]);
          rmSync(root, { recursive: true, force: true });
        },
      };
    }

    it("selects each duplicate link, unlinks only one, and preserves native last-link refusal", () => {
      const f = fixture();
      try {
        f.run(["link-window", "-s", "$0:0", "-t", "$0:1"]);
        for (const index of [1, 0, 1]) {
          expect(f.run(guarded("$0", index, "@0", "select"))).toBe("link-guard.ok");
          expect(f.run(["display-message", "-p", "-t", "$0", "#{window_index}"])).toBe(
            String(index),
          );
        }
        const pane = f.run(["display-message", "-p", "-t", "$0:0", "#{pane_id}|#{pane_pid}"]);
        expect(f.run(guarded("$0", 1, "@0", "unlink"))).toBe("link-guard.ok");
        expect(f.snapshot()).toBe(`0|@0|1|${pane}`);
        const refusal = f.result(guarded("$0", 0, "@0", "unlink"));
        expect(refusal.status).not.toBe(0);
        expect(classifyNativeWindowLinkGuardResult(refusal.status, refusal.stdout)).toBe(
          "native-refused",
        );
        expect(refusal.stderr).toContain("window only linked to one session");
        expect(refusal.stdout).not.toContain("link-guard.ok");
        expect(f.snapshot()).toBe(`0|@0|1|${pane}`);
      } finally {
        f.close();
      }
    });

    it("reconciles opaque handles with real link selection and unlink", () => {
      const f = fixture();
      try {
        f.run(["link-window", "-s", "$0:0", "-t", "$0:1"]);
        const authority = new WindowLinkAuthority(`live-session.${"a".repeat(20)}`, "$0");
        const observe = () =>
          authority.reconcile(
            f
              .snapshot()
              .split("\n")
              .map((line) => {
                const [index, runtimeWindowId, active] = line.split("|");
                return {
                  index: Number(index),
                  runtimeWindowId: runtimeWindowId!,
                  semanticWindowId: "window.fixture",
                  active: active === "1",
                };
              }),
          );
        const before = observe();
        const link = before.links.find((row) => row.displayIndex === 1)!;
        const target = {
          liveSessionId: before.liveSessionId,
          linkId: link.linkId,
          expectedSemanticWindowId: link.semanticWindowId,
          linkRevision: before.linkRevision,
        };
        const native = authority.resolve(target);
        expect(
          f.run(guarded(native.runtimeSessionId, native.index, native.runtimeWindowId, "select")),
        ).toBe("link-guard.ok");
        const selected = observe();
        expect(selected.activeLinkId).toBe(link.linkId);
        expect(selected.links).toEqual(before.links);
        expect(selected.linkRevision).toBe(before.linkRevision);
        expect(
          f.run(guarded(native.runtimeSessionId, native.index, native.runtimeWindowId, "unlink")),
        ).toBe("link-guard.ok");
        const after = observe();
        expect(after.links).toHaveLength(1);
        expect(after.links[0]!.linkId).toBe(before.links[0]!.linkId);
        expect(() => authority.resolve(target)).toThrow("window_link_stale");
      } finally {
        f.close();
      }
    });

    it("selects a specific nonactive pane through either duplicate link", () => {
      const f = fixture();
      try {
        f.run(["split-window", "-d", "-t", "$0:0", "exec sleep 300"]);
        f.run(["link-window", "-s", "$0:0", "-t", "$0:1"]);
        for (const [windowIndex, paneId] of [
          [1, "%1"],
          [0, "%0"],
        ] as const) {
          expect(
            f.run(
              buildNativeWindowLinkPaneSelectGuard(
                { sessionId: "$0", windowIndex, expectedWindowId: "@0" },
                paneId,
              ),
            ),
          ).toBe("link-guard.ok");
          expect(f.run(["display-message", "-p", "-t", "$0", "#{window_index}|#{pane_id}"])).toBe(
            `${windowIndex}|${paneId}`,
          );
        }
      } finally {
        f.close();
      }
    });

    for (const moved of [false, true]) {
      it(`refuses ${moved ? "moved" : "missing"} pane before selecting a link`, () => {
        const f = fixture();
        try {
          f.run(["split-window", "-d", "-t", "$0:0", "exec sleep 300"]);
          f.run(["link-window", "-s", "$0:0", "-t", "$0:1"]);
          f.run(["new-window", "-t", "$0:2", "exec sleep 300"]);
          if (moved) f.run(["join-pane", "-d", "-s", "%1", "-t", "$0:2"]);
          else f.run(["kill-pane", "-t", "%1"]);
          const before = f.snapshot();
          expect(
            f.run(
              buildNativeWindowLinkPaneSelectGuard(
                { sessionId: "$0", windowIndex: 1, expectedWindowId: "@0" },
                "%1",
              ),
            ),
          ).toBe("link-guard.stale");
          expect(f.snapshot()).toBe(before);
        } finally {
          f.close();
        }
      });
    }

    for (const hookMutation of ["pane", "link"] as const) {
      it(`revalidates after a yielding window-selection hook changes the ${hookMutation}`, () => {
        const f = fixture();
        try {
          f.run(["split-window", "-d", "-t", "$0:0", "exec sleep 300"]);
          f.run(["link-window", "-s", "$0:0", "-t", "$0:1"]);
          f.run(["new-window", "-t", "$0:2", "exec sleep 300"]);
          const mutation =
            hookMutation === "pane"
              ? "join-pane -d -s %1 -t $0:2"
              : "swap-window -d -s $0:1 -t $0:2";
          f.run([
            "set-hook",
            "-t",
            "$0",
            "after-select-window",
            `run-shell 'sleep 0.01' ; ${mutation}`,
          ]);
          const result = f.result(
            buildNativeWindowLinkPaneSelectGuard(
              { sessionId: "$0", windowIndex: 1, expectedWindowId: "@0" },
              "%1",
            ),
          );
          expect(result.stdout.trim()).toBe("link-guard.interrupted");
          expect(classifyNativeWindowLinkGuardResult(result.status, result.stdout)).toBe(
            "indeterminate",
          );
          expect(f.run(["display-message", "-p", "-t", "%1", "#{pane_active}"])).toBe("0");
          expect(f.run(["display-message", "-p", "-t", "%1", "#{window_id}"])).toBe(
            hookMutation === "pane" ? "@1" : "@0",
          );
        } finally {
          f.close();
        }
      });
    }

    it("preserves the native after-select-pane hook after the guarded selection", () => {
      const f = fixture();
      try {
        f.run(["split-window", "-d", "-t", "$0:0", "exec sleep 300"]);
        f.run([
          "set-hook",
          "-t",
          "$0",
          "after-select-pane",
          "set-option -t $0 @guard-hook observed",
        ]);
        expect(
          f.run(
            buildNativeWindowLinkPaneSelectGuard(
              { sessionId: "$0", windowIndex: 0, expectedWindowId: "@0" },
              "%1",
            ),
          ),
        ).toBe("link-guard.ok");
        expect(f.run(["show-option", "-v", "-t", "$0", "@guard-hook"])).toBe("observed");
        expect(f.run(["display-message", "-p", "-t", "$0:0", "#{pane_id}"])).toBe("%1");
      } finally {
        f.close();
      }
    });

    it("serializes a competing swap and guarded unlink without unlinking the replacement", async () => {
      for (let iteration = 0; iteration < 12; iteration++) {
        const f = fixture();
        try {
          f.run(["link-window", "-s", "$0:0", "-t", "$0:2"]);
          f.run(["new-window", "-d", "-t", "$0:1", "exec sleep 300"]);
          f.run(["new-session", "-d", "-s", "zz-survivor", "exec sleep 300"]);
          f.run(["link-window", "-s", "$0:1", "-t", "$1:1"]);
          const unlink = () => f.runAsync(guarded("$0", 2, "@0", "unlink"));
          const swap = () => f.runAsync(["swap-window", "-d", "-s", "$0:1", "-t", "$0:2"]);
          const results = await Promise.allSettled(
            iteration % 2 ? [unlink(), swap()] : [swap(), unlink()],
          );
          const guard = results[iteration % 2 ? 0 : 1]!;
          expect(guard.status).toBe("fulfilled");
          if (guard.status === "fulfilled")
            expect(guard.value.stdout.trim()).toMatch(/^link-guard\.(ok|stale)$/u);
          const windows = f
            .run(["list-windows", "-a", "-F", "#{session_id}|#{window_id}"])
            .split("\n");
          expect(windows.filter((row) => row === "$0|@1")).toHaveLength(1);
          expect(windows.filter((row) => row === "$1|@1")).toHaveLength(1);
          // @0's original link always survives regardless of which client wins.
          expect(f.run(["display-message", "-p", "-t", "$0:0", "#{window_id}"])).toBe("@0");
        } finally {
          f.close();
        }
      }
    });

    it("refuses a missing session instead of applying the current session fallback", () => {
      const f = fixture();
      try {
        f.run(["link-window", "-s", "$0:0", "-t", "$0:1"]);
        const before = f.snapshot();
        for (const action of ["select", "unlink"] as const) {
          expect(f.run(guarded("$999", 0, "@0", action))).toBe("link-guard.stale");
          expect(f.snapshot()).toBe(before);
        }
      } finally {
        f.close();
      }
    });

    for (const mutation of ["swap", "reuse", "renumber", "missing"] as const) {
      it(`refuses stale select and unlink after ${mutation} without touching replacement`, () => {
        const f = fixture();
        try {
          f.run(["new-window", "-d", "-t", "$0:1", "exec sleep 300"]);
          // Ensure an erroneous unlink could succeed, making no-mutation assertions meaningful.
          f.run(["new-session", "-d", "-s", "zz-survivor", "exec sleep 300"]);
          f.run(["link-window", "-s", "$0:1", "-t", "$1:1"]);
          if (mutation === "swap") f.run(["swap-window", "-d", "-s", "$0:0", "-t", "$0:1"]);
          if (mutation === "reuse") {
            f.run(["kill-window", "-t", "$0:0"]);
            f.run(["link-window", "-s", "$0:1", "-t", "$0:0"]);
          }
          if (mutation === "renumber") {
            f.run(["kill-window", "-t", "$0:0"]);
            f.run(["move-window", "-r", "-t", "$0"]);
          }
          if (mutation === "missing") f.run(["kill-window", "-t", "$0:0"]);
          f.run(["new-window", "-t", "$0:9", "exec sleep 300"]);
          const before = f.snapshot();
          for (const action of ["select", "unlink"] as const) {
            expect(f.run(guarded("$0", 0, "@0", action))).toBe("link-guard.stale");
            expect(f.snapshot()).toBe(before);
          }
        } finally {
          f.close();
        }
      });
    }
  });
}
