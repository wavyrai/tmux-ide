import { execFile } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

import { tuiPerfMark } from "./application-performance-log.ts";

import { osc52Sequence } from "../selection.ts";

export interface OpenTuiHostLocalTmuxAdapter {
  readonly hosted: boolean;
  configureClipboard(): Promise<boolean>;
  copyText(text: string): boolean | Promise<boolean>;
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

type ClipboardBackend = "native-macos" | "osc52";
type ClipboardOutcome =
  | "submitted"
  | "copied"
  | "spawn-failed"
  | "timeout"
  | "stdin-failed"
  | "stdin-unavailable"
  | "exit-failed"
  | "policy-failed"
  | "policy-not-ready"
  | "invalid-length"
  | "write-failed"
  | "transport-written";
type ClipboardDiagnostic = (backend: ClipboardBackend, outcome: ClipboardOutcome) => void;
function clipboardDiagnostic(backend: ClipboardBackend, outcome: ClipboardOutcome): void {
  try {
    tuiPerfMark("terminal-clipboard", { backend, outcome });
  } catch {
    /* Diagnostics never own copying. */
  }
}

/** Native clipboard writes resolve only after the helper has exited successfully. */
export function writeMacClipboard(
  text: string,
  launch: typeof execFile = execFile,
  diagnose: ClipboardDiagnostic = clipboardDiagnostic,
): Promise<boolean> {
  return new Promise((resolve) => {
    let inputFailed = false;
    let settled = false;
    const finish = (outcome: ClipboardOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        diagnose("native-macos", outcome);
      } catch {
        /* Best effort only. */
      }
      resolve(outcome === "copied");
    };
    try {
      const child = launch(
        "/usr/bin/pbcopy",
        [],
        { timeout: 1_500, killSignal: "SIGKILL", maxBuffer: 4_096 },
        (error) => {
          if (inputFailed) finish("stdin-failed");
          else if (!error) finish("copied");
          else if (error.killed && error.signal === "SIGKILL") finish("timeout");
          else if (typeof error.code === "string") finish("spawn-failed");
          else finish("exit-failed");
        },
      );
      if (!child.stdin) {
        finish("stdin-unavailable");
        child.kill();
        return;
      }
      child.stdin.on("error", () => {
        inputFailed = true;
        child.kill();
      });
      try {
        child.stdin.end(text, "utf8");
      } catch {
        finish("stdin-failed");
        child.kill();
      }
    } catch {
      finish("spawn-failed");
    }
  });
}

/**
 * The only direct tmux capability retained by the OpenTUI renderer.
 *
 * Workspace/session/window/pane and hosted-client lifecycle mutation belongs
 * outside the shared renderer. This adapter retains only tmux's clipboard
 * passthrough policy and local clipboard submission. Local macOS uses pbcopy;
 * remote/non-macOS hosts receive OSC52 through the controlling TTY.
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
  inTmux = Boolean(process.env.TMUX),
  // Host routing choice: force terminal clipboard transport even on local macOS.
  nativeCopy: ((text: string) => Promise<boolean>) | null = process.platform === "darwin" &&
  process.env.TMUX_IDE_CLIPBOARD_BACKEND !== "osc52" &&
  !process.env.SSH_CONNECTION &&
  !process.env.SSH_TTY
    ? writeMacClipboard
    : null,
): OpenTuiHostLocalTmuxAdapter {
  // Direct terminals need no tmux policy. Root intentionally skips that
  // readiness step outside tmux, so clipboard writes must already be available.
  let clipboardConfigured = !inTmux;
  let nativeCopyActive = false;
  let pendingNativeCopy: { text: string; resolve: (copied: boolean) => void } | null = null;
  const submitNativeCopy = (text: string, resolve: (copied: boolean) => void): void => {
    nativeCopyActive = true;
    void Promise.resolve()
      .then(() => nativeCopy!(text))
      .catch(() => false)
      .then((copied) => {
        resolve(copied);
        const next = pendingNativeCopy;
        pendingNativeCopy = null;
        if (next) submitNativeCopy(next.text, next.resolve);
        else nativeCopyActive = false;
      });
  };
  let clipboardConfiguration: Promise<boolean> | null = null;
  return {
    hosted,
    configureClipboard() {
      if (!inTmux || nativeCopy) return Promise.resolve(true);
      clipboardConfiguration ??= Promise.all([
        boundedClipboardPolicyRun(run, ["set-option", "-gq", "set-clipboard", "on"]),
        boundedClipboardPolicyRun(run, ["set-option", "-gq", "allow-passthrough", "on"]),
      ]).then(
        () => (clipboardConfigured = true),
        () => {
          clipboardDiagnostic("osc52", "policy-failed");
          return false;
        },
      );
      return clipboardConfiguration;
    },
    copyText(text) {
      const bytes = Buffer.byteLength(text, "utf8");
      const backend = nativeCopy ? "native-macos" : "osc52";
      if (bytes < 1 || bytes > 1_000_000) {
        clipboardDiagnostic(backend, "invalid-length");
        return false;
      }
      clipboardDiagnostic(backend, "submitted");
      if (nativeCopy) {
        // Serialize writes, keeping only the newest pending request (at most 1 MB).
        return new Promise<boolean>((resolve) => {
          if (nativeCopyActive) {
            pendingNativeCopy?.resolve(false);
            pendingNativeCopy = { text, resolve };
          } else submitNativeCopy(text, resolve);
        });
      }
      if (!clipboardConfigured) {
        clipboardDiagnostic("osc52", "policy-not-ready");
        return false;
      }
      try {
        const copied = writeClipboard(osc52Sequence(Buffer.from(text, "utf8").toString("base64")));
        clipboardDiagnostic("osc52", copied ? "transport-written" : "write-failed");
        return copied;
      } catch {
        clipboardDiagnostic("osc52", "write-failed");
        return false;
      }
    },
  };
}
