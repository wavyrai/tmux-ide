/**
 * Agent session-id capture — stamping `@agent_session_id` for agents whose
 * CLIs don't announce their session id the way Claude Code's hooks do.
 *
 * WHY: `tmux-ide restore --resume-agents` revives a pane's conversation via its
 * kind's verified resume invocation ({@link ../../restore.ts AGENT_RESUME_COMMANDS}),
 * keyed on the pane-local `@agent_session_id` option. Claude's integration
 * records it from lifecycle hooks; opencode's integration records it from a
 * plugin. codex and cursor-agent expose NO hook surface, but both keep their
 * session's identity ON DISK in a deterministic place — the exact layout their
 * own `resume` pickers read. This module probes that, per pane, and stamps the
 * option so restore needs no changes.
 *
 * Per-kind mechanism (verdicts investigated 2026-07, versions noted):
 *
 *  - `codex` (codex-cli 0.144.1, VERIFIED LIVE): every session appends to
 *    `~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl`; the uuid in
 *    the filename IS the id `codex resume <id>` accepts (verified end-to-end:
 *    quit + `codex resume <uuid>` revived the conversation). Two probes:
 *      1. OPEN FILES (exact): the codex process holds its rollout file open for
 *         write for the whole session — including across a resume, which
 *         re-opens the SAME file (verified via lsof, fd `34w`). Pane pid →
 *         process subtree → codex pid(s) → open files → rollout filename.
 *      2. STATE DIR (fallback, when lsof/procfs is unavailable): newest rollout
 *         whose filename timestamp is at/after the agent process start and whose
 *         first-line `session_meta` records `cwd` == the pane's cwd. Subagent
 *         threads (`payload.source.subagent` / `thread_source: "subagent"`) are
 *         skipped — they live in the same dir with the same cwd.
 *    The rollout file only exists after the FIRST turn (verified: a fresh TUI
 *    writes nothing until a message is sent), so capture keeps retrying until
 *    the session materializes.
 *
 *  - `cursor` (cursor-agent 2026.04.30): chats live at
 *    `~/.cursor/chats/<md5-hex-of-cwd>/<chatId>/store.db` — the md5(cwd) dir
 *    naming is VERIFIED against a real state dir, and this layout is what
 *    `cursor-agent --resume [chatId]` / `cursor-agent ls` themselves read. Same
 *    two probes: open `store.db` handles first (sqlite stays open), else the
 *    newest chat dir under md5(pane cwd) modified at/after the agent process
 *    start. A live working session could not be driven on this machine (the CLI
 *    sat on its pre-auth login screen — same limitation the detection manifest
 *    notes), so the cursor probes are exercised against fixtures shaped from
 *    the real on-disk layout.
 *
 *  - `claude` / `opencode`: captured by their integrations (hooks / plugin) —
 *    deliberately NOT probed here; an integration-stamped id always wins
 *    because capture only ever fills EMPTY stamps.
 *
 *  - `copilot`: SKIPPED (documented, revisit with a real install). Two known
 *    surfaces, neither shippable blind: (1) Copilot CLI has Claude-style
 *    lifecycle hooks (docs.github.com/en/copilot/reference/hooks-configuration)
 *    whose payloads carry the session id + cwd — the RIGHT future path, an
 *    `integration install copilot` — but the payload key casing is known to
 *    flip (sessionId vs session_id) and the hooks-config schema couldn't be
 *    verified against a real install (the CLI isn't installed here); a wrong
 *    hook config risks breaking the user's copilot startup. (2) Disk probing
 *    `~/.copilot/session-state/<uuid>/workspace.yaml` (id/cwd/created_at) is
 *    viable in principle but the field shape is confirmed only by secondary
 *    sources, `--resume` currently spawns phantom EMPTY session dirs
 *    (github/copilot-cli#3908) that break newest-dir heuristics, and the
 *    legacy `history-session-state/` rename shows the layout still moves.
 *
 *  - `gemini` / `aider` / `goose` / `amp`: SKIPPED — no verified native resume
 *    invocation in {@link ../../restore.ts AGENT_RESUME_COMMANDS}, so a
 *    captured id would have nothing to feed.
 *
 * Shape: pure probe logic + a stateful, throttled capturer the chrome updater
 * pulses each tick; all io (ps/lsof/procfs/fs) is injectable so every decision
 * path is unit-tested against fixtures.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readProcessTable, subtreeEntries, commandTokens, type ProcEntry } from "./process-tree.ts";

// ---------------------------------------------------------------------------
// Pure — id extraction from open-file paths
// ---------------------------------------------------------------------------

/** Same trust gate restore applies: uuid-ish only, nothing shell-active. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** `…/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` → the uuid (codex's resume key). */
const CODEX_ROLLOUT_RE =
  /\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$/;

/** `…/.cursor/chats/<md5(cwd)>/<chatId>/store.db` → the chatId (cursor's resume key). */
const CURSOR_STORE_RE = /\/\.cursor\/chats\/[0-9a-f]{32}\/([A-Za-z0-9-]+)\/store\.db$/;

/** PURE — codex session id from a process's open-file paths, or null. */
export function codexIdFromOpenFiles(paths: string[]): string | null {
  for (const path of paths) {
    const match = CODEX_ROLLOUT_RE.exec(path);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** PURE — cursor chat id from a process's open-file paths, or null. */
export function cursorIdFromOpenFiles(paths: string[]): string | null {
  for (const path of paths) {
    const match = CURSOR_STORE_RE.exec(path);
    if (match?.[1] && SAFE_SESSION_ID.test(match[1])) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure — process helpers
// ---------------------------------------------------------------------------

/**
 * PURE — parse `ps -o etime=` output (`[[dd-]hh:]mm:ss`) into seconds, or null
 * for anything malformed. The etime format is the portable way to recover a
 * process's start time (start ≈ now − etime) without locale-dependent `lstart`
 * parsing.
 */
export function parseEtimeSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (minutes >= 60 || seconds >= 60 || (match[2] !== undefined && hours >= 24)) return null;
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * PURE — the pids under `panePid` whose command tokens include one of the
 * kind's binary names (e.g. codex's `node` shim AND its vendor binary both
 * carry the `codex` token). These are the candidates worth an open-files look.
 */
export function agentPidsInSubtree(table: ProcEntry[], panePid: number, bins: string[]): number[] {
  const wanted = new Set(bins);
  const pids: number[] = [];
  for (const entry of subtreeEntries(table, panePid)) {
    if (commandTokens(entry.command).some((token) => wanted.has(token))) pids.push(entry.pid);
  }
  return pids;
}

// ---------------------------------------------------------------------------
// Pure — state-dir fallback probes (injectable fs)
// ---------------------------------------------------------------------------

/** The minimal fs surface the state-dir probes need — injectable for fixtures. */
export interface StateDirIo {
  /** Directory entry NAMES (not paths); [] when missing/unreadable. */
  listDir: (path: string) => string[];
  /** mtime in ms, or null when missing. */
  mtimeMs: (path: string) => number | null;
  /** First line of a file (utf8), or null. */
  readFirstLine: (path: string) => string | null;
}

/** Slack applied before the process start when comparing session timestamps —
 *  covers clock/etime rounding, not ambiguity (a session can't predate its CLI). */
const START_SLACK_MS = 120_000;

/** How many day-directories back the codex fallback scans (start-date → today,
 *  capped) — a resumable pane's session started while its process was alive. */
const MAX_SCAN_DAYS = 7;

/** `rollout-2026-07-12T12-16-13-<uuid>.jsonl` → { tsMs (LOCAL time), id } | null. */
export function parseCodexRolloutName(name: string): { tsMs: number; id: string } | null {
  const match =
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$/.exec(
      name,
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, id] = match;
  // The filename timestamp is LOCAL time (verified: a 14:50Z session wrote
  // rollout-…T16-50-38 under CEST) — construct via local Date components.
  const tsMs = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isFinite(tsMs) && id ? { tsMs, id } : null;
}

/** A parsed codex `session_meta` first line — only the fields the probe reads. */
interface CodexSessionMeta {
  cwd?: string;
  source?: unknown;
  thread_source?: string;
}

/** PURE-ish (io-injected) — codex fallback: newest non-subagent rollout under
 *  `root` started at/after `startMs` whose recorded cwd matches the pane's. */
export function codexIdFromStateDir(
  root: string,
  paneCwd: string,
  startMs: number,
  io: StateDirIo,
  nowMs: number = Date.now(),
): string | null {
  const cutoff = startMs - START_SLACK_MS;
  // Enumerate day dirs from the start date to today (session files are laid out
  // by LOCAL date, matching the filename timestamps).
  const candidates: Array<{ tsMs: number; path: string; id: string }> = [];
  for (let offset = 0; offset <= MAX_SCAN_DAYS; offset++) {
    const day = new Date(nowMs - offset * 86_400_000);
    if (day.getTime() < cutoff - 86_400_000) break;
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    for (const name of io.listDir(dir)) {
      const parsed = parseCodexRolloutName(name);
      if (parsed && parsed.tsMs >= cutoff && parsed.tsMs <= nowMs + START_SLACK_MS) {
        candidates.push({ tsMs: parsed.tsMs, path: join(dir, name), id: parsed.id });
      }
    }
  }
  candidates.sort((a, b) => b.tsMs - a.tsMs);
  for (const candidate of candidates) {
    const line = io.readFirstLine(candidate.path);
    if (!line) continue;
    let meta: CodexSessionMeta | undefined;
    try {
      meta = (JSON.parse(line) as { payload?: CodexSessionMeta }).payload;
    } catch {
      continue;
    }
    if (!meta || meta.cwd !== paneCwd) continue;
    // Skip subagent threads — same dir, same cwd, but not the pane's own
    // conversation (their meta carries subagent provenance).
    if (meta.thread_source === "subagent") continue;
    if (typeof meta.source === "object" && meta.source !== null && "subagent" in meta.source) {
      continue;
    }
    return candidate.id;
  }
  return null;
}

/** PURE-ish (io-injected) — cursor fallback: newest chat dir under
 *  `chats/<md5(pane cwd)>` modified at/after the agent process start. */
export function cursorIdFromStateDir(
  chatsRoot: string,
  paneCwd: string,
  startMs: number,
  io: StateDirIo,
): string | null {
  const hashed = join(chatsRoot, createHash("md5").update(paneCwd).digest("hex"));
  const cutoff = startMs - START_SLACK_MS;
  let best: { name: string; mtime: number } | null = null;
  for (const name of io.listDir(hashed)) {
    if (!SAFE_SESSION_ID.test(name)) continue;
    const mtime = io.mtimeMs(join(hashed, name));
    if (mtime === null || mtime < cutoff) continue;
    if (!best || mtime > best.mtime) best = { name, mtime };
  }
  return best?.name ?? null;
}

// ---------------------------------------------------------------------------
// The per-kind probe registry
// ---------------------------------------------------------------------------

/** One capture-eligible pane, as the updater tick sees it. */
export interface CapturePane {
  paneId: string;
  /** Resolved agent kind (manifest id), or null for a non-agent pane. */
  agent: string | null;
  /** `pane_pid` — root of the pane's process tree. */
  pid: number;
  /** `pane_current_path`. */
  dir: string;
  /** Existing `@agent_session_id`, or null — capture only fills EMPTY stamps. */
  sessionId: string | null;
}

/** The io a live probe needs — injectable so probes are tested without ps/lsof. */
export interface ProbeIo {
  processTable: () => ProcEntry[];
  /** Absolute paths of a pid's open files ([] on any failure). */
  openFiles: (pid: number) => string[];
  /** Epoch ms a pid started at, or null. */
  processStartMs: (pid: number) => number | null;
  stateDir: StateDirIo;
  /** State roots, overridable for tests. */
  codexSessionsRoot: () => string;
  cursorChatsRoot: () => string;
  now: () => number;
}

/** The binary tokens per kind worth an open-files look (see {@link agentPidsInSubtree}). */
const KIND_BINS: Record<string, string[]> = {
  codex: ["codex", "codex.exe"],
  cursor: ["cursor-agent", "cursor"],
};

function probeKind(pane: CapturePane, kind: "codex" | "cursor", io: ProbeIo): string | null {
  const table = io.processTable();
  const pids = agentPidsInSubtree(table, pane.pid, KIND_BINS[kind]!);
  if (pids.length === 0) return null;
  // 1. Exact: an open session file names the id directly.
  const fromOpen = kind === "codex" ? codexIdFromOpenFiles : cursorIdFromOpenFiles;
  for (const pid of pids) {
    const id = fromOpen(io.openFiles(pid));
    if (id) return id;
  }
  // 2. Fallback: deterministic state-dir probe anchored on the agent's start time.
  const startMs = io.processStartMs(pids[0]!);
  if (startMs === null) return null;
  return kind === "codex"
    ? codexIdFromStateDir(io.codexSessionsRoot(), pane.dir, startMs, io.stateDir, io.now())
    : cursorIdFromStateDir(io.cursorChatsRoot(), pane.dir, startMs, io.stateDir);
}

/**
 * The kinds this module captures for, with their probes. claude/opencode are
 * integration-captured (hooks/plugin); the rest of the resume table has no
 * defensible disk surface (see the header verdicts).
 */
export const CAPTURE_PROBES: Record<string, (pane: CapturePane, io: ProbeIo) => string | null> = {
  codex: (pane, io) => probeKind(pane, "codex", io),
  cursor: (pane, io) => probeKind(pane, "cursor", io),
};

/** The kinds with a shipped probe (surfaced by `integration status`). */
export const PROBED_KINDS: readonly string[] = Object.keys(CAPTURE_PROBES);

// ---------------------------------------------------------------------------
// The capturer — throttled, stamp-once, pulsed by the updater tick
// ---------------------------------------------------------------------------

/** Probe cadence in updater ticks (~2s each) — sessions materialize lazily
 *  (codex writes its rollout only on the first turn), so capture RETRIES until
 *  a pane is stamped, but never more than once per window. */
export const CAPTURE_EVERY_TICKS = 5;

export interface SessionIdCapturerDeps {
  /** Probe one pane → id | null. Defaults to {@link CAPTURE_PROBES} over live io. */
  probe?: (pane: CapturePane) => string | null;
  /** Stamp `@agent_session_id` on a pane. */
  stamp: (paneId: string, id: string) => void;
  everyTicks?: number;
}

export interface SessionIdCapturer {
  /** Pulse with this tick's panes; probes at most every `everyTicks` pulses. */
  onTick: (panes: CapturePane[]) => void;
}

/**
 * Create the stateful capturer. Cheap by construction: panes are considered
 * only when their resolved kind has a probe AND they carry no stamp yet (an
 * integration-written or restore-re-stamped id short-circuits everything), and
 * even then only every {@link CAPTURE_EVERY_TICKS} ticks. A stamped pane costs
 * nothing on every later tick. Stamped ids are remembered so a pane is never
 * re-stamped by us within one updater lifetime (the option itself is the
 * durable record; the memory just bridges the ticks until the next scan
 * reflects it).
 */
export function createSessionIdCapturer(deps: SessionIdCapturerDeps): SessionIdCapturer {
  const every = deps.everyTicks ?? CAPTURE_EVERY_TICKS;
  const probe = deps.probe ?? ((pane: CapturePane) => defaultProbe(pane));
  const stampedByUs = new Set<string>();
  let ticks = 0;
  return {
    onTick(panes: CapturePane[]): void {
      ticks++;
      if (every <= 0 || ticks % every !== 0) return;
      for (const pane of panes) {
        if (!pane.agent || pane.sessionId || stampedByUs.has(pane.paneId)) continue;
        const kindProbe = CAPTURE_PROBES[pane.agent];
        if (!kindProbe) continue;
        let id: string | null;
        try {
          id = probe(pane);
        } catch {
          continue; // a failed probe must never hurt the tick
        }
        if (!id || !SAFE_SESSION_ID.test(id)) continue;
        try {
          deps.stamp(pane.paneId, id);
          // Marked only AFTER a successful stamp — a failed set-option retries
          // on the next capture window instead of silently never stamping.
          stampedByUs.add(pane.paneId);
        } catch {
          // stamp failed (pane gone / tmux hiccup) — retry next window
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// io — the live defaults
// ---------------------------------------------------------------------------

/** Live fs io for the state-dir probes. Never throws. */
export const liveStateDirIo: StateDirIo = {
  listDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  readFirstLine: (path) => {
    try {
      // Session-meta lines are small; a bounded read keeps this cheap even on
      // a large rollout file.
      const fd = readFileSync(path, { encoding: "utf8", flag: "r" });
      const newline = fd.indexOf("\n");
      return newline === -1 ? fd : fd.slice(0, newline);
    } catch {
      return null;
    }
  },
};

/**
 * io — a pid's open regular files: `/proc/<pid>/fd` on Linux (no subprocess),
 * `lsof -p <pid>` elsewhere. [] on any failure — the state-dir fallback covers.
 */
export function readOpenFiles(pid: number): string[] {
  // Linux: readlink the fd table directly.
  try {
    const fdDir = `/proc/${pid}/fd`;
    const names = readdirSync(fdDir);
    const paths: string[] = [];
    for (const name of names) {
      try {
        const target = readlinkSync(join(fdDir, name));
        if (target.startsWith("/")) paths.push(target);
      } catch {
        // fd raced away — skip
      }
    }
    return paths;
  } catch {
    // not Linux (or unreadable) — fall through to lsof
  }
  try {
    const raw = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    // -Fn output: one field per line; `n<path>` lines carry the name.
    return raw
      .split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

/** io — a pid's start time via `ps -o etime=` (start ≈ now − elapsed). */
export function processStartMs(pid: number, nowMs: number = Date.now()): number | null {
  try {
    const raw = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const seconds = parseEtimeSeconds(raw);
    return seconds === null ? null : nowMs - seconds * 1000;
  } catch {
    return null;
  }
}

/** The live {@link ProbeIo}. State roots honor test overrides. */
export function liveProbeIo(): ProbeIo {
  return {
    processTable: readProcessTable,
    openFiles: readOpenFiles,
    processStartMs: (pid) => processStartMs(pid),
    stateDir: liveStateDirIo,
    codexSessionsRoot: () =>
      process.env.TMUX_IDE_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions"),
    cursorChatsRoot: () => process.env.TMUX_IDE_CURSOR_CHATS ?? join(homedir(), ".cursor", "chats"),
    now: () => Date.now(),
  };
}

/** The default live probe: kind-dispatched over {@link liveProbeIo}. */
export function defaultProbe(pane: CapturePane): string | null {
  const kindProbe = pane.agent ? CAPTURE_PROBES[pane.agent] : undefined;
  return kindProbe ? kindProbe(pane, liveProbeIo()) : null;
}
