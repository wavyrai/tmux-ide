import { shellEscape } from "./shell.ts";

/** Fixed commands only. SSH normally omits interactive shell PATH setup. */
export function remoteTmuxIdeCommand(operation: "discover" | "start"): string {
  const args = operation === "discover" ? "remote-daemon-info --json" : "update --daemon --json";
  // Respect the host's existing installation preference, then try the installer
  // and common package-manager prefixes. Never source shell profiles.
  const script =
    'export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.npm-global/bin"; ' +
    `exec tmux-ide ${args}`;
  return `/bin/sh -c ${shellEscape(script)}`;
}
