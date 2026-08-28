/** Engine-neutral lifecycle model for daemon-owned fleet mutations. */
import { TMUX_TRUECOLOR_ENVIRONMENT_ARGS, truecolorShellCommand } from "./tmux-terminal-color.ts";

const LAUNCH_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  aider: "aider",
  copilot: "copilot",
  cursor: "cursor-agent",
  goose: "goose",
  amp: "amp",
  devin: "devin",
  kimi: "kimi",
  pi: "pi",
  grok: "grok",
  kiro: "kiro-cli",
  cline: "cline",
  droid: "droid",
  kilo: "kilo",
};

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
]);

export const INTERRUPT_TAP_GAP_MS = 250;
export const RESTART_GRACE_MS = 1_000;

export function launchCommandForHarness(harness: string): string {
  return LAUNCH_COMMANDS[harness] ?? harness;
}

export function paneStartHostsShell(startCommand: string): boolean {
  const token = startCommand.trim().split(/\s+/u)[0] ?? "";
  const basename =
    token.replace(/^-/, "").replace(/\\/gu, "/").split("/").pop()?.toLowerCase() ?? "";
  return basename === "" || SHELLS.has(basename.replace(/\.exe$/u, ""));
}

export function interruptArgs(paneId: string): string[] {
  return ["send-keys", "-t", paneId, "C-c"];
}

export function relaunchArgs(paneId: string, command: string): string[][] {
  return [
    ["send-keys", "-t", paneId, "-l", truecolorShellCommand(command)],
    ["send-keys", "-t", paneId, "Enter"],
  ];
}

export function respawnArgs(paneId: string, command: string, dir: string | null): string[] {
  const args = ["respawn-pane", "-k", "-t", paneId, ...TMUX_TRUECOLOR_ENVIRONMENT_ARGS];
  if (dir) args.push("-c", dir);
  args.push(command);
  return args;
}

export function clearAuthorityArgs(paneId: string): string[][] {
  return [
    ["set-option", "-p", "-t", paneId, "-u", "@agent_state"],
    ["set-option", "-p", "-t", paneId, "-u", "@agent_session_id"],
  ];
}
