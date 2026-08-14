import { execFile } from "node:child_process";

export interface OpenTuiHostLocalTmuxAdapter {
  configureClipboard(): void;
  putAway(): Promise<void>;
}

function runTmux(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", [...args], (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The only direct tmux capability retained by the OpenTUI renderer.
 *
 * Workspace/session/window/pane mutation belongs to the daemon. These calls
 * affect only the terminal client hosting this renderer, plus tmux's clipboard
 * passthrough policy, and therefore cannot be represented as shared workspace
 * state.
 */
export function createOpenTuiHostLocalTmuxAdapter(
  hosted = process.env.TMUX_IDE_HOSTED === "1",
): OpenTuiHostLocalTmuxAdapter {
  return {
    configureClipboard() {
      void Promise.all([
        runTmux(["set-option", "-gq", "set-clipboard", "on"]),
        runTmux(["set-option", "-gq", "allow-passthrough", "on"]),
      ]).catch(() => undefined);
    },
    async putAway() {
      if (!hosted) return;
      try {
        await runTmux(["switch-client", "-l"]);
      } catch {
        await runTmux(["detach-client"]);
      }
    },
  };
}
