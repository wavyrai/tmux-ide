import { execFile } from "node:child_process";
import type { DaemonServicePlan } from "./daemon-service-plan.ts";

export interface DaemonServiceState {
  readonly loaded: boolean;
  readonly active: boolean;
  readonly pid: number | null;
  readonly definitionPath: string | null;
}

export type ServiceCommand = (
  file: string,
  args: readonly string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runCommand: ServiceCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        }),
    );
  });

export class DaemonServiceManagerError extends Error {
  readonly code = "DAEMON_SERVICE_MANAGER_FAILED";
  constructor(
    readonly operation: string,
    readonly manager: string,
  ) {
    super(`${manager} user service ${operation} failed; check the user manager and service logs`);
    this.name = "DaemonServiceManagerError";
  }
}

/** Bounded argv-only OS boundary. Never expose manager output (it may contain environment data). */
export function createDaemonServiceManager(plan: DaemonServicePlan, run = runCommand) {
  const launchd = plan.manager === "launchd";
  const file = launchd ? "/bin/launchctl" : "systemctl";
  const domain = plan.target.slice(0, plan.target.lastIndexOf("/"));
  const command = async (operation: string, args: readonly string[]) => {
    const result = await run(file, launchd ? args : ["--user", ...args]);
    if (result.code !== 0) throw new DaemonServiceManagerError(operation, plan.manager);
    return result;
  };
  return {
    async available(): Promise<void> {
      await command(
        "availability check",
        launchd ? ["print-disabled", domain] : ["show-environment"],
      );
    },
    async inspect(): Promise<DaemonServiceState> {
      const result = await run(
        file,
        launchd
          ? ["print", plan.target]
          : [
              "--user",
              "show",
              plan.target,
              "--property=LoadState,ActiveState,MainPID,FragmentPath",
            ],
      );
      const absent = { loaded: false, active: false, pid: null, definitionPath: null } as const;
      if (launchd) {
        if (result.code === 113 && result.stderr.includes("Could not find service")) return absent;
        if (result.code !== 0) throw new DaemonServiceManagerError("inspection", plan.manager);
        const field = (name: string) =>
          result.stdout.match(new RegExp(`^\\t${name} = (.*)$`, "m"))?.[1];
        const path = field("path");
        const pidText = field("pid");
        const state = field("state");
        if (!path || !state || (pidText !== undefined && !/^[1-9][0-9]*$/u.test(pidText)))
          throw new DaemonServiceManagerError("inspection format", plan.manager);
        return {
          loaded: true,
          active: state === "running",
          pid: pidText ? Number(pidText) : null,
          definitionPath: path,
        };
      }
      const fields = new Map<string, string>();
      for (const line of result.stdout.trim().split("\n")) {
        const index = line.indexOf("=");
        if (index < 1 || fields.has(line.slice(0, index)))
          throw new DaemonServiceManagerError("inspection format", plan.manager);
        fields.set(line.slice(0, index), line.slice(index + 1));
      }
      if (fields.get("LoadState") === "not-found" && (result.code === 0 || result.code === 4))
        return absent;
      if (result.code !== 0 || fields.get("LoadState") !== "loaded" || !fields.has("ActiveState"))
        throw new DaemonServiceManagerError("inspection", plan.manager);
      const pidText = fields.get("MainPID");
      const path = fields.get("FragmentPath");
      if (!pidText || !/^(0|[1-9][0-9]*)$/u.test(pidText) || !path)
        throw new DaemonServiceManagerError("inspection format", plan.manager);
      return {
        loaded: true,
        active: fields.get("ActiveState") === "active",
        pid: Number(pidText) || null,
        definitionPath: path,
      };
    },
    async install(): Promise<void> {
      if (launchd) await command("bootstrap", ["bootstrap", domain, plan.unitPath]);
      else {
        await command("reload", ["daemon-reload"]);
        // The manager may have a different XDG_CONFIG_HOME from the invoking
        // shell. Enable the owned file explicitly so it is linked into its search path.
        await command("enable/start", ["enable", "--now", plan.unitPath]);
      }
    },
    async restart(hasProcess = true): Promise<void> {
      // An explicit recovery after a failed launcher must also clear systemd's
      // start-rate counter. The lifecycle owner has already verified this unit's
      // private definition and reservation; never reset all user units.
      if (!launchd && !hasProcess)
        await command("reset failed state", ["reset-failed", plan.target]);
      // KeepAlive relaunches after a graceful TERM. kickstart -k would force-kill
      // the daemon instead of allowing canonical ownership to be released.
      await command(
        "restart",
        launchd
          ? hasProcess
            ? ["kill", "SIGTERM", plan.target]
            : ["kickstart", plan.target]
          : ["restart", plan.target],
      );
    },
    async stop(): Promise<void> {
      await command(
        "stop/remove",
        launchd ? ["bootout", plan.target] : ["disable", "--now", plan.target],
      );
    },
    async reload(): Promise<void> {
      if (!launchd) await command("reload", ["daemon-reload"]);
    },
  };
}
