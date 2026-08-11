import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TUI_READY_FILE_ENV = "TMUX_IDE_TUI_READY_FILE";

export interface TuiReadyRecord {
  version: 1;
  phase: "input-ready";
  surface: string;
  pid: number;
  at: string;
}

export interface PublishTuiReadyOptions {
  path?: string;
  pid?: number;
  now?: Date;
}

/**
 * Publish the point at which a TUI surface can accept lifecycle input.
 *
 * A painted frame is not an input-readiness barrier: Solid installs OpenTUI
 * keyboard owners from `onMount`, and a fast host can observe the first paint
 * before those callbacks have run. Launchers that need to drive a surface may
 * opt into this atomic file handshake instead of racing visible text.
 */
export function publishTuiInputReady(
  surface: string,
  options: PublishTuiReadyOptions = {},
): TuiReadyRecord | null {
  const path = options.path ?? process.env[TUI_READY_FILE_ENV];
  if (!path) return null;

  const record: TuiReadyRecord = {
    version: 1,
    phase: "input-ready",
    surface,
    pid: options.pid ?? process.pid,
    at: (options.now ?? new Date()).toISOString(),
  };
  const temporaryPath = `${path}.${record.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
    return record;
  } catch {
    rmSync(temporaryPath, { force: true });
    return null;
  }
}
