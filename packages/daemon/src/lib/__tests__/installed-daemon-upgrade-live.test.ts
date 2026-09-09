import { build } from "esbuild";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { CanonicalDaemonInfo } from "../canonical-daemon.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const packageVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

it.skipIf(!available)(
  "upgrades a running daemon once under concurrent installed CLI updates without replacing tmux panes",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-ide-upgrade-"));
    const socket = `tmux-ide-upgrade-${process.pid}-${randomUUID().slice(0, 8)}`;
    const state = join(directory, "state");
    const home = join(directory, "home");
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(home);
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    const tmuxPath = execFileSync("/bin/sh", ["-c", "command -v tmux"], {
      encoding: "utf8",
    }).trim();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TMUX: "",
      TMUX_IDE_TMUX_BIN: tmuxPath,
      TMUX_IDE_TMUX_SOCKET_NAME: socket,
      TMUX_IDE_DAEMON_INFO_DIR: state,
      TMUX_IDE_REGISTRY_DIR: state,
      TMUX_IDE_SETTINGS_DIR: state,
      NO_COLOR: "1",
    };
    delete env.TMUX_IDE_TMUX_SOCKET_PATH;
    const infoPath = join(state, "daemon.json");
    const info = (): CanonicalDaemonInfo | null => {
      try {
        return JSON.parse(readFileSync(infoPath, "utf8"));
      } catch {
        return null;
      }
    };
    const tmux = (...args: string[]) =>
      execFileSync(tmuxPath, ["-L", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
      }).trimEnd();
    const children: ChildProcess[] = [];
    const exits = new Map<
      ChildProcess,
      Promise<{ code: number | null; stdout: string; stderr: string }>
    >();
    const start = (args: string[]) => {
      const child = spawn(process.execPath, args, {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-16000);
      });
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-16000);
      });
      exits.set(
        child,
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        }),
      );
      return child;
    };
    const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), 20000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const until = async <T>(read: () => T | null, label: string): Promise<T> => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const value = read();
        if (value !== null) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out: ${label}`);
    };
    try {
      const idle = start([
        join(root, "bin/cli.js"),
        "update",
        "--daemon",
        "--if-running",
        "--json",
      ]);
      const idleResult = await bounded(exits.get(idle)!, "idle update");
      expect(idleResult.code, idleResult.stderr).toBe(0);
      expect(JSON.parse(idleResult.stdout)).toMatchObject({ ok: true, status: "not-running" });
      expect(info()).toBeNull();
      expect(
        spawnSync(tmuxPath, ["-L", socket, "has-session"], { env, stdio: "ignore" }).status,
      ).not.toBe(0);
      const oldEntry = join(directory, "older-daemon.ts");
      const oldBundle = join(directory, "older-daemon.mjs");
      // Real production lifecycle with deliberately older version metadata. This
      // proves replacement semantics, not backward compatibility with old code.
      // Match the CLI: exit only after headless graceful stop resolves and stdout flushes.
      writeFileSync(
        oldEntry,
        `import { runHeadlessDaemon } from ${JSON.stringify(join(root, "packages/daemon/src/lib/headless-daemon.ts"))};\nawait runHeadlessDaemon({ expectedVersion: "2.9.0-beta.9", json: true });\nawait new Promise(resolve => process.stdout.write("", resolve));\nprocess.exit(0);\n`,
      );
      await build({
        entryPoints: [oldEntry],
        outfile: oldBundle,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        logLevel: "silent",
        plugins: [
          {
            name: "external-dependencies",
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (
                  args.kind === "entry-point" ||
                  args.path.startsWith(".") ||
                  args.path.startsWith("/") ||
                  args.path.startsWith("@tmux-ide/") ||
                  args.path === "@xterm/addon-unicode11"
                )
                  return;
                return { external: true };
              });
            },
          },
        ],
      });
      const paint = join(directory, "pane.mjs");
      writeFileSync(
        paint,
        `process.stdout.write(Array.from({length:80},(_,i)=>"KEEP-HISTORY-"+i).join("\\r\\n")+"\\r\\nKEEP-LIVE\\r\\n");setInterval(()=>{},10000);`,
      );
      tmux("new-session", "-d", "-s", "keep", "-x", "80", "-y", "12", process.execPath, paint);
      await until(
        () =>
          tmux("capture-pane", "-p", "-S", "-", "-t", "keep").includes("KEEP-LIVE") ? true : null,
        "pane output",
      );
      const pane = tmux("display-message", "-p", "-t", "keep", "#{pid}|#{pane_id}|#{pane_pid}");
      const history = tmux("capture-pane", "-p", "-S", "-", "-t", "keep");
      const old = start([oldBundle]);
      const prior = await Promise.race([
        until(() => {
          const value = info();
          return value?.pid === old.pid ? value : null;
        }, "old daemon"),
        exits.get(old)!.then((result) => {
          throw new Error(`Old daemon exited before readiness: ${result.stderr}`);
        }),
      ]);
      expect(prior.productVersion).toBe("2.9.0-beta.9");
      const commands = Array.from({ length: 2 }, () =>
        start([join(root, "bin/cli.js"), "update", "--daemon", "--if-running", "--json"]),
      );
      const results = await bounded(
        Promise.all(commands.map((child) => exits.get(child)!)),
        "concurrent updates",
      );
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          status: "ready",
          productVersion: packageVersion,
        });
      }
      const next = await until(() => {
        const value = info();
        return value &&
          value.instanceId !== prior.instanceId &&
          value.productVersion === packageVersion
          ? value
          : null;
      }, "replacement daemon");
      expect(results.map((result) => JSON.parse(result.stdout).instanceId)).toEqual([
        next.instanceId,
        next.instanceId,
      ]);
      const oldExit = await bounded(exits.get(old)!, "old daemon exit");
      expect(oldExit.code).toBe(0);
      const identity = await (await fetch(`http://127.0.0.1:${next.port}/identity`)).json();
      expect(identity).toMatchObject({
        instanceId: next.instanceId,
        productVersion: packageVersion,
      });
      expect(tmux("display-message", "-p", "-t", "keep", "#{pid}|#{pane_id}|#{pane_pid}")).toBe(
        pane,
      );
      expect(tmux("capture-pane", "-p", "-S", "-", "-t", "keep")).toBe(history);
    } finally {
      const current = info();
      if (current?.authToken)
        await fetch(`http://127.0.0.1:${current.port}/api/v2/action/daemon.shutdown`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${current.authToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            reason: "isolated upgrade test cleanup",
            expectedInstanceId: current.instanceId,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await until(() => (!existsSync(infoPath) ? true : null), "daemon cleanup").catch(
        () => undefined,
      );
      spawnSync(tmuxPath, ["-L", socket, "kill-server"], { env, stdio: "ignore" });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  45000,
);
