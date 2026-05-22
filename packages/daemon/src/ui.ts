import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  type CanonicalDaemonInfo,
} from "./canonical.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function hostnameForClient(bindHostname: string): string {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}

function dashboardUrl(info: CanonicalDaemonInfo): string {
  return `http://${hostnameForClient(info.bindHostname)}:${info.port}`;
}

export function openInBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawnSync("open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: false });
    return;
  }
  spawnSync("xdg-open", [url], { stdio: "ignore" });
}

function cliPath(): string {
  const candidates = [
    resolve(__dirname, "bin.ts"),
    resolve(__dirname, "..", "bin", "cli.js"),
    resolve(__dirname, "..", "..", "..", "bin", "cli.ts"),
    resolve(__dirname, "..", "..", "..", "bin", "cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function spawnHeadless(): void {
  const child = spawn(process.execPath, [cliPath(), "--headless"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForDaemon(timeoutMs = 10_000): Promise<CanonicalDaemonInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readCanonicalDaemonInfo();
    if (info && (await isCanonicalDaemonAlive(info))) return info;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  return null;
}

export async function uiCommand(): Promise<void> {
  let info = readCanonicalDaemonInfo();
  if (!info || !(await isCanonicalDaemonAlive(info))) {
    spawnHeadless();
    info = await waitForDaemon();
  }

  if (!info) {
    throw new Error("Could not start the tmux-ide daemon");
  }

  const url = dashboardUrl(info);
  console.log(`Opening dashboard at ${url}`);
  openInBrowser(url);
}
