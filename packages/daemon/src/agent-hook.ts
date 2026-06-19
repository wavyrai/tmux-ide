import { readFileSync, mkdirSync, renameSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readCanonicalDaemonInfo } from "./lib/canonical-daemon.ts";

/**
 * `tmux-ide agent ...` — lets a Claude Code (or Codex) CLI session running in a
 * plain terminal report itself to the local canonical daemon so it shows up in
 * the central agent view.
 *
 * The reporting path (`agent report <event>`) is invoked by Claude Code hooks.
 * It MUST be fast and MUST NOT throw to the parent: every failure mode exits 0
 * so it can never break the user's Claude session. It only OBSERVES the
 * session — it cannot control a plain-terminal agent.
 */

type HookEvent = "start" | "activity" | "stop";

const EVENT_TO_ACTION: Record<
  HookEvent,
  "agent.register" | "agent.heartbeat" | "agent.unregister"
> = {
  start: "agent.register",
  activity: "agent.heartbeat",
  stop: "agent.unregister",
};

/** Shape of the JSON object Claude Code delivers on stdin to a hook command. */
interface HookStdin {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
}

/** register: { id, tool?, name?, cwd?, session?, pid?, status?, taskTitle? } */
interface RegisterPayload {
  id: string;
  tool?: "claude" | "codex";
  name?: string;
  cwd?: string;
  session?: string;
  pid?: number;
  status?: "busy" | "idle" | "offline";
  taskTitle?: string;
}

/** heartbeat: { id, status?, taskTitle? } */
interface HeartbeatPayload {
  id: string;
  status?: "busy" | "idle" | "offline";
  taskTitle?: string;
}

/** unregister: { id } */
interface UnregisterPayload {
  id: string;
}

type ActionPayload = RegisterPayload | HeartbeatPayload | UnregisterPayload;

function parseStdin(raw: string): HookStdin {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as HookStdin;
  } catch {
    // Malformed stdin — fall through to an empty object.
  }
  return {};
}

/**
 * Map a hook event + the Claude Code stdin payload onto an agent action body.
 *
 * Status mapping:
 *  - start / activity (UserPromptSubmit, SessionStart) → "busy" — the user just
 *    handed the agent work.
 *  - stop (Stop, SessionEnd) → "idle" for the heartbeat-style stop. The actual
 *    teardown is the `agent.unregister` action which only needs the id.
 *
 * `name` is derived as "<tool>@<basename(cwd)>" (e.g. "claude@my-project") so
 * the central view can show a human-friendly label.
 */
export function buildPayload(event: HookEvent, stdin: HookStdin): ActionPayload | null {
  const id = typeof stdin.session_id === "string" ? stdin.session_id.trim() : "";
  if (!id) return null;

  if (event === "stop") {
    return { id } satisfies UnregisterPayload;
  }

  const cwd = typeof stdin.cwd === "string" && stdin.cwd ? stdin.cwd : undefined;
  const status: "busy" | "idle" = "busy";

  if (event === "activity") {
    return { id, status } satisfies HeartbeatPayload;
  }

  // event === "start" → register
  const name = cwd ? `claude@${basename(cwd)}` : "claude";
  return {
    id,
    tool: "claude",
    name,
    cwd,
    session: id,
    pid: typeof process.ppid === "number" ? process.ppid : undefined,
    status,
  } satisfies RegisterPayload;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function hostnameForClient(bindHostname: string): string {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}

/**
 * Read stdin, build the payload, and POST it to the local daemon. Never throws,
 * always resolves. If no daemon is running, returns silently.
 */
async function report(event: HookEvent): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    // No stdin (e.g. a TTY) — nothing to report.
    return;
  }

  const stdin = parseStdin(raw);
  const payload = buildPayload(event, stdin);
  if (!payload) return;

  const info = readCanonicalDaemonInfo();
  if (!info) return;

  const action = EVENT_TO_ACTION[event];
  const baseUrl = `http://${hostnameForClient(info.bindHostname)}:${info.port}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (info.authToken) headers.Authorization = `Bearer ${info.authToken}`;

  try {
    await fetch(`${baseUrl}/api/v2/action/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: timeoutSignal(1500),
    });
  } catch {
    // Daemon unreachable or slow — observing is best-effort.
  }
}

/** Claude Code lifecycle hook → reported event. Single source of truth. */
const HOOK_EVENTS = {
  SessionStart: "start",
  UserPromptSubmit: "activity",
  Stop: "stop",
  SessionEnd: "stop",
} as const satisfies Record<string, HookEvent>;

function settingsPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, "settings.json")
    : join(homedir(), ".claude", "settings.json");
}

interface HookCommandEntry {
  type: "command";
  command: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommandEntry[];
}

type HooksConfig = Record<string, HookMatcher[]>;

/**
 * Build the `hooks` snippet that wires the four lifecycle events to
 * `tmux-ide agent report <event>`.
 */
export function buildHookSnippet(): HooksConfig {
  const snippet: HooksConfig = {};
  for (const [hookName, event] of Object.entries(HOOK_EVENTS)) {
    snippet[hookName] = [
      { hooks: [{ type: "command", command: `tmux-ide agent report ${event}` }] },
    ];
  }
  return snippet;
}

function isOurHookEntry(entry: HookCommandEntry): boolean {
  return entry.type === "command" && /\btmux-ide agent report\b/.test(entry.command);
}

/**
 * Merge our hook matchers into the existing `hooks` config without clobbering
 * unrelated hooks. Replaces only previously-installed `tmux-ide agent report`
 * entries so re-running the installer is idempotent.
 */
export function mergeHooks(existing: HooksConfig | undefined, snippet: HooksConfig): HooksConfig {
  const merged: HooksConfig = { ...(existing ?? {}) };
  for (const [hookName, matchers] of Object.entries(snippet)) {
    const current = Array.isArray(merged[hookName]) ? merged[hookName] : [];
    // Strip any prior tmux-ide entries, then drop now-empty matchers.
    const cleaned = current
      .map((matcher) => ({
        ...matcher,
        hooks: (matcher.hooks ?? []).filter((entry) => !isOurHookEntry(entry)),
      }))
      .filter((matcher) => matcher.hooks.length > 0);
    merged[hookName] = [...cleaned, ...matchers];
  }
  return merged;
}

async function installHooks(opts: { print?: boolean; json?: boolean }): Promise<void> {
  const snippet = buildHookSnippet();

  if (opts.print) {
    console.log(JSON.stringify({ hooks: snippet }, null, 2));
    return;
  }

  const path = settingsPath();
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Could not parse ${path}. Fix the JSON or run "tmux-ide agent hook install --print" and merge manually.`,
      );
    }
  }

  const existingHooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as HooksConfig)
      : undefined;
  settings.hooks = mergeHooks(existingHooks, snippet);

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, path, events: Object.keys(snippet) }));
  } else {
    console.log(`Installed tmux-ide agent hooks into ${path}`);
    console.log(`Events: ${Object.keys(snippet).join(", ")}`);
    console.log("Restart your Claude Code sessions for the hooks to take effect.");
  }
}

interface AgentCommandOptions {
  sub?: string;
  args?: string[];
  json?: boolean;
  print?: boolean;
}

/**
 * Entry point for `tmux-ide agent ...`.
 *
 * - `agent report <start|activity|stop>` — invoked by Claude Code hooks. Always
 *   exits 0; never throws to the parent process.
 * - `agent hook install [--print]` — merge the hook config into
 *   ~/.claude/settings.json (or print the snippet with `--print`).
 */
export async function agentCommand(opts: AgentCommandOptions): Promise<void> {
  const sub = opts.sub;

  if (sub === "report") {
    const event = opts.args?.[0];
    if (event === "start" || event === "activity" || event === "stop") {
      try {
        await report(event);
      } catch {
        // Reporting is best-effort and must never break the parent session.
      }
    }
    // Always succeed for the hook path.
    process.exit(0);
  }

  if (sub === "hook") {
    const hookSub = opts.args?.[0];
    if (hookSub === "install") {
      await installHooks({ print: opts.print, json: opts.json });
      return;
    }
    throw new Error("Usage: tmux-ide agent hook install [--print]");
  }

  throw new Error(
    "Usage:\n" +
      "  tmux-ide agent report <start|activity|stop>\n" +
      "  tmux-ide agent hook install [--print]",
  );
}
