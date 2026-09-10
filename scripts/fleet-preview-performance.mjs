#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "fleet-preview-perf-"));
const state = join(directory, "state");
mkdirSync(state);
const socket = `fleet-preview-${process.pid}`;
const tmux = execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
const env = {
  ...process.env,
  TMUX: "",
  TMUX_IDE_HOME: directory,
  TMUX_IDE_DAEMON_INFO_DIR: state,
  TMUX_IDE_REGISTRY_DIR: state,
  TMUX_IDE_TMUX_SOCKET_NAME: socket,
  TMUX_IDE_TMUX_BIN: tmux,
};
delete env.TMUX_IDE_TMUX_SOCKET_PATH;
const cli = (...args) =>
  execFileSync(process.execPath, [join(repo, "bin/cli.js"), ...args], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
let daemon;
try {
  execFileSync(
    tmux,
    [
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "preview-perf",
      "-x",
      "120",
      "-y",
      "30",
      "printf 'FLEET_PREVIEW_FIXTURE\\n'; sleep 120",
    ],
    { env },
  );
  cli("update", "--daemon", "--json");
  daemon = JSON.parse(readFileSync(join(state, "daemon.json"), "utf8"));
  const base = `http://127.0.0.1:${daemon.port}`;
  const headers = {
    Authorization: `Bearer ${daemon.authToken}`,
    "Content-Type": "application/json",
  };
  const catalog = await (
    await fetch(base + "/api/resources/workspace-catalog?version=3", { headers })
  ).json();
  const session = catalog.liveSessions.find((s) => s.sessionName === "preview-perf");
  if (!session) throw new Error("Fixture not discovered");
  const captures = [],
    health = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const pending = fetch(base + "/api/resources/fleet-preview", {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedInstanceId: daemon.instanceId,
        liveSessionId: session.liveSessionId,
      }),
    });
    const healthStart = performance.now();
    const identity = await fetch(base + "/identity");
    await identity.body?.cancel();
    health.push(performance.now() - healthStart);
    const response = await pending;
    const body = await response.json();
    if (!response.ok || !body.text.includes("FLEET_PREVIEW_FIXTURE"))
      throw new Error("Preview failed");
    captures.push(performance.now() - start);
    await new Promise((resolve) => setTimeout(resolve, 260));
  }
  const p95 = (values) =>
    Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] * 10) / 10;
  console.log(
    JSON.stringify(
      {
        samples: captures.length,
        previewP95Ms: p95(captures),
        identityDuringPreviewP95Ms: p95(health),
        verifiedText: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (daemon) {
    try {
      process.kill(daemon.pid, "SIGTERM");
    } catch {
      // The private process may already have exited.
    }
  }
  try {
    execFileSync(tmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // The private process may already have exited.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(directory, { recursive: true, force: true });
}
