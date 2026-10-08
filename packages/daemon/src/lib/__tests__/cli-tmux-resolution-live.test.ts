import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { resolveBundledTmux } from "../bundled-tmux.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const anchor = process.env.TMUX_IDE_TEST_BUNDLED_CLI_ANCHOR;
const systemBinary = process.env.TMUX_IDE_TEST_SYSTEM_TMUX;
if (anchor && systemBinary) throw Error("Select bundled or system tmux, not both");
const selectedCli = process.env.TMUX_IDE_TEST_CLI_EXECUTABLE;
const receiptPath = process.env.TMUX_IDE_TEST_CLI_RECEIPT;
for (const [name, value] of Object.entries({
  TMUX_IDE_TEST_CLI_EXECUTABLE: selectedCli,
  TMUX_IDE_TEST_CLI_RECEIPT: receiptPath,
  TMUX_IDE_TEST_SYSTEM_TMUX: systemBinary,
})) {
  if (value !== undefined && !isAbsolute(value)) throw Error(`${name} must be absolute`);
}
const cliPath = selectedCli ?? join(root, "bin/cli.js");
if (selectedCli !== undefined && !statSync(cliPath).isFile())
  throw Error("Selected CLI must be a file");

it.skipIf(!anchor && !systemBinary)(
  "resolves selected installed tmux while preserving ordinary and explicit clients",
  async () => {
    const binary = systemBinary ? realpathSync(systemBinary) : resolveBundledTmux([anchor!]);
    expect(binary).not.toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "tmux-cli-resolution-"));
    const socket = join(directory, "owned.sock");
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const initialCliHash = hash(cliPath);
    const initialNativeHash = hash(binary!);
    const receipt: Record<string, unknown> = {
      version: 1,
      phase: "prepared",
      directory,
      socket,
      bundleAnchor: anchor,
      nativeMode: systemBinary ? "system-fallback" : "bundled",
      bundledCleanPath: systemBinary
        ? { applicable: false, reason: "explicit system-fallback lane" }
        : { applicable: true },
      cli: {
        path: cliPath,
        realpath: realpathSync(cliPath),
        sha256: initialCliHash,
        selection: selectedCli === undefined ? "repository-default" : "explicit",
      },
      native: { path: binary, realpath: realpathSync(binary!), sha256: initialNativeHash },
      cases: [],
      cleanup: { confirmed: false },
    };
    const persist = () => {
      if (!receiptPath) return;
      mkdirSync(dirname(receiptPath), { recursive: true });
      const temporary = `${receiptPath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, receiptPath);
    };
    persist();
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
      spawnSync(process.execPath, [cliPath, "status", "--json"], {
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
    const retireOwned = async () => {
      try {
        if (!identity)
          throw Error("Missing creation identity; retain owned directory for inspection");
        {
          const parts = identity.split("|");
          const [serverPid, serverStart, sessionId, paneId, panePid] = parts;
          if (
            parts.length !== 5 ||
            !/^[1-9]\d*$/.test(serverPid ?? "") ||
            !/^[1-9]\d*$/.test(serverStart ?? "") ||
            !/^\$\d+$/.test(sessionId ?? "") ||
            !/^%\d+$/.test(paneId ?? "") ||
            !/^[1-9]\d*$/.test(panePid ?? "")
          )
            throw Error("Invalid owned server/session/pane identity");
          const guard = `#{&&:#{==:#{pid},${serverPid}},#{==:#{start_time},${serverStart}}}`;
          const killed = spawnSync(
            binary!,
            [
              "-S",
              socket,
              "if-shell",
              "-F",
              guard,
              "kill-server",
              "display-message -p identity-mismatch",
            ],
            { env: environment, encoding: "utf8", timeout: 5_000 },
          );
          // A naturally exited server may reject this command; exact process
          // absence below still proves retirement. A responding wrong owner does not.
          if (killed.error || killed.signal !== null || killed.stdout.trim() !== "")
            throw Error("Owned server retirement unconfirmed or identity mismatch");
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
        absent = spawnSync(binary!, ["-S", socket, "has-session"], {
          env: environment,
          timeout: 5_000,
        }).status;
        expect(absent).toBe(1);
        receipt.finalHashes = { cli: hash(cliPath), native: hash(binary!) };
        expect(hash(cliPath)).toBe(initialCliHash);
        expect(hash(binary!)).toBe(initialNativeHash);
        receipt.cleanup = {
          confirmed: true,
          serverAbsentStatus: absent,
          ownedProcessesAbsent: true,
        };
        receipt.phase = "retired";
        persist();
        process.stdout.write(`TM06 cleanup: ${JSON.stringify(receipt.cleanup)}\n`);
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        receipt.cleanup = { confirmed: false, error: String(error), retainedDirectory: directory };
        persist();
        throw error;
      }
    };
    try {
      identity = tmux(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}",
        "-s",
        basename(directory),
        "/bin/sleep 60",
      ).trim();
      const [serverPid, serverStart, sessionId, paneId, panePid] = identity.split("|");
      receipt.phase = "native-created";
      receipt.ownership = { identity, serverPid, serverStart, sessionId, paneId, panePid };
      persist();
      expect(serverPid).toMatch(/^\d+$/);
      expect(serverStart).toMatch(/^[1-9]\d*$/);
      expect(sessionId).toMatch(/^\$\d+$/);
      expect(paneId).toMatch(/^%\d+$/);
      expect(panePid).toMatch(/^[1-9]\d*$/);
      const assertStatus = (extra: NodeJS.ProcessEnv = {}) => {
        const result = cli(extra);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const status = JSON.parse(result.stdout);
        expect(status.running).toBe(true);
        expect(status.panes).toHaveLength(1);
        expect(
          tmux(
            "display-message",
            "-p",
            "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}",
          ).trim(),
        ).toBe(identity);
      };
      if (!systemBinary) {
        assertStatus();
        assertStatus();
      }
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
      assertStatus(systemBinary ? { PATH: path } : {});
      receipt.phase = "cases-passed";
      receipt.cases = [
        ...(!systemBinary ? ["bundle", "bundle-repeat"] : []),
        "ordinary-PATH",
        "relative-PATH",
        "empty-PATH",
        "explicit-over-PATH",
        "invalid-explicit-fails",
        "recovery",
      ];
      persist();
      process.stdout.write(
        `TM06 clean PATH: ${JSON.stringify({
          identity,
          binary,
          binarySha256: createHash("sha256").update(readFileSync(binary!)).digest("hex"),
          cliSha256: createHash("sha256").update(readFileSync(cliPath)).digest("hex"),
          cases: receipt.cases,
        })}\n`,
      );
    } catch (error) {
      receipt.failure = String(error);
      throw error;
    } finally {
      await retireOwned();
    }
    expect(absent).toBe(1);
  },
  30_000,
);
