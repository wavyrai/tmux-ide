/**
 * Process-tree resolution for the snapshot-scraping fallback.
 *
 * A tmux pane's `pane_current_command` is only its IMMEDIATE child process —
 * for a real agent that is usually `node`/`bun`/`sh`, never `claude`/`codex`.
 * So the detection manifests picked purely by `pane_current_command` almost
 * never match in practice. To fix that we walk the pane's process TREE and
 * resolve what is actually running underneath it.
 *
 * Everything here is pure except the thin `readProcessTable` io wrapper, and
 * nothing ever throws — a missing/garbled `ps` simply yields no matches, and
 * resolution falls back to the fast `pane_current_command` path.
 */
import { execFileSync } from "node:child_process";
import { pickManifest, type AgentManifest } from "./manifest.ts";
import { BUNDLED_MANIFESTS } from "./manifests.ts";

/** One row of the process table. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  /** Full command line (argv joined), as `ps` printed it. */
  command: string;
}

/**
 * Parse `ps -axo pid=,ppid=,command=` output. Each line is
 * `<pid> <ppid> <command line…>` with leading padding on the numeric columns.
 * Malformed lines are skipped; never throws.
 */
export function parsePsOutput(raw: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/^\s+/, "");
    if (trimmed.length === 0) continue;
    // pid, ppid, then the rest is the command line (which may contain spaces).
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] ?? "";
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || command.length === 0) continue;
    entries.push({ pid, ppid, command });
  }
  return entries;
}

/**
 * Collect the command lines in the subtree rooted at `rootPid`, INCLUDING the
 * root process itself. Deeper (more specific) processes come FIRST — a DFS that
 * emits children before their parent — so the most-specific agent command is
 * seen before the generic `node`/`bun`/`sh` shims above it. Cycles and runaway
 * depth are guarded.
 */
export function subtreeCommands(entries: ProcEntry[], rootPid: number, maxDepth = 6): string[] {
  const childrenByParent = new Map<number, ProcEntry[]>();
  const byPid = new Map<number, ProcEntry>();
  for (const entry of entries) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.ppid, siblings);
  }

  const root = byPid.get(rootPid);
  if (!root) return [];

  const commands: string[] = [];
  const visited = new Set<number>();

  const walk = (pid: number, depth: number): void => {
    if (depth > maxDepth || visited.has(pid)) return;
    visited.add(pid);
    // Emit children first (deepest → shallowest) so the root lands last.
    for (const child of childrenByParent.get(pid) ?? []) {
      walk(child.pid, depth + 1);
    }
    const self = byPid.get(pid);
    if (self) commands.push(self.command);
  };

  walk(rootPid, 0);
  return commands;
}

/**
 * Read the live process table. Thin io wrapper — on any failure returns `[]`
 * so callers degrade to the fast path rather than throwing.
 */
export function readProcessTable(): ProcEntry[] {
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return parsePsOutput(raw);
  } catch {
    return [];
  }
}

/**
 * Extract the candidate tokens a command line should be matched against.
 *
 * Full argv strings can incidentally contain an agent name (a path like
 * `/Users/x/.claude/notes.md`, or `vim ~/.codex/todo`), which would produce a
 * false positive if we ran `pickManifest` over the raw string. Instead we test
 * only the meaningful executable-ish tokens: the basename of argv[0] and the
 * basename of the second token (a script/subcommand path). Query strings and
 * flags are ignored.
 *
 * e.g. `node /Users/x/.nvm/versions/node/v20/bin/claude --foo` → ["node", "claude"]
 *      `vim /Users/x/.claude/notes.md`                          → ["vim", "notes.md"]
 */
export function commandTokens(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const argv0 = parts[0];
  if (argv0) tokens.push(basename(argv0));
  const argv1 = parts[1];
  // Only treat the second token as a script path when it is not a flag.
  if (argv1 && !argv1.startsWith("-")) tokens.push(basename(argv1));
  return tokens;
}

/** Path basename without the node:path import — splits on `/` and takes the tail. */
function basename(pathLike: string): string {
  const segments = pathLike.split("/");
  return segments[segments.length - 1] ?? pathLike;
}

/**
 * Resolve which agent manifest is actually running in a pane.
 *
 * 1. Fast path: `pane_current_command` may already BE the agent (e.g. `claude`
 *    via a shim). Try `pickManifest(paneCmd)` directly.
 * 2. Tree path: otherwise walk the pane's process subtree and match extracted
 *    tokens against the manifests. Token extraction avoids the incidental-path
 *    false positives described above.
 *
 * The tree walk prefers the highest-PRIORITY manifest (its index in
 * `manifests`, which is preference-ordered: claude, codex, then the `shell`
 * catch-all) over merely the deepest match — an agent that has spawned a
 * transient shell child (a Bash tool call) must still resolve to the agent, not
 * to `shell`. Depth (deepest first) only breaks ties within the same manifest.
 *
 * `matchedCommand` is the token/command that produced the hit — retained for a
 * future `agent explain`. Returns an undefined manifest when nothing matches.
 */
export function resolveAgentCommand(
  paneCmd: string,
  panePid: number,
  table: ProcEntry[],
  manifests: AgentManifest[] = BUNDLED_MANIFESTS,
): { manifest: AgentManifest | undefined; matchedCommand: string } {
  const fast = pickManifest(paneCmd, manifests);
  if (fast) return { manifest: fast, matchedCommand: paneCmd };

  let best: { manifest: AgentManifest; matchedCommand: string; rank: number } | undefined;
  for (const command of subtreeCommands(table, panePid)) {
    for (const token of commandTokens(command)) {
      const hit = pickManifest(token, manifests);
      if (!hit) continue;
      const rank = manifests.indexOf(hit);
      // Keep the first (deepest) match at a given rank; only replace when a
      // strictly higher-priority manifest turns up.
      if (!best || rank < best.rank) best = { manifest: hit, matchedCommand: token, rank };
      if (best.rank === 0) return { manifest: best.manifest, matchedCommand: best.matchedCommand };
    }
  }

  return best
    ? { manifest: best.manifest, matchedCommand: best.matchedCommand }
    : { manifest: undefined, matchedCommand: "" };
}
