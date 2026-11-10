import { basename, isAbsolute } from "node:path";
import { hasControlCharacter } from "@tmux-ide/contracts";

export interface ReaderOption {
  /** The file name shown in the pane header. */
  name: string;
  /** Absolute real path; daemon-only, never sent to clients. */
  path: string;
}

const MARKDOWN = /\.(?:md|markdown)$/iu;

export function isMarkdownPath(path: string): boolean {
  const name = basename(path);
  return MARKDOWN.test(name) && !/^\.(?:md|markdown)$/iu.test(name);
}

/**
 * Parse `@tmux_ide_reader`: `{"version":1,"pid":N,"path":"/abs/notes.md"}`.
 * A reader exists only while the process that set the option is alive.
 */
export function readerOption(value: string, alive = processAlive): ReaderOption | null {
  if (!value || value.length > 8192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "path,pid,version") return null;
  const { version, pid, path } = record;
  if (version !== 1 || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    return null;
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    !isAbsolute(path) ||
    hasControlCharacter(path) ||
    !isMarkdownPath(path)
  )
    return null;
  const name = basename(path);
  if (name.length > 255) return null;
  if (!alive(pid)) return null;
  return { name, path };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Including EPERM: a pid now owned by another user is not our reader.
    return false;
  }
}
