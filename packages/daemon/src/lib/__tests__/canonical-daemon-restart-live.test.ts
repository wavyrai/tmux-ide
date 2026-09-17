import { build } from "esbuild";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { fleetSessionIdForName } from "../../command-center/resources/fleet-catalog.ts";
import type { CanonicalDaemonInfo } from "../canonical-daemon.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const packageVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

it.skipIf(!available)(
  "restarts the actual CLI daemon in its supervising process and preserves a promoted sentinel pane",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-ide-restart-"));
    const socket = `tmux-ide-restart-${process.pid}-${randomUUID().slice(0, 8)}`;
    const state = join(directory, "state");
    const home = join(directory, "home");
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(home);
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    const tmuxPath = execFileSync("/bin/sh", ["-c", "command -v tmux"], {
      encoding: "utf8",
    }).trim();
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("TMUX_IDE_") && key !== "TMUX" && key !== "TMUX_PANE",
        ),
      ),
      HOME: home,
      TMUX: "",
      TMUX_IDE_RUNTIME_MODE: "test",
      TMUX_IDE_HOME: state,
      TMUX_IDE_CLEANUP_TOKEN: `restart-${randomUUID()}`,
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
      const bundle = join(directory, "cli.mjs");
      await build({
        entryPoints: [join(root, "bin/cli.ts")],
        outfile: bundle,
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
        `process.stdout.write("KEEP-RUNTIME-WORK\\r\\n");setInterval(()=>{},10000);`,
      );
      tmux("new-session", "-d", "-s", "keep", "-x", "80", "-y", "12", process.execPath, paint);
      await until(
        () =>
          tmux("capture-pane", "-p", "-t", "keep").includes("KEEP-RUNTIME-WORK") ? true : null,
        "sentinel pane",
      );
      const daemon = start([bundle, "--headless", "--json"]);
      const prior = await Promise.race([
        until(() => {
          const value = info();
          return value?.pid === daemon.pid ? value : null;
        }, "daemon publication"),
        exits.get(daemon)!.then((result) => {
          throw new Error(`Daemon exited: ${result.stderr}`);
        }),
      ]);
      const promoted = await fetch(
        `http://127.0.0.1:${prior.port}/api/v2/action/workspace.promote`,
        {
          method: "POST",
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Bearer ${prior.authToken}`,
            "content-type": "application/json",
            "X-Tmux-Ide-Operation-Id": randomUUID(),
          },
          body: JSON.stringify({ sessionId: fleetSessionIdForName("keep") }),
        },
      );
      expect(await promoted.json()).toMatchObject({ ok: true });
      const pane = tmux(
        "display-message",
        "-p",
        "-t",
        "keep",
        "#{pid}|#{pane_id}|#{pane_pid}|#{@tmux_ide_pane_id}",
      );
      expect(pane.split("|")[3]).toMatch(/^pane\.promoted\.[0-9a-f]+$/u);
      const history = tmux("capture-pane", "-p", "-S", "-", "-t", "keep");
      const command = start([bundle, "daemon", "restart", "--json"]);
      const result = await bounded(exits.get(command)!, "runtime restart CLI");
      expect(result.code, result.stderr).toBe(0);
      const next = info()!;
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "restarted",
        pid: daemon.pid,
        previousInstanceId: prior.instanceId,
        instanceId: next.instanceId,
        productVersion: packageVersion,
      });
      expect(next.pid).toBe(prior.pid);
      expect(next.instanceId).not.toBe(prior.instanceId);
      expect(next.port).toBe(prior.port);
      expect(next.bindHostname).toBe(prior.bindHostname);
      expect(daemon.exitCode).toBeNull();
      expect(
        tmux(
          "display-message",
          "-p",
          "-t",
          "keep",
          "#{pid}|#{pane_id}|#{pane_pid}|#{@tmux_ide_pane_id}",
        ),
      ).toBe(pane);
      expect(tmux("capture-pane", "-p", "-S", "-", "-t", "keep")).toBe(history);
      const shutdown = await fetch(`http://127.0.0.1:${next.port}/api/v2/action/daemon.shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${next.authToken}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedInstanceId: next.instanceId }),
      });
      expect(await shutdown.json()).toMatchObject({ ok: true, result: { stopping: true } });
      expect((await bounded(exits.get(daemon)!, "ordinary shutdown")).code).toBe(0);
      expect(info()).toBeNull();
      expect(
        tmux(
          "display-message",
          "-p",
          "-t",
          "keep",
          "#{pid}|#{pane_id}|#{pane_pid}|#{@tmux_ide_pane_id}",
        ),
      ).toBe(pane);
      expect(tmux("capture-pane", "-p", "-S", "-", "-t", "keep")).toBe(history);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      await Promise.all(
        children.map(async (child) => {
          try {
            await bounded(exits.get(child)!, "fixture child cleanup");
          } catch {
            child.kill("SIGKILL");
            await exits.get(child);
          }
        }),
      );
      spawnSync(tmuxPath, ["-L", socket, "kill-server"], { env, stdio: "ignore" });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  45000,
);
