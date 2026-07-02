import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { IdeError } from "./lib/errors.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_REMOTE_PORT = 6060;
const DEFAULT_LOCAL_HOST = "127.0.0.1";

export interface SshRemote {
  name: string;
  host: string;
  path: string;
  localPort?: number;
  remotePort?: number;
  addedAt: string;
  // Where the most recent `launch` tunnel landed locally. The daemon uses this
  // to fold tunneled remotes into the central agents view and to proxy control
  // traffic through the tunnel.
  lastLocalPort?: number;
  lastLaunchedAt?: string;
}

interface SshRemoteStore {
  version: 1;
  remotes: SshRemote[];
}

interface SshRemoteOptions {
  json?: boolean;
  sub?: string;
  args?: string[];
  values?: Record<string, string | boolean | undefined>;
}

interface SshTunnel {
  pid: number;
  stop(): void;
}

export function remotesFilePath(): string {
  return process.env.TMUX_IDE_SSH_REMOTES_FILE ?? join(homedir(), ".tmux-ide", "ssh-remotes.json");
}

/** Read the configured SSH remotes (validated; empty on missing/corrupt file). */
export async function readSshRemotes(): Promise<SshRemote[]> {
  return (await readStore()).remotes;
}

function sshConfigPath(): string {
  return process.env.TMUX_IDE_SSH_CONFIG ?? join(homedir(), ".ssh", "config");
}

function emptyStore(): SshRemoteStore {
  return { version: 1, remotes: [] };
}

async function readStore(): Promise<SshRemoteStore> {
  const file = remotesFilePath();
  if (!existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<SshRemoteStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.remotes)) return emptyStore();
    return {
      version: 1,
      remotes: parsed.remotes.filter(isSshRemote),
    };
  } catch {
    return emptyStore();
  }
}

async function writeStore(store: SshRemoteStore): Promise<void> {
  const file = remotesFilePath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await import("node:fs/promises").then(({ rename }) => rename(tmp, file));
}

function isSshRemote(value: unknown): value is SshRemote {
  if (!value || typeof value !== "object") return false;
  const remote = value as Partial<SshRemote>;
  if (typeof remote.name !== "string") return false;
  if (typeof remote.host !== "string") return false;
  if (typeof remote.path !== "string") return false;
  if (typeof remote.addedAt !== "string") return false;
  if (remote.localPort !== undefined && !isValidPort(remote.localPort)) return false;
  if (remote.remotePort !== undefined && !isValidPort(remote.remotePort)) return false;
  if (remote.lastLocalPort !== undefined && !isValidPort(remote.lastLocalPort)) return false;
  if (remote.lastLaunchedAt !== undefined && typeof remote.lastLaunchedAt !== "string")
    return false;
  return true;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parsePort(value: string | boolean | undefined, label: string): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true || value.trim() === "") {
    throw new IdeError(`${label} requires a numeric value`, { code: "USAGE" });
  }
  const port = Number(value);
  if (!isValidPort(port)) {
    throw new IdeError(`${label} must be an integer from 1 to 65535`, { code: "USAGE" });
  }
  return port;
}

export function parseSshConfigHosts(contents: string): string[] {
  const hosts = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^Host\s+(.+)$/i);
    if (!match) continue;
    for (const host of match[1]!.split(/\s+/)) {
      if (!host || host.includes("*") || host.includes("?") || host.startsWith("!")) continue;
      hosts.add(host);
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

export function validateRemoteName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new IdeError(
      "Remote name must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.",
      { code: "USAGE" },
    );
  }
}

export function validateSshAlias(host: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(host)) {
    throw new IdeError(
      "SSH host must be a config alias or host string without whitespace or shell metacharacters.",
      { code: "USAGE" },
    );
  }
  if (host.startsWith("-")) {
    throw new IdeError("SSH host cannot start with '-'", { code: "USAGE" });
  }
}

export function validateRemotePath(path: string): void {
  if (!path || /[\0\r\n]/.test(path)) {
    throw new IdeError("Remote path must be a single non-empty path.", { code: "USAGE" });
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteServeScript(remotePath: string, remotePort: number): string {
  validateRemotePath(remotePath);
  if (!isValidPort(remotePort)) {
    throw new IdeError("Remote port must be an integer from 1 to 65535", { code: "USAGE" });
  }
  const quotedPath = shellQuote(remotePath);
  return [
    `cd ${quotedPath}`,
    "mkdir -p .tmux-ide",
    'if ! command -v tmux-ide >/dev/null 2>&1; then echo "tmux-ide not found on remote PATH" >&2; exit 127; fi',
    `nohup tmux-ide __remote-serve --port ${remotePort} > .tmux-ide/remote-daemon.log 2>&1 < /dev/null &`,
  ].join(" && ");
}

export function buildSshForwardArgs(opts: {
  host: string;
  localPort: number;
  remotePort: number;
}): string[] {
  validateSshAlias(opts.host);
  if (!isValidPort(opts.localPort) || !isValidPort(opts.remotePort)) {
    throw new IdeError("SSH tunnel ports must be integers from 1 to 65535", { code: "USAGE" });
  }
  return [
    "-N",
    "-L",
    `${DEFAULT_LOCAL_HOST}:${opts.localPort}:127.0.0.1:${opts.remotePort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    // The tunnel must be a dedicated connection we own. Under ControlMaster
    // multiplexing (common with SSM ProxyCommand setups) the `-N` client can
    // exit immediately after handing off to the persistent master, taking its
    // forward down with it. Disable mux for this one connection.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    opts.host,
  ];
}

async function pickFreeLocalPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_LOCAL_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolvePort(port);
        else reject(new IdeError("Could not allocate a local tunnel port", { code: "PORT_ERROR" }));
      });
    });
  });
}

async function assertLocalPortFree(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", () =>
      reject(new IdeError(`Local port ${port} is already in use`, { code: "PORT_IN_USE" })),
    );
    server.listen(port, DEFAULT_LOCAL_HOST, () => {
      server.close(() => resolvePort());
    });
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // The printed URL is still useful.
  }
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 750).unref?.();
      const res = await fetch(`${url}healthz`, { signal: controller.signal });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  }
  throw new IdeError(
    `Remote dashboard did not become healthy through the SSH tunnel: ${lastError}`,
    {
      code: "REMOTE_UNHEALTHY",
    },
  );
}

async function runRemoteServe(remote: SshRemote, remotePort: number): Promise<void> {
  const script = buildRemoteServeScript(remote.path, remotePort);
  try {
    await execFileAsync("ssh", [remote.host, script], { timeout: 10_000 });
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err && typeof err.stderr === "string"
        ? err.stderr.trim()
        : "";
    throw new IdeError(`Failed to start tmux-ide on ${remote.host}${stderr ? `: ${stderr}` : ""}`, {
      code: "SSH_REMOTE_START_FAILED",
    });
  }
}

async function startTunnel(
  remote: SshRemote,
  localPort: number,
  remotePort: number,
): Promise<SshTunnel> {
  const args = buildSshForwardArgs({ host: remote.host, localPort, remotePort });
  const child = spawn("ssh", args, { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise<void>((resolveStart, reject) => {
    const timer = setTimeout(resolveStart, 500);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new IdeError(
          `SSH tunnel exited before it was ready (${signal ?? `code ${code ?? "unknown"}`})`,
          { code: "SSH_TUNNEL_FAILED" },
        ),
      );
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new IdeError(`Failed to start ssh tunnel: ${err.message}`, { code: "SSH_TUNNEL_FAILED" }),
      );
    });
  });
  return {
    pid: child.pid ?? 0,
    stop: () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

function printRemotes(remotes: SshRemote[]): void {
  if (remotes.length === 0) {
    console.log("No SSH remotes configured");
    return;
  }
  for (const remote of remotes) {
    const local = remote.localPort ? ` local:${remote.localPort}` : "";
    const remotePort = remote.remotePort ? ` remote:${remote.remotePort}` : "";
    console.log(`  ${remote.name} — ${remote.host}:${remote.path}${local}${remotePort}`);
  }
}

async function listHosts(json: boolean | undefined): Promise<void> {
  const file = sshConfigPath();
  const hosts = existsSync(file) ? parseSshConfigHosts(await readFile(file, "utf-8")) : [];
  if (json) {
    console.log(JSON.stringify({ hosts }));
  } else if (hosts.length === 0) {
    console.log("No concrete SSH hosts found");
  } else {
    for (const host of hosts) console.log(host);
  }
}

async function addRemote(opts: SshRemoteOptions): Promise<void> {
  const name = opts.args?.[0];
  const host = opts.values?.host;
  const path = opts.values?.path;
  if (!name || typeof host !== "string" || typeof path !== "string") {
    throw new IdeError(
      "Usage: tmux-ide remote ssh add <name> --host <ssh-host> --path <remote-project-dir> [--local-port N] [--remote-port N]",
      { code: "USAGE" },
    );
  }
  validateRemoteName(name);
  validateSshAlias(host);
  validateRemotePath(path);
  const localPort = parsePort(opts.values?.["local-port"], "--local-port");
  const remotePort = parsePort(opts.values?.["remote-port"], "--remote-port");
  const store = await readStore();
  const next: SshRemote = {
    name,
    host,
    path,
    localPort,
    remotePort,
    addedAt: new Date().toISOString(),
  };
  const index = store.remotes.findIndex((remote) => remote.name === name);
  if (index >= 0) store.remotes[index] = next;
  else store.remotes.push(next);
  await writeStore(store);
  if (opts.json) console.log(JSON.stringify({ ok: true, remote: next }));
  else console.log(`Saved SSH remote ${name} (${host}:${path})`);
}

async function removeRemote(opts: SshRemoteOptions): Promise<void> {
  const name = opts.args?.[0];
  if (!name) {
    throw new IdeError("Usage: tmux-ide remote ssh remove <name>", { code: "USAGE" });
  }
  const store = await readStore();
  const before = store.remotes.length;
  store.remotes = store.remotes.filter((remote) => remote.name !== name);
  await writeStore(store);
  const removed = store.remotes.length !== before;
  if (opts.json) console.log(JSON.stringify({ ok: true, removed }));
  else
    console.log(removed ? `Removed SSH remote ${name}` : `SSH remote ${name} was not configured`);
}

async function getConfiguredRemote(name: string | undefined): Promise<SshRemote> {
  if (!name) {
    throw new IdeError("Usage: tmux-ide remote ssh launch <name>", { code: "USAGE" });
  }
  validateRemoteName(name);
  const store = await readStore();
  const remote = store.remotes.find((candidate) => candidate.name === name);
  if (!remote) {
    throw new IdeError(`SSH remote ${name} is not configured`, { code: "REMOTE_NOT_FOUND" });
  }
  return remote;
}

async function launchRemote(opts: SshRemoteOptions): Promise<void> {
  const remote = await getConfiguredRemote(opts.args?.[0]);
  const remotePort = remote.remotePort ?? DEFAULT_REMOTE_PORT;
  const localPort = remote.localPort ?? (await pickFreeLocalPort());
  if (remote.localPort) await assertLocalPortFree(localPort);
  await runRemoteServe(remote, remotePort);
  const tunnel = await startTunnel(remote, localPort, remotePort);
  const url = `http://${DEFAULT_LOCAL_HOST}:${localPort}/`;
  try {
    await waitForHealth(url);
  } catch (err) {
    tunnel.stop();
    throw err;
  }
  // Record where the tunnel landed so the local daemon can aggregate this
  // remote's agents and proxy control traffic through the tunnel.
  const store = await readStore();
  const stored = store.remotes.find((candidate) => candidate.name === remote.name);
  if (stored) {
    stored.lastLocalPort = localPort;
    stored.lastLaunchedAt = new Date().toISOString();
    await writeStore(store);
  }
  if (opts.json) {
    console.log(
      JSON.stringify({ ok: true, url, localPort, remotePort, tunnelPid: tunnel.pid, remote }),
    );
  } else {
    console.log(`Dashboard: ${url}`);
    console.log(`Tunnel: ${remote.host} 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort}`);
  }
  if (opts.values?.["no-open"] !== true) openInBrowser(url);
}

async function statusRemote(opts: SshRemoteOptions): Promise<void> {
  const remote = await getConfiguredRemote(opts.args?.[0]);
  const localPort = remote.localPort;
  const url = localPort ? `http://${DEFAULT_LOCAL_HOST}:${localPort}/` : null;
  let healthy = false;
  if (url) {
    try {
      const res = await fetch(`${url}healthz`);
      healthy = res.ok;
    } catch {
      healthy = false;
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ remote, url, healthy }));
  } else {
    console.log(`Remote: ${remote.name}`);
    console.log(`SSH host: ${remote.host}`);
    console.log(`Path: ${remote.path}`);
    console.log(`Remote daemon bind: 127.0.0.1:${remote.remotePort ?? DEFAULT_REMOTE_PORT}`);
    if (url) console.log(`Local URL: ${url} (${healthy ? "healthy" : "not reachable"})`);
    else console.log("Local URL: dynamic; run launch to allocate a tunnel port");
  }
}

export async function sshRemoteCommand(opts: SshRemoteOptions): Promise<void> {
  const sub = opts.args?.[0];
  const args = opts.args?.slice(1) ?? [];
  switch (sub) {
    case "hosts":
      await listHosts(opts.json);
      break;
    case "list": {
      const store = await readStore();
      if (opts.json) console.log(JSON.stringify({ remotes: store.remotes }));
      else printRemotes(store.remotes);
      break;
    }
    case "add":
      await addRemote({ ...opts, args });
      break;
    case "remove":
      await removeRemote({ ...opts, args });
      break;
    case "launch":
    case "dashboard":
      await launchRemote({ ...opts, args });
      break;
    case "status":
      await statusRemote({ ...opts, args });
      break;
    default:
      throw new IdeError(
        "Usage: tmux-ide remote ssh hosts|list|add|remove|launch|dashboard|status",
        { code: "USAGE" },
      );
  }
}

export async function remoteServeCommand(opts: { port?: string | boolean }): Promise<void> {
  const port = parsePort(opts.port, "--port") ?? DEFAULT_REMOTE_PORT;
  const dir = resolve(".");
  const { readConfig, getSessionName } = await import("./lib/yaml-io.ts");
  const { launch } = await import("./launch.ts");
  const { startEmbeddedDaemon } = await import("./lib/daemon-embed.ts");
  const { readCanonicalDaemonInfo, isCanonicalDaemonAlive } =
    await import("./lib/canonical-daemon.ts");

  const existing = readCanonicalDaemonInfo();
  if (existing && existing.port === port && existing.bindHostname === "127.0.0.1") {
    if (await isCanonicalDaemonAlive(existing)) return;
  }

  const { config } = readConfig(dir);
  const { name: fallbackName } = getSessionName(dir);
  const sessionName = config.name ?? fallbackName;
  await launch(dir, { attach: false });
  const handle = await startEmbeddedDaemon({
    sessionName,
    port,
    bindHostname: "127.0.0.1",
  });
  const stop = async () => {
    await handle.stop({ gracefulMs: 500 });
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
  await new Promise<void>(() => undefined);
}
