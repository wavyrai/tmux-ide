import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { captureTmuxServerProof, captureTmuxServerProofAsync } from "./tmux-server-proof.ts";
import {
  createPinnedWorkspaceTmuxRunner,
  createPinnedWorkspaceTmuxAsyncRunner,
} from "./workspace-pane-creation.ts";

const bundled = fileURLToPath(
  new URL(`../../dist/native/tmux/${process.platform}-${process.arch}/tmux`, import.meta.url),
);
const candidates = [
  { label: "bundled", executable: bundled },
  { label: "system", executable: "tmux" },
].map((candidate) => {
  const probe = spawnSync(candidate.executable, ["-V"], { encoding: "utf8" });
  return { ...candidate, available: probe.status === 0, version: probe.stdout?.trim() ?? "" };
});

function fixture(executable: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tmi-native-")));
  const env = { PATH: process.env.PATH, TERM: "xterm-256color", TMUX_TMPDIR: root };
  const selectors = [
    ["-L", "a"],
    ["-L", "b"],
  ];
  const run = (server: number, args: string[], selector = selectors[server]!) =>
    execFileSync(executable, [...selector, ...args], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const absent = (server: number) =>
    spawnSync(executable, [...selectors[server]!, "-N", "list-sessions"], {
      env,
      timeout: 5_000,
      stdio: "ignore",
    }).status !== 0;
  const start = (server: number) =>
    run(server, ["-f", "/dev/null", "new-session", "-d", "-s", "zz-primary", "exec sleep 300"]);
  const close = () => {
    for (const selector of selectors) {
      spawnSync(executable, [...selector, "kill-server"], {
        env,
        timeout: 5_000,
        stdio: "ignore",
      });
    }
    rmSync(root, { recursive: true, force: true });
  };
  return { run, start, absent, close };
}

for (const candidate of candidates) {
  describe.skipIf(!candidate.available)(
    `native tmux semantics (${candidate.label}: ${candidate.version || "unavailable"})`,
    () => {
      it("proves live aliases and replacement without creating an absent server", async () => {
        const f = fixture(candidate.executable);
        try {
          const runA = (args: readonly string[]) => f.run(0, [...args]);
          expect(captureTmuxServerProof(runA)).toBeNull();
          expect(await captureTmuxServerProofAsync(async (args) => runA(args))).toBeNull();
          expect(f.absent(0)).toBe(true);
          f.start(0);
          f.start(1);
          const socket = f.run(0, ["display-message", "-p", "#{socket_path}"]);
          const executablePath = realpathSync(
            candidate.executable === "tmux"
              ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()
              : candidate.executable,
          );
          const authority = {
            executablePath,
            socketSelector: { kind: "path" as const, path: socket },
          };
          const pinned = createPinnedWorkspaceTmuxRunner(authority);
          const pinnedAsync = createPinnedWorkspaceTmuxAsyncRunner(authority);
          const before = captureTmuxServerProof(runA);
          expect(before).toMatchObject({ version: 1, kind: "live" });
          expect(captureTmuxServerProof(pinned)).toEqual(before);
          expect(await captureTmuxServerProofAsync(pinnedAsync)).toEqual(before);
          const other = captureTmuxServerProof((args) => f.run(1, [...args]));
          expect(other).not.toBeNull();
          expect(other).not.toEqual(before);
          f.run(0, ["kill-server"]);
          await expect.poll(() => f.absent(0)).toBe(true);
          f.start(0);
          const after = captureTmuxServerProof(runA);
          expect(after).toMatchObject({ version: 1, kind: "live" });
          expect(after).not.toEqual(before);
          expect(captureTmuxServerProof(pinned)).toBeNull();
          expect(await captureTmuxServerProofAsync(pinnedAsync)).toBeNull();
          expect(captureTmuxServerProof((args) => f.run(1, [...args]))).toEqual(other);
        } finally {
          f.close();
        }
      });

      it("scopes identical native IDs to each server and isolates server replacement", async () => {
        const f = fixture(candidate.executable);
        try {
          f.start(0);
          f.start(1);
          const identity = [
            "display-message",
            "-p",
            "-t",
            "zz-primary:0",
            "#{session_name}|#{session_id}|#{window_id}|#{pane_id}",
          ];
          expect(f.run(0, identity)).toBe("zz-primary|$0|@0|%0");
          expect(f.run(1, identity)).toBe(f.run(0, identity));
          const pid = ["display-message", "-p", "#{pid}"];
          const oldA = f.run(0, pid);
          const oldB = f.run(1, pid);
          expect(oldA).not.toBe(oldB);
          f.run(1, ["set-option", "-t", "zz-primary", "@fixture_marker", "unchanged"]);
          const topology = [
            "list-panes",
            "-a",
            "-F",
            "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_layout}",
          ];
          const beforeB = f.run(1, topology);
          f.run(0, ["kill-server"]);
          await expect.poll(() => f.absent(0)).toBe(true);
          f.start(0);
          expect(f.run(0, pid)).not.toBe(oldA);
          expect(f.run(0, identity)).toBe("zz-primary|$0|@0|%0");
          expect(f.run(1, pid)).toBe(oldB);
          expect(f.run(1, topology)).toBe(beforeB);
          expect(f.run(1, ["show-options", "-qv", "-t", "zz-primary", "@fixture_marker"])).toBe(
            "unchanged",
          );
        } finally {
          f.close();
        }
      });

      it("selects duplicate links independently, unlinks one, and kills a shared backing", () => {
        const f = fixture(candidate.executable);
        try {
          f.start(0);
          f.run(0, ["link-window", "-d", "-s", "zz-primary:0", "-t", "zz-primary:3"]);
          const windows = [
            "list-windows",
            "-t",
            "zz-primary",
            "-F",
            "#{window_index}|#{window_id}|#{window_active}",
          ];
          expect(f.run(0, windows)).toBe("0|@0|1\n3|@0|0");
          f.run(0, ["select-window", "-t", "zz-primary:3"]);
          expect(f.run(0, windows)).toBe("0|@0|0\n3|@0|1");
          f.run(0, ["select-window", "-t", "zz-primary:0"]);
          expect(f.run(0, windows)).toBe("0|@0|1\n3|@0|0");
          f.run(0, ["unlink-window", "-t", "zz-primary:3"]);
          expect(f.run(0, windows)).toBe("0|@0|1");
          expect(f.run(0, ["list-panes", "-t", "zz-primary:0", "-F", "#{pane_id}"])).toBe("%0");
          f.run(0, ["link-window", "-d", "-s", "zz-primary:0", "-t", "zz-primary:3"]);
          f.run(0, ["new-session", "-d", "-s", "zz-secondary", "exec sleep 300"]);
          f.run(0, ["link-window", "-d", "-s", "zz-primary:0", "-t", "zz-secondary:4"]);
          f.run(0, ["kill-window", "-t", "zz-primary:3"]);
          expect(
            f.run(0, ["list-windows", "-a", "-F", "#{session_name}|#{window_index}|#{window_id}"]),
          ).toBe("zz-secondary|0|@1");
          expect(f.run(0, ["list-panes", "-a", "-F", "#{pane_id}"])).toBe("%1");
        } finally {
          f.close();
        }
      });

      it("resolves named and explicit socket aliases to the same live server", () => {
        const f = fixture(candidate.executable);
        try {
          f.start(0);
          const socket = f.run(0, ["display-message", "-p", "#{socket_path}"]);
          const identity = [
            "display-message",
            "-p",
            "#{pid}|#{session_id}|#{window_id}|#{pane_id}",
          ];
          expect(f.run(0, identity, ["-S", socket])).toBe(f.run(0, identity));
          f.run(
            0,
            ["set-option", "-t", "zz-primary", "@alias_marker", "same-owner"],
            ["-S", socket],
          );
          expect(f.run(0, ["show-options", "-qv", "-t", "zz-primary", "@alias_marker"])).toBe(
            "same-owner",
          );
        } finally {
          f.close();
        }
      });
    },
  );
}
