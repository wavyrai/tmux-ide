import { resolve } from "node:path";
import { getSessionState, isProcessAlive, listPanes } from "@tmux-ide/tmux-bridge";
import { isCanonicalDaemonAlive, readCanonicalDaemonInfo } from "./lib/canonical-daemon.ts";
import { resolveProjectConfigContext } from "./lib/config-context.ts";

export async function status(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const context = await resolveProjectConfigContext(dir);
  const session = context.sessionName;

  const state = getSessionState(session);
  const running = state.running;
  let panes: ReturnType<typeof listPanes> = [];

  if (running) panes = listPanes(session);

  const daemonInfo = readCanonicalDaemonInfo();
  const healthy = daemonInfo ? await isCanonicalDaemonAlive(daemonInfo) : false;

  const data = {
    session,
    running,
    configExists: context.configExists,
    hasWorkspaceConfig: context.hasWorkspaceConfig,
    hasIdeYml: context.hasIdeYml,
    configKind: context.configKind,
    configPath: context.configPath,
    panes,
    daemon: {
      pid: daemonInfo?.pid ?? null,
      alive: daemonInfo ? isProcessAlive(daemonInfo.pid) : false,
      port: daemonInfo?.port ?? null,
      healthy,
    },
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Session: ${session}`);
  console.log(`Running: ${running ? "yes" : "no"}`);
  console.log(
    `Config:  ${context.configExists ? `${context.configKind} config found` : "no config"}`,
  );

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
