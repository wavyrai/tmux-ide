import { execSync } from "node:child_process";

type ListSessionsFn = () => string;

let _listSessions: ListSessionsFn = () =>
  execSync('tmux list-sessions -F "#{session_name}"', {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** @internal Replace the session lister for testing. Returns a restore function. */
export function _setListSessions(fn: ListSessionsFn): () => void {
  const prev = _listSessions;
  _listSessions = fn;
  return () => {
    _listSessions = prev;
  };
}

/**
 * List all running tmux sessions whose name matches `baseName` exactly
 * or follows the `baseName-N` pattern (where N is a positive integer).
 */
export function listInstances(baseName: string): string[] {
  let raw: string;
  try {
    raw = _listSessions();
  } catch {
    return [];
  }

  if (!raw) return [];

  const pattern = new RegExp(`^${escapeRegExp(baseName)}(-\\d+)?$`);
  return raw
    .split("\n")
    .filter((name) => pattern.test(name))
    .sort((a, b) => instanceIndex(a, baseName) - instanceIndex(b, baseName));
}

/**
 * Compute the next available instance name for a base session name.
 * Scans existing sessions matching `baseName-N` and returns `baseName-{max+1}`.
 */
export function nextInstanceName(baseName: string): string {
  const instances = listInstances(baseName);
  let maxIndex = 0;

  for (const name of instances) {
    const match = name.match(new RegExp(`^${escapeRegExp(baseName)}-(\\d+)$`));
    if (match) {
      maxIndex = Math.max(maxIndex, parseInt(match[1]!, 10));
    }
  }

  return `${baseName}-${maxIndex + 1}`;
}

function instanceIndex(name: string, baseName: string): number {
  if (name === baseName) return -1;
  const match = name.match(new RegExp(`^${escapeRegExp(baseName)}-(\\d+)$`));
  return match ? parseInt(match[1]!, 10) : -1;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
