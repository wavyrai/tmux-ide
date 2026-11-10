import { shellEscape } from "./shell.ts";

// Respect the host's existing installation preference, then try the installer
// and common package-manager prefixes. Never source shell profiles.
const REMOTE_PATH =
  'export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.npm-global/bin"; ';

/** Fixed commands only. SSH normally omits interactive shell PATH setup. */
export function remoteTmuxIdeCommand(operation: "discover" | "start"): string {
  return remoteTmuxIdeArgsCommand(
    operation === "discover" ? ["remote-daemon-info", "--json"] : ["update", "--daemon", "--json"],
  );
}

/** `tmux-ide <args…>` on a remote host, each argument quoted for its shell. */
export function remoteTmuxIdeArgsCommand(args: readonly string[]): string {
  const script = REMOTE_PATH + `exec tmux-ide ${args.map(shellEscape).join(" ")}`;
  return `/bin/sh -c ${shellEscape(script)}`;
}
