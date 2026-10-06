import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { resolveBundledTmux } from "../bundled-tmux.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const anchor = process.env.TMUX_IDE_TEST_BUNDLED_CLI_ANCHOR;

it.skipIf(!anchor)(
  "uses bundled tmux without PATH tmux while preserving ordinary and explicit clients",
  async () => {
    const binary = resolveBundledTmux([anchor!]);
    expect(binary).not.toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "tmux-cli-resolution-"));
    const socket = join(directory, "owned.sock");
    const emptyPath = join(directory, "empty-path");
    mkdirSync(emptyPath);
    const environment = {
      HOME: directory,
      PATH: emptyPath,
      TMUX: `${socket},0,0`,
      TMUX_TMPDIR: directory,
      TMUX_IDE_CLI: anchor!,
      TMUX_IDE_DAEMON_INFO_DIR: join(directory, "state"),
      TERM: "xterm-256color",
    };
    const tmux = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, "-f", "/dev/null", ...args], {
        env: environment,
        encoding: "utf8",
        timeout: 5_000,
      });
    const cli = (extra: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [join(root, "bin/cli.js"), "status", "--json"], {
        cwd: directory,
        env: { ...environment, ...extra },
        encoding: "utf8",
        timeout: 10_000,
      });
    const log = join(directory, "selected-clients");
    const wrapper = (path: string, label: string) => {
      writeFileSync(
        path,
        `#!/bin/sh\nprintf '%s\\n' '${label}' >> '${log}'\nexec '${binary}' "$@"\n`,
      );
      chmodSync(path, 0o755);
    };
    let absent: number | null;
    let identity: string | undefined;
    try {
      tmux("new-session", "-d", "-s", basename(directory), "/bin/sleep 60");
      identity = tmux(
        "display-message",
        "-p",
        "#{pid}|#{session_id}|#{pane_id}|#{pane_pid}",
      ).trim();
      const assertStatus = (extra: NodeJS.ProcessEnv = {}) => {
        const result = cli(extra);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const status = JSON.parse(result.stdout);
        expect(status.running).toBe(true);
        expect(status.panes).toHaveLength(1);
        expect(
          tmux("display-message", "-p", "#{pid}|#{session_id}|#{pane_id}|#{pane_pid}").trim(),
        ).toBe(identity);
      };
      assertStatus();
      assertStatus();
      const path = join(directory, "path");
      mkdirSync(path);
      wrapper(join(path, "tmux"), "ordinary");
      const explicit = join(directory, "explicit-tmux");
      wrapper(explicit, "explicit");
      assertStatus({ PATH: path });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["ordinary", "ordinary"]);
      writeFileSync(log, "");
      assertStatus({ PATH: "path" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["ordinary", "ordinary"]);
      writeFileSync(log, "");
      wrapper(join(directory, "tmux"), "cwd");
      assertStatus({ PATH: "" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["cwd", "cwd"]);
      writeFileSync(log, "");
      assertStatus({ PATH: path, TMUX_IDE_TMUX_BIN: explicit });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["explicit", "explicit"]);
      writeFileSync(log, "");
      const invalid = cli({ PATH: path, TMUX_IDE_TMUX_BIN: join(directory, "missing") });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("tmux_executable_unavailable");
      expect(readFileSync(log, "utf8")).toBe("");
      assertStatus();
      process.stdout.write(
        `TM06 clean PATH: ${JSON.stringify({
          identity,
          binary,
          binarySha256: createHash("sha256").update(readFileSync(binary!)).digest("hex"),
          cliSha256: createHash("sha256")
            .update(readFileSync(join(root, "bin/cli.js")))
            .digest("hex"),
          cases: [
            "bundle",
            "bundle-repeat",
            "ordinary-PATH",
            "relative-PATH",
            "empty-PATH",
            "explicit-over-PATH",
            "invalid-explicit-fails",
            "recovery",
          ],
        })}\n`,
      );
    } finally {
      spawnSync(binary!, ["-S", socket, "kill-server"], { env: environment, timeout: 5_000 });
      absent = spawnSync(binary!, ["-S", socket, "has-session"], {
        env: environment,
        timeout: 5_000,
      }).status;
      try {
        if (identity) {
          const [serverPid, , , panePid] = identity.split("|");
          await vi.waitFor(
            () => {
              for (const pid of [serverPid, panePid]) {
                let code: string | undefined;
                try {
                  process.kill(Number(pid), 0);
                } catch (error) {
                  code = (error as NodeJS.ErrnoException).code;
                }
                expect(code).toBe("ESRCH");
              }
            },
            { timeout: 2_000 },
          );
        }
        process.stdout.write(
          `TM06 cleanup: ${JSON.stringify({ serverAbsentStatus: absent, identity, ownedProcessesAbsent: true })}\n`,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    expect(absent).toBe(1);
  },
  30_000,
);
