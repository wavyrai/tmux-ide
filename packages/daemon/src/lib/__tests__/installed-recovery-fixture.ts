/**
 * Private fleet fixture for the installed-artifact recovery and authority
 * live tests. One fixture owns one private tmux server, one private state
 * home and every CLI child it spawns, and retires all of them on `cleanup`.
 *
 * Socket unification: the CLI's plain `tmux` paths (adopt, restore, polling
 * wait) resolve `$TMUX_TMPDIR/tmux-<uid>/default`, while the daemon pins its
 * server by `TMUX_IDE_TMUX_SOCKET_PATH` and strips `TMUX_TMPDIR` from its
 * pinned client. Pointing the pinned path at exactly the resolved default
 * path makes both paths reach the same private server, which the fixture
 * proves with `assertUnifiedSocket` before any scenario runs.
 *
 * CLI under test: `TMUX_IDE_QUALIFY_CLI` (absolute path to an installed
 * `tmux-ide` executable or its `cli.js`) qualifies a packed installation;
 * otherwise the fixture bundles `bin/cli.ts` from this checkout.
 */
import { build } from "esbuild";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WsWebSocket from "ws";
import type { CanonicalDaemonInfo } from "../canonical-daemon.ts";

export const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
export const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface EventsClient {
  /** Every parsed protocol frame in arrival order. */
  frames: Array<Record<string, unknown>>;
  /** Resolves once the fleet-catalog interest is acknowledged. */
  ready: Promise<void>;
  /** Resolves with the close code once the daemon side goes away. */
  closed: Promise<number>;
  close(): void;
}

export interface PrivateFleet {
  root: string;
  stateDir: string;
  socketPath: string;
  cliPath: string;
  cliLabel: string;
  env: NodeJS.ProcessEnv;
  tmux(...args: string[]): string;
  tmuxStatus(...args: string[]): number;
  cli(args: string[]): ChildProcess;
  exit(child: ChildProcess): Promise<ChildExit>;
  bounded<T>(promise: Promise<T>, label: string, ms?: number): Promise<T>;
  until<T>(read: () => T | null, label: string, ms?: number): Promise<T>;
  info(): CanonicalDaemonInfo | null;
  /** Start `tmux-ide --headless --json` and wait for its record to publish. */
  startDaemon(): Promise<{ child: ChildProcess; info: CanonicalDaemonInfo }>;
  /** Subscribe a raw `/ws/events` client with a fleet-catalog interest. */
  eventsClient(info: CanonicalDaemonInfo): EventsClient;
  fetchJson(info: CanonicalDaemonInfo, path: string, init?: RequestInit): Promise<unknown>;
  /** Read the daemon's in-memory log ring through the SSE backfill. */
  logBackfill(info: CanonicalDaemonInfo): Promise<Array<Record<string, unknown>>>;
  /** Stamp a pane so the fleet detects it as an agent in `state`. */
  stampAgent(paneId: string, state: "working" | "blocked" | "done" | "idle"): void;
  /** Append one evidence line (JSON) for the qualification report. */
  evidence(record: Record<string, unknown>): void;
  cleanup(): Promise<void>;
}

function evidencePath(): string | null {
  const dir = process.env.TMUX_IDE_STAGE6_EVIDENCE_DIR;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, "evidence.jsonl");
}

async function resolveCli(root: string): Promise<{ path: string; label: string }> {
  const configured = process.env.TMUX_IDE_QUALIFY_CLI;
  if (configured) {
    const path = realpathSync(configured);
    return { path, label: `installed:${path}` };
  }
  const bundle = join(root, "cli.mjs");
  await build({
    entryPoints: [join(repoRoot, "bin/cli.ts")],
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
  return { path: bundle, label: "checkout-bundle" };
}

export async function createPrivateFleet(prefix: string): Promise<PrivateFleet> {
  // A short root keeps the unix socket path well under the platform limit.
  const root = mkdtempSync(`/tmp/ti-${prefix}-`);
  const stateDir = join(root, "state");
  const home = join(root, "home");
  const tmuxTmpDir = join(root, "tmux");
  const socketDir = join(tmuxTmpDir, `tmux-${userInfo().uid}`);
  const socketPath = join(socketDir, "default");
  const binDir = join(root, "bin");
  for (const dir of [stateDir, home, tmuxTmpDir, socketDir, binDir])
    mkdirSync(dir, { mode: 0o700 });
  chmodSync(tmuxTmpDir, 0o700);
  chmodSync(socketDir, 0o700);
  if (!process.env.TMUX_IDE_QUALIFY_CLI) {
    // The checkout bundle resolves its externals from this repo's node_modules.
    execFileSync("ln", ["-s", join(repoRoot, "node_modules"), join(root, "node_modules")]);
  }
  const cliResolved = await resolveCli(root);
  const tmuxPath = realpathSync(
    execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(),
  );
  // The chrome updater session runs `exec tmux-ide chrome-updater` from the
  // server's PATH; this shim routes it to the CLI under test.
  writeFileSync(
    join(binDir, "tmux-ide"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliResolved.path)} "$@"\n`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TMUX_IDE_") &&
          key !== "TMUX" &&
          key !== "TMUX_PANE" &&
          key !== "TMUX_TMPDIR",
      ),
    ),
    PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    HOME: home,
    TMUX: "",
    TMUX_TMPDIR: tmuxTmpDir,
    TMUX_IDE_HOME: stateDir,
    TMUX_IDE_DAEMON_INFO_DIR: stateDir,
    TMUX_IDE_REGISTRY_DIR: stateDir,
    TMUX_IDE_SETTINGS_DIR: stateDir,
    TMUX_IDE_CONFIG: join(stateDir, "config.json"),
    TMUX_IDE_TMUX_BIN: tmuxPath,
    TMUX_IDE_TMUX_SOCKET_PATH: socketPath,
    NO_COLOR: "1",
  };
  const infoPath = join(stateDir, "daemon.json");
  const children = new Set<ChildProcess>();
  const exits = new Map<ChildProcess, Promise<ChildExit>>();
  const sockets = new Set<WsWebSocket>();

  const tmux = (...args: string[]): string =>
    execFileSync(tmuxPath, ["-S", socketPath, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const tmuxStatus = (...args: string[]): number =>
    spawnSync(tmuxPath, ["-S", socketPath, ...args], { env, stdio: "ignore" }).status ?? -1;

  const cli = (args: string[]): ChildProcess => {
    const child = spawn(process.execPath, [cliResolved.path, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-64000);
    });
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-64000);
    });
    exits.set(
      child,
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      }),
    );
    return child;
  };
  const exit = (child: ChildProcess): Promise<ChildExit> => exits.get(child)!;

  const bounded = async <T>(promise: Promise<T>, label: string, ms = 20000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const until = async <T>(read: () => T | null, label: string, ms = 15000): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== null) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out after ${ms}ms: ${label}`);
  };
  const info = (): CanonicalDaemonInfo | null => {
    try {
      return JSON.parse(readFileSync(infoPath, "utf8"));
    } catch {
      return null;
    }
  };

  const startDaemon = async () => {
    const child = cli(["--headless", "--json"]);
    const published = await Promise.race([
      until(() => {
        const value = info();
        return value?.pid === child.pid ? value : null;
      }, "daemon record publication"),
      exit(child).then((result) => {
        throw new Error(`Daemon exited before publication: ${result.stdout} ${result.stderr}`);
      }),
    ]);
    // The record publishes before the HTTP accept loop is guaranteed up.
    await until(() => {
      const probe = spawnSync(
        "curl",
        [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${published.port}/health`,
        ],
        { encoding: "utf8" },
      );
      return probe.stdout === "200" ? true : null;
    }, "daemon health");
    return { child, info: published };
  };

  const headers = (info: CanonicalDaemonInfo): Record<string, string> =>
    info.authToken ? { authorization: `Bearer ${info.authToken}` } : {};

  const fetchJson = async (info: CanonicalDaemonInfo, path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      ...init,
      headers: { ...headers(info), "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5000),
    });
    return response.json();
  };

  const eventsClient = (info: CanonicalDaemonInfo): EventsClient => {
    const socket = new WsWebSocket(`ws://127.0.0.1:${info.port}/ws/events`, {
      headers: headers(info),
    });
    sockets.add(socket);
    const frames: Array<Record<string, unknown>> = [];
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => {
        sockets.delete(socket);
        rejectReady(new Error(`events socket closed (${code}) before ready`));
        resolve(code);
      });
    });
    socket.on("error", (error) => rejectReady(error));
    socket.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            sessions: [],
            legacyEvents: true,
            interests: [{ resource: "fleet-catalog", workspaceName: null }],
            interestRevision: 1,
          }),
        );
      } else if (frame.type === "resource.interests-ack") {
        resolveReady();
      }
    });
    return {
      frames,
      ready,
      closed,
      close: () => {
        try {
          socket.close();
        } catch {
          // already gone
        }
      },
    };
  };

  const logBackfill = async (info: CanonicalDaemonInfo) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const entries: Array<Record<string, unknown>> = [];
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/api/logs/daemon`, {
        headers: headers(info),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      let buffer = "";
      let sawBookmark = false;
      while (!sawBookmark) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/mu.exec(block)?.[1];
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (event === "bookmark") sawBookmark = true;
          else if (data) {
            try {
              const parsed = JSON.parse(data);
              if (Array.isArray(parsed)) entries.push(...parsed);
              else entries.push(parsed);
            } catch {
              entries.push({ raw: data, event });
            }
          }
          index = buffer.indexOf("\n\n");
        }
      }
      controller.abort();
    } catch {
      // aborted after the bookmark or on the deadline; return what arrived
    } finally {
      clearTimeout(timer);
    }
    return entries;
  };

  const stampAgent = (paneId: string, state: "working" | "blocked" | "done" | "idle"): void => {
    tmux(
      "set-option",
      "-p",
      "-t",
      paneId,
      "@agent_state",
      `${state}:${Math.floor(Date.now() / 1000)}`,
    );
  };

  const evidenceFile = evidencePath();
  const evidence = (record: Record<string, unknown>): void => {
    if (!evidenceFile) return;
    appendFileSync(
      evidenceFile,
      JSON.stringify({ at: new Date().toISOString(), cli: cliResolved.label, ...record }) + "\n",
    );
  };

  const cleanup = async () => {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch {
        // already closed
      }
    }
    const current = info();
    if (current) {
      await fetch(`http://127.0.0.1:${current.port}/api/v2/action/daemon.shutdown`, {
        method: "POST",
        headers: { ...headers(current), "content-type": "application/json" },
        body: JSON.stringify({
          reason: "live fixture cleanup",
          expectedInstanceId: current.instanceId,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    }
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(
      [...children].map(async (child) => {
        try {
          await bounded(exit(child), "fixture child exit", 10000);
        } catch {
          child.kill("SIGKILL");
          await exit(child).catch(() => undefined);
        }
      }),
    );
    spawnSync(tmuxPath, ["-S", socketPath, "kill-server"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
    if (existsSync(root)) throw new Error(`fixture root survived cleanup: ${root}`);
  };

  return {
    root,
    stateDir,
    socketPath,
    cliPath: cliResolved.path,
    cliLabel: cliResolved.label,
    env,
    tmux,
    tmuxStatus,
    cli,
    exit,
    bounded,
    until,
    info,
    startDaemon,
    eventsClient,
    fetchJson,
    logBackfill,
    stampAgent,
    evidence,
    cleanup,
  };
}

/**
 * Prove the plain-`tmux` CLI path and the daemon's pinned socket path name
 * the same server. Requires a running server on the fixture socket.
 */
export function assertUnifiedSocket(fleet: PrivateFleet): void {
  const plain = execFileSync("tmux", ["display-message", "-p", "#{socket_path}"], {
    env: fleet.env,
    encoding: "utf8",
  }).trim();
  const pinned = fleet.tmux("display-message", "-p", "#{socket_path}");
  if (plain !== fleet.socketPath || pinned !== fleet.socketPath)
    throw new Error(`socket split: plain=${plain} pinned=${pinned} expected=${fleet.socketPath}`);
}

export const uniqueName = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;
