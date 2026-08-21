import { execFile } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

import { osc52Sequence } from "../selection.ts";

export interface OpenTuiHostLocalTmuxAdapter {
  configureClipboard(): Promise<boolean>;
  copyText(text: string): boolean;
  putAway(): Promise<void>;
}

function runTmux(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", [...args], { timeout: 1_500 }, (error) => (error ? reject(error) : resolve()));
  });
}

async function boundedClipboardPolicyRun(
  run: (args: readonly string[]) => Promise<void>,
  args: readonly string[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      run(args),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("clipboard policy timed out")), 1_500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function writeAllSync(
  fd: number,
  bytes: Uint8Array,
  write: typeof writeSync = writeSync,
): boolean {
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const written = write(fd, bytes, offset, bytes.byteLength - offset);
      if (!Number.isSafeInteger(written) || written < 1) return false;
      offset += written;
    }
    return true;
  } catch {
    return false;
  }
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
  run = runTmux,
  writeClipboard: (sequence: string) => boolean = (sequence) => {
    let fd: number | null = null;
    try {
      fd = openSync("/dev/tty", "w");
      return writeAllSync(fd, Buffer.from(sequence));
    } catch {
      return false;
    } finally {
      if (fd !== null)
        try {
          closeSync(fd);
        } catch {
          // The copy result already reflects the write; close is best effort.
        }
    }
  },
): OpenTuiHostLocalTmuxAdapter {
  let clipboardConfigured = false;
  let clipboardConfiguration: Promise<boolean> | null = null;
  return {
    configureClipboard() {
      clipboardConfiguration ??= Promise.all([
        boundedClipboardPolicyRun(run, ["set-option", "-gq", "set-clipboard", "on"]),
        boundedClipboardPolicyRun(run, ["set-option", "-gq", "allow-passthrough", "on"]),
      ]).then(
        () => (clipboardConfigured = true),
        () => false,
      );
      return clipboardConfiguration;
    },
    copyText(text) {
      if (!clipboardConfigured) return false;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes < 1 || bytes > 1_000_000) return false;
      try {
        return writeClipboard(osc52Sequence(Buffer.from(text, "utf8").toString("base64")));
      } catch {
        return false;
      }
    },
    async putAway() {
      if (!hosted) return;
      try {
        await run(["switch-client", "-l"]);
      } catch {
        await run(["detach-client"]);
      }
    },
  };
}
