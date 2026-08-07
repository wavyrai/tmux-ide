/**
 * Claude Code integration — the authoritative detection layer.
 *
 * Claude Code has a first-class hooks system. `tmux-ide integration install
 * claude` writes a tiny POSIX hook script and registers it in the user's
 * `~/.claude/settings.json` for the lifecycle events we care about. Each hook
 * invocation stamps the CURRENT tmux pane with a pane-local user option:
 *
 *   @agent_state       "<working|blocked|done|idle>:<unix epoch>"
 *   @agent_session_id  the Claude session id (future: --resume on restore)
 *
 * The detector treats a fresh `@agent_state` as GROUND TRUTH and only falls
 * back to screen-manifest scraping when no authority is present — the same
 * two-layer model the best agent terminals use. Any other agent can join the
 * authority layer by writing the same option (`tmux set-option -p
 * @agent_state working:$(date +%s)`) — no integration required.
 *
 * The settings merge is surgical and reversible: entries are tagged by the
 * hook-script path, a one-time backup is written next to settings.json, and
 * uninstall removes exactly our entries.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Marker every installed hook command contains — the removal key. */
export const HOOK_SCRIPT_RELPATH = ".tmux-ide/hooks/claude-state.sh";

export function hookScriptPath(): string {
  return join(homedir(), HOOK_SCRIPT_RELPATH);
}

/**
 * Absolute path to Claude Code's settings file: `TMUX_IDE_CLAUDE_SETTINGS` when
 * set (tests / per-run overrides), else `~/.claude/settings.json`. The override
 * lets install/offer flows be exercised against a scratch file so a test never
 * reads or rewrites the user's real settings.
 */
export function claudeSettingsPath(): string {
  return process.env.TMUX_IDE_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

/**
 * The hook script. POSIX sh, no dependencies. Claude Code passes the event
 * payload as JSON on stdin; the state to report comes in as $1 (each settings
 * entry passes its own state, so the script never parses the event name).
 * Outside tmux ($TMUX_PANE unset) it exits quietly. The session id is
 * extracted with sed — good enough for a flat JSON string field.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# tmux-ide agent-state hook (installed by: tmux-ide integration install claude)
# $1 = state to report: working | blocked | done | idle
state="\${1:-idle}"
payload="$(cat 2>/dev/null || true)"
[ -n "$TMUX_PANE" ] || exit 0
tmux set-option -p -t "$TMUX_PANE" @agent_state "\${state}:$(date +%s)" 2>/dev/null || exit 0
tmux set-option -p -t "$TMUX_PANE" @agent_hint "claude" 2>/dev/null || true
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
[ -n "$sid" ] && tmux set-option -p -t "$TMUX_PANE" @agent_session_id "$sid" 2>/dev/null
exit 0
`;

/** Claude Code lifecycle events → the state each reports. */
export const EVENT_STATES: Array<{ event: string; state: string; matcher?: string }> = [
  { event: "UserPromptSubmit", state: "working" },
  { event: "PreToolUse", state: "working", matcher: "*" },
  { event: "Notification", state: "blocked" },
  { event: "Stop", state: "done" },
  { event: "SessionEnd", state: "idle" },
];

interface HookCommand {
  type: "command";
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksConfig = Record<string, HookGroup[]>;
export type ClaudeSettings = Record<string, unknown> & { hooks?: HooksConfig };

/** Does a hook group belong to us? (its command references our script) */
function isOurs(group: HookGroup): boolean {
  return group.hooks?.some((h) => h.command?.includes(HOOK_SCRIPT_RELPATH)) ?? false;
}

/**
 * PURE — return a copy of `settings` with our hook entries merged in.
 * Idempotent: existing tmux-ide entries are replaced, everything else is
 * preserved untouched.
 */
export function mergeHooks(settings: ClaudeSettings, scriptPath: string): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks as HooksConfig;
  for (const { event, state, matcher } of EVENT_STATES) {
    const existing = (hooks[event] ?? []).filter((g) => !isOurs(g));
    const group: HookGroup = {
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: "command", command: `${scriptPath} ${state}` }],
    };
    hooks[event] = [...existing, group];
  }
  return next;
}

/** PURE — return a copy of `settings` with exactly our entries removed. */
export function removeHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks) return { ...settings };
  const hooks: HooksConfig = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** PURE — is our integration present in these settings? */
export function isInstalled(settings: ClaudeSettings): boolean {
  return Object.values(settings.hooks ?? {}).some((groups) => groups.some(isOurs));
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
  } catch {
    throw new Error(`${path} is not valid JSON — fix or move it, then retry`);
  }
}

/**
 * Install: write the hook script, back up settings.json once, merge our
 * entries. Takes effect for NEW Claude Code sessions (hooks are read at
 * session start).
 */
export function installClaudeIntegration(): { scriptPath: string; settingsPath: string } {
  const script = hookScriptPath();
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, HOOK_SCRIPT, "utf8");
  chmodSync(script, 0o755);

  const settingsPath = claudeSettingsPath();
  mkdirSync(dirname(settingsPath), { recursive: true });
  const settings = readSettings(settingsPath);
  const backup = `${settingsPath}.tmux-ide.bak`;
  if (existsSync(settingsPath) && !existsSync(backup)) copyFileSync(settingsPath, backup);
  writeFileSync(settingsPath, `${JSON.stringify(mergeHooks(settings, script), null, 2)}\n`, "utf8");
  return { scriptPath: script, settingsPath };
}

/** Uninstall: remove exactly our entries (script file is left, it's inert). */
export function uninstallClaudeIntegration(): { settingsPath: string; wasInstalled: boolean } {
  const settingsPath = claudeSettingsPath();
  const settings = readSettings(settingsPath);
  const wasInstalled = isInstalled(settings);
  if (wasInstalled) {
    writeFileSync(settingsPath, `${JSON.stringify(removeHooks(settings), null, 2)}\n`, "utf8");
  }
  return { settingsPath, wasInstalled };
}

export function claudeIntegrationStatus(): { installed: boolean; scriptExists: boolean } {
  return {
    installed: isInstalled(readSettings(claudeSettingsPath())),
    scriptExists: existsSync(hookScriptPath()),
  };
}
