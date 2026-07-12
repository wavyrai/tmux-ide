/**
 * opencode integration — session-id capture via a first-class opencode plugin.
 *
 * opencode (v1.17.x) auto-loads ESM plugins from the GLOBAL plugin dir
 * (`~/.config/opencode/plugin/*.js` — XDG-aware) at startup; a plugin runs
 * IN-PROCESS (Bun), so `process.env.TMUX_PANE` is exactly the pane opencode
 * lives in, and its `event` hook sees the session lifecycle. That's the same
 * authority-shaped surface Claude Code's hooks give us, so this integration
 * mirrors {@link ./claude.ts}: `tmux-ide integration install opencode` writes
 * one marker-tagged plugin file; uninstall removes exactly that file.
 *
 * The plugin stamps ONLY `@agent_session_id` (the key
 * `tmux-ide restore --resume-agents` feeds to `opencode --session <id>`):
 *  - `session.updated` fires on create + every update; the id lives at
 *    `event.properties.info.id` (format `ses_<base62>`).
 *  - Child/subagent sessions carry `info.parentID` — those are NOT the pane's
 *    resumable conversation, so they never stamp.
 *  - `@agent_state` is deliberately NOT stamped: `session.updated` is not a
 *    truthful working/blocked signal, and a wrong authority stamp would
 *    suppress correct screen-scraping for the staleness window.
 *
 * Install takes effect for NEW opencode sessions (plugins load at startup).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Marker every installed plugin contains — the ownership/removal key. */
export const PLUGIN_MARKER = "installed by: tmux-ide integration install opencode";

/** The plugin filename inside opencode's global plugin dir. */
export const PLUGIN_FILENAME = "tmux-ide.js";

/**
 * Absolute path to the plugin file: `TMUX_IDE_OPENCODE_DIR` when set (tests /
 * per-run overrides — points at the PLUGIN DIR), else XDG config, else
 * `~/.config/opencode/plugin/`. The override keeps tests away from real state,
 * matching `TMUX_IDE_CLAUDE_SETTINGS`.
 */
export function opencodePluginPath(): string {
  const override = process.env.TMUX_IDE_OPENCODE_DIR;
  if (override) return join(override, PLUGIN_FILENAME);
  const xdg = process.env.XDG_CONFIG_HOME;
  const configRoot = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(configRoot, "opencode", "plugin", PLUGIN_FILENAME);
}

/**
 * The plugin source. Plain ESM JS, zero dependencies beyond node builtins
 * (opencode runs plugins under Bun, which provides them). Defensive by
 * construction: no TMUX pane → inert; malformed events → ignored; the id is
 * gated on the same uuid-ish charset restore trusts before it ever reaches
 * `set-option`.
 */
export const PLUGIN_SOURCE = `/**
 * tmux-ide opencode plugin (${PLUGIN_MARKER})
 *
 * Stamps this pane's @agent_session_id tmux option with the opencode session
 * id so \`tmux-ide restore --resume-agents\` can revive the conversation via
 * \`opencode --session <id>\` after a tmux server death.
 *
 * Remove with: tmux-ide integration uninstall opencode
 */
export const TmuxIde = async () => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return {}; // not inside tmux — inert
  const { execFile } = await import("node:child_process");
  let last = "";
  const stamp = (id) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || id === last) return;
    last = id;
    execFile("tmux", ["set-option", "-p", "-t", pane, "@agent_session_id", id], () => {});
  };
  return {
    event: async ({ event }) => {
      // session.updated fires on create + every update; info.id is the
      // resumable session id. Child sessions (subagents) carry parentID and
      // must never overwrite the pane's own conversation key.
      if (event && event.type === "session.updated") {
        const info = event.properties && event.properties.info;
        if (info && !info.parentID) stamp(info.id);
      }
    },
  };
};
`;

/** PURE — is this plugin file content ours? (contains the install marker) */
export function isOurPlugin(content: string): boolean {
  return content.includes(PLUGIN_MARKER);
}

/** Install: write the marker-tagged plugin file. Idempotent. */
export function installOpencodeIntegration(): { pluginPath: string } {
  const pluginPath = opencodePluginPath();
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, PLUGIN_SOURCE, "utf8");
  return { pluginPath };
}

/**
 * Uninstall: remove the plugin file — but only when it's OURS (marker present),
 * so a user's hand-written `tmux-ide.js` is never deleted.
 */
export function uninstallOpencodeIntegration(): { pluginPath: string; wasInstalled: boolean } {
  const pluginPath = opencodePluginPath();
  const wasInstalled = opencodeIntegrationStatus().installed;
  if (wasInstalled) rmSync(pluginPath, { force: true });
  return { pluginPath, wasInstalled };
}

/** Whether OUR plugin is installed (file exists AND carries the marker). */
export function opencodeIntegrationStatus(): { installed: boolean } {
  const pluginPath = opencodePluginPath();
  try {
    if (!existsSync(pluginPath)) return { installed: false };
    return { installed: isOurPlugin(readFileSync(pluginPath, "utf8")) };
  } catch {
    return { installed: false };
  }
}
