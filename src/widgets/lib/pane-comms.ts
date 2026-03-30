import { execFileSync } from "node:child_process";

export interface PaneInfo {
  id: string;
  index: number;
  title: string;
  currentCommand: string;
  width: number;
  height: number;
  active: boolean;
  role: "lead" | "teammate" | "widget" | "shell" | null;
  name: string | null;
  type: string | null;
}

type TmuxExecutor = (cmd: string, args: string[], options?: object) => string;

let _executor: TmuxExecutor = (cmd, args, options) =>
  execFileSync(cmd, args, { encoding: "utf-8", ...options }).toString();

export function _setExecutor(fn: TmuxExecutor): () => void {
  const prev = _executor;
  _executor = fn;
  return () => {
    _executor = prev;
  };
}

function tmux(...args: string[]): string {
  try {
    return _executor("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString() ?? "";
    if (stderr.includes("no server running") || stderr.includes("can't find session")) {
      return "";
    }
    throw error;
  }
}

export function listSessionPanes(session: string): PaneInfo[] {
  const format = [
    "#{pane_id}",
    "#{pane_index}",
    "#{pane_title}",
    "#{pane_current_command}",
    "#{pane_width}",
    "#{pane_height}",
    "#{pane_active}",
    "#{@ide_role}",
    "#{@ide_name}",
    "#{@ide_type}",
  ].join("\t");

  const output = tmux("list-panes", "-t", session, "-F", format);
  if (!output) return [];

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, index, title, cmd, width, height, active, role, name, type] = line.split("\t");
      return {
        id: id!,
        index: parseInt(index!, 10),
        title: title!,
        currentCommand: cmd!,
        width: parseInt(width!, 10),
        height: parseInt(height!, 10),
        active: active === "1",
        role: (role || null) as PaneInfo["role"],
        name: name || null,
        type: type || null,
      };
    });
}

export function findPaneByTitle(session: string, title: string): string | null {
  const panes = listSessionPanes(session);
  const match = panes.find((p) => p.title === title);
  return match?.id ?? null;
}

export function findPaneByPattern(session: string, pattern: string): string | null {
  const panes = listSessionPanes(session);
  const lower = pattern.toLowerCase();
  const match = panes.find((p) => p.title.toLowerCase().includes(lower));
  return match?.id ?? null;
}

export function findAdjacentPane(session: string, currentPaneId: string): string | null {
  const panes = listSessionPanes(session);
  const currentIdx = panes.findIndex((p) => p.id === currentPaneId);
  if (currentIdx === -1 || panes.length < 2) return null;
  const nextIdx = (currentIdx + 1) % panes.length;
  return panes[nextIdx]!.id;
}

const BUSY_COMMANDS = new Set([
  "claude",
  "codex",
  "vim",
  "nvim",
  "vi",
  "nano",
  "emacs",
  "less",
  "more",
  "top",
  "htop",
  "man",
]);

const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish"]);

export type PaneBusyStatus = "idle" | "busy" | "agent";

export function isPaneBusy(session: string, paneId: string): boolean {
  const panes = listSessionPanes(session);
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return true;
  const cmd = pane.currentCommand.toLowerCase();
  if (SHELL_COMMANDS.has(cmd)) return false;
  if (BUSY_COMMANDS.has(cmd)) return true;
  return true; // unknown command — assume busy
}

export function getPaneBusyStatus(session: string, paneId: string): PaneBusyStatus {
  const panes = listSessionPanes(session);
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return "busy";
  const cmd = pane.currentCommand.toLowerCase();
  if (cmd === "claude" || cmd === "codex") return "agent";
  if (SHELL_COMMANDS.has(cmd)) return "idle";
  return "busy";
}

export function sendText(session: string, paneId: string, text: string): void {
  tmux("send-keys", "-t", paneId, "-l", "--", text);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sendCommand(session: string, paneId: string, command: string): boolean {
  const status = getPaneBusyStatus(session, paneId);
  try {
    tmux("send-keys", "-t", paneId, "-l", "--", command);
  } catch {
    return false;
  }
  if (status === "agent") {
    // Claude Code shows a [Pasted text] preview for long input (roughly >200 chars).
    // Short commands land directly in the prompt — just need a brief delay for the
    // TUI to register the input. Long commands trigger the paste preview which needs
    // two Enters: one to confirm the preview, one to submit the prompt.
    if (command.length < 200) {
      sleepMs(150);
    } else {
      sleepMs(5000);
      tmux("send-keys", "-t", paneId, "Enter");
      sleepMs(2000);
    }
    tmux("send-keys", "-t", paneId, "Enter");
    return true;
  }
  tmux("send-keys", "-t", paneId, "Enter");
  return true;
}

export function openFileInEditor(session: string, paneId: string, filePath: string): void {
  const editor = process.env.EDITOR ?? "vim";
  sendCommand(session, paneId, `${editor} ${filePath}`);
}

export interface TargetOptions {
  title?: string;
  titlePattern?: string;
  paneId?: string;
  selfPaneId?: string;
}

export function resolveTarget(session: string, opts: TargetOptions): string | null {
  if (opts.paneId) return opts.paneId;
  if (opts.title) return findPaneByTitle(session, opts.title);
  if (opts.titlePattern) return findPaneByPattern(session, opts.titlePattern);
  if (opts.selfPaneId) return findAdjacentPane(session, opts.selfPaneId);
  return null;
}
