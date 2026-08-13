import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const PRODUCT_RIG_STATE_VERSION = 1;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function publicRigStatus(state) {
  if (!state) return { status: "stopped", running: false };
  const running = state.status !== "stopped" && processAlive(state.ownerPid);
  return {
    version: state.version,
    status: running ? state.status : "stopped",
    running,
    ownerPid: state.ownerPid,
    runtimeNamespace: state.runtimeNamespace,
    session: state.session,
    daemon: state.daemon
      ? {
          pid: state.daemon.pid,
          port: state.daemon.port,
          instanceId: state.daemon.instanceId,
        }
      : null,
    web: state.web ? { pageUrl: state.web.pageUrl } : null,
    tui: state.tui ?? null,
    artifactDir: state.artifactDir,
    timelinePath: state.timelinePath,
    failure: state.failure ?? null,
  };
}

export function coherentReadiness({ chromeMs, terminalMs }) {
  return {
    appChromeFrameMs: Number.isFinite(chromeMs) ? Math.round(chromeMs) : null,
    coherentTerminalFrameMs: Number.isFinite(terminalMs) ? Math.round(terminalMs) : null,
    ready:
      Number.isFinite(chromeMs) &&
      Number.isFinite(terminalMs) &&
      Number(terminalMs) >= Number(chromeMs),
  };
}
