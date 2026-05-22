/**
 * `tmux-ide dashboard` — print the web dashboard URL and (optionally)
 * open it in the default browser.
 *
 * The daemon already serves the built Solid SPA at its root URL. This
 * command is just a convenience for users who don't know where to point
 * their browser. It reads the canonical daemon info file written by every
 * tmux-ide daemon process on startup.
 */
import { spawn } from "node:child_process";
import { readCanonicalDaemonInfo } from "./lib/canonical-daemon.ts";
import { IdeError } from "./lib/errors.ts";

export interface DashboardOptions {
  json?: boolean;
  open?: boolean;
}

function openInBrowser(url: string): void {
  // Use the OS default-handler tool. Best-effort: failures are silent
  // so the printed URL stays useful even when the open helper is missing.
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Swallow — the URL we printed is still actionable manually.
  }
}

export async function dashboard(opts: DashboardOptions = {}): Promise<void> {
  const info = readCanonicalDaemonInfo();
  if (!info) {
    throw new IdeError(
      "No tmux-ide daemon is running.\n" +
        "Start one by running `tmux-ide` inside a project directory, then re-run this command.",
      { code: "DAEMON_NOT_RUNNING", exitCode: 1 },
    );
  }

  const url = `http://${info.bindHostname}:${info.port}/`;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ url, port: info.port, pid: info.pid }) + "\n");
  } else {
    process.stdout.write(`Dashboard: ${url}\n`);
  }

  if (opts.open !== false) {
    openInBrowser(url);
  }
}
