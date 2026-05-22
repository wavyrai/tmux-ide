/**
 * Records tmux pane output in asciicast v2 format.
 *
 * Uses `tmux capture-pane -p -t <paneId>` to snapshot pane content and
 * emits only the delta between snapshots as asciicast event lines.
 *
 * File format (one JSON object per line):
 *   Line 1 (header): {"version":2,"width":W,"height":H,"timestamp":T}
 *   Line 2+:         [elapsed_seconds, "o", "data"]
 *
 * @see https://docs.asciinema.org/manual/asciicast/v2/
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RecorderOptions {
  /** Project directory (recordings go in .tasks/recordings/). */
  dir: string;
  /** tmux session name. */
  session: string;
  /** tmux pane ID (e.g. %0). */
  paneId: string;
  /** Capture interval in ms (default 1000). */
  intervalMs?: number;
}

export class AsciicastRecorder {
  private filePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;
  private lastSnapshot: string = "";
  private session: string;
  private paneId: string;
  private intervalMs: number;

  constructor(opts: RecorderOptions) {
    this.session = opts.session;
    this.paneId = opts.paneId;
    this.intervalMs = opts.intervalMs ?? 1000;

    const recDir = join(opts.dir, ".tasks", "recordings");
    if (!existsSync(recDir)) mkdirSync(recDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safePane = this.paneId.replace(/%/g, "");
    this.filePath = join(recDir, `${this.session}_${safePane}_${ts}.cast`);
  }

  /** Start recording. Writes the header and begins periodic captures. */
  start(): string {
    const { width, height } = this.getPaneSize();
    this.startTime = Date.now();

    const header = {
      version: 2,
      width,
      height,
      timestamp: Math.floor(this.startTime / 1000),
    };
    writeFileSync(this.filePath, JSON.stringify(header) + "\n");
    this.lastSnapshot = "";

    this.timer = setInterval(() => this.capture(), this.intervalMs);
    this.capture(); // immediate first capture

    return this.filePath;
  }

  /** Stop recording and flush. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final capture
    this.capture();
  }

  /** Path to the recording file. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Single capture tick — computes delta and appends event. */
  private capture(): void {
    try {
      const current = execFileSync("tmux", ["capture-pane", "-p", "-t", this.paneId], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      if (current === this.lastSnapshot) return; // no change

      const elapsed = (Date.now() - this.startTime) / 1000;
      const delta = this.computeDelta(this.lastSnapshot, current);
      this.lastSnapshot = current;

      if (delta.length === 0) return;

      const event = JSON.stringify([elapsed, "o", delta]);
      appendFileSync(this.filePath, event + "\n");
    } catch {
      // pane gone or tmux not available — stop silently
    }
  }

  /** Compute the new/changed content between two snapshots. */
  private computeDelta(prev: string, current: string): string {
    if (prev === "") return current;

    const prevLines = prev.split("\n");
    const curLines = current.split("\n");

    // Find first differing line
    let firstDiff = 0;
    while (
      firstDiff < prevLines.length &&
      firstDiff < curLines.length &&
      prevLines[firstDiff] === curLines[firstDiff]
    ) {
      firstDiff++;
    }

    if (firstDiff >= curLines.length) return "";

    // Return the changed portion with ANSI cursor positioning
    const changedLines = curLines.slice(firstDiff);
    const moveToLine = `\x1b[${firstDiff + 1};1H`;
    return moveToLine + changedLines.join("\n");
  }

  /** Get pane dimensions from tmux. */
  private getPaneSize(): { width: number; height: number } {
    try {
      const raw = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", this.paneId, "#{pane_width}\t#{pane_height}"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const [w, h] = raw.split("\t");
      return { width: parseInt(w!, 10) || 80, height: parseInt(h!, 10) || 24 };
    } catch {
      return { width: 80, height: 24 };
    }
  }
}
