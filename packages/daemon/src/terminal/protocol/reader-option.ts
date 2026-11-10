import { basename, isAbsolute } from "node:path";
import { hasControlCharacter } from "@tmux-ide/contracts";

export interface ReaderOption {
  /** The file name shown in the pane header. */
  name: string;
  /** Absolute real path; daemon-only, never sent to clients. */
  path: string;
  /** The reader process: the pane's own process. */
  pid: number;
}

const MARKDOWN = /\.(?:md|markdown)$/iu;

export function isMarkdownPath(path: string): boolean {
  const name = basename(path);
  return MARKDOWN.test(name) && !/^\.(?:md|markdown)$/iu.test(name);
}

/**
 * Parse `@tmux_ide_reader`: `{"version":1,"pid":N,"path":"/abs/notes.md"}`.
 * A reader exists only while the process that set the option is alive, and
 * only on the pane whose own process it is: `panePid` is that pane's
 * `#{pane_pid}`. The CLI starts `tmux-ide show` with tmux's direct exec (no
 * shell), so the pane's process is the reader itself and records exactly that
 * pid. Equality rather than "a descendant of" needs no process-tree walk.
 *
 * What the tie rules out: an option left behind by a reader that has exited,
 * and a later process that happens to reuse its pid. What it does not: the
 * option is not proof that `tmux-ide show` set it. In a shell pane the shell
 * is the pane's process, so the shell can set an option naming its own pid,
 * and any process that can talk to the tmux server can read another pane's
 * pid and set that pane's option. Both are the same user, who can already
 * read the file; the reader grants no access they do not have.
 */
export function readerOption(
  value: string,
  panePid: string,
  alive = processAlive,
): ReaderOption | null {
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
  if (!/^[1-9][0-9]*$/u.test(panePid) || String(pid) !== panePid) return null;
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
  return { name, path, pid };
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
