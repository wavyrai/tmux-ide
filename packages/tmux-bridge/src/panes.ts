import { runTmux } from "./runner.ts";

export interface TmuxPaneInfo {
  index: number;
  title: string | undefined;
  width: number;
  height: number;
  active: boolean;
}

export function listPanes(session: string): TmuxPaneInfo[] {
  const raw = (
    runTmux(
      [
        "list-panes",
        "-t",
        session,
        "-F",
        "#{pane_index}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}",
      ],
      { encoding: "utf-8" },
    ) as string
  ).trim();

  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [index, title, width, height, active] = line.split("|");
    return {
      index: Number.parseInt(index!, 10),
      title,
      width: Number.parseInt(width!, 10),
      height: Number.parseInt(height!, 10),
      active: active === "1",
    };
  });
}

export function splitPane(
  targetPane: string,
  direction: string,
  cwd: string,
  percent: number,
): string {
  return (
    runTmux(
      [
        "split-window",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        targetPane,
        direction === "vertical" ? "-v" : "-h",
        "-c",
        cwd,
        "-p",
        String(percent),
      ],
      { encoding: "utf-8" },
    ) as string
  ).trim();
}

export function sendLiteral(targetPane: string, text: string): void {
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
}

export interface SendKeysOptions {
  /** Append an Enter keystroke after the literal text. Defaults to true. */
  enter?: boolean;
}

/**
 * Send literal text to a pane. When `enter` is false, the text is delivered
 * without a trailing Enter — useful for staging input for the user.
 */
export function sendKeys(
  targetPane: string,
  text: string,
  options: SendKeysOptions = {},
): void {
  const { enter = true } = options;
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  if (enter) {
    runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
  }
}

export interface CapturePaneOptions {
  /** Number of lines from the bottom of the buffer to include. */
  lines?: number;
  /** Capture from `scrollback` lines back to the bottom of the buffer. */
  scrollback?: number;
}

/**
 * Capture the visible/scrollback content of a tmux pane.
 *
 * - `lines: N` returns the last N lines (uses `-S -N`).
 * - `scrollback: N` returns N scrollback lines back to the bottom.
 * - With no options, captures only the visible viewport.
 */
export function capturePane(
  targetPane: string,
  options: CapturePaneOptions = {},
): string {
  const args = ["capture-pane", "-t", targetPane, "-p", "-J"];
  if (typeof options.scrollback === "number") {
    args.push("-S", `-${options.scrollback}`);
  } else if (typeof options.lines === "number") {
    args.push("-S", `-${options.lines}`);
  }
  return (runTmux(args, { encoding: "utf-8" }) as string).replace(/\n+$/, "");
}

/**
 * Capture the most-recent `lines` of a pane (defaults to 50).
 */
export function captureRecent(targetPane: string, lines = 50): string {
  return capturePane(targetPane, { lines });
}

export function getPaneCurrentCommand(targetPane: string): string {
  return (
    runTmux(
      ["display-message", "-p", "-t", targetPane, "#{pane_current_command}"],
      { encoding: "utf-8" },
    ) as string
  ).trim();
}

export function selectPane(targetPane: string): void {
  runTmux(["select-pane", "-t", targetPane], { stdio: "inherit" });
}

export function setPaneTitle(targetPane: string, title: string): void {
  runTmux(["select-pane", "-t", targetPane, "-T", title], { stdio: "inherit" });
}

export function setPaneOption(
  targetPane: string,
  option: string,
  value: string,
): void {
  runTmux(["set-option", "-pqt", targetPane, option, value]);
}
