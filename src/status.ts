import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { getSessionName } from "./lib/yaml-io.ts";
import {
  getSessionState,
  getSessionVariable,
  getDaemonPort,
  isDaemonHealthy,
  isProcessAlive,
  listPanes,
} from "./lib/tmux.ts";

export async function status(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const configExists = existsSync(resolve(dir, "ide.yml"));

  const state = getSessionState(session);
  const running = state.running;
  let panes: ReturnType<typeof listPanes> = [];

  if (running) panes = listPanes(session);

  const monitorPid = running ? getSessionVariable(session, "@monitor_pid") : null;
  const daemonPort = running ? getDaemonPort(session) : null;
  const healthy = daemonPort ? await isDaemonHealthy(session) : false;

  const data = {
    session,
    running,
    configExists,
    panes,
    daemon: {
      pid: monitorPid ? parseInt(monitorPid, 10) : null,
      alive: monitorPid ? isProcessAlive(parseInt(monitorPid, 10)) : false,
      port: daemonPort,
      healthy,
    },
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Session: ${session}`);
  console.log(`Running: ${running ? "yes" : "no"}`);
  console.log(`Config:  ${configExists ? "ide.yml found" : "no ide.yml"}`);

  if (running) {
    console.log(
      `Daemon:  ${data.daemon.alive ? "running" : "not running"}${data.daemon.port ? ` (port ${data.daemon.port})` : ""}`,
    );
  }

  if (panes.length > 0) {
    console.log(`\nPanes:`);
    for (const p of panes) {
      const active = p.active ? " (active)" : "";
      console.log(`  ${p.index}: ${p.title} [${p.width}x${p.height}]${active}`);
    }
  }
}
