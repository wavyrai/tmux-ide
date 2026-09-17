/**
 * Unit tests for the Claude Code integration's pure pieces: the settings
 * merge/removal and the authority-state parser it feeds.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_STATES,
  HOOK_SCRIPT,
  isInstalled,
  mergeHooks,
  removeHooks,
  type ClaudeSettings,
} from "./claude.ts";
import { shellEscape } from "../../lib/shell.ts";
import { parseAuthority } from "../detect/classify.ts";

const SCRIPT = "/home/u/.tmux-ide/hooks/claude-state.sh";

describe("mergeHooks", () => {
  it("adds one entry per lifecycle event with the right state arg", () => {
    const merged = mergeHooks({}, SCRIPT);
    for (const { event, state } of EVENT_STATES) {
      const groups = merged.hooks?.[event] ?? [];
      expect(groups.length).toBe(1);
      expect(groups[0]!.hooks[0]!.command).toBe(`${shellEscape(SCRIPT)} ${state}`);
    }
  });

  it("preserves existing foreign hooks and other settings", () => {
    const settings: ClaudeSettings = {
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/hook.sh" }] }] },
    };
    const merged = mergeHooks(settings, SCRIPT);
    expect(merged.model).toBe("opus");
    const stop = merged.hooks!.Stop!;
    expect(stop.some((g) => g.hooks[0]!.command === "/other/hook.sh")).toBe(true);
    expect(stop.some((g) => g.hooks[0]!.command === `${shellEscape(SCRIPT)} done`)).toBe(true);
  });

  it("is idempotent — reinstalling replaces rather than duplicates", () => {
    const once = mergeHooks({}, SCRIPT);
    const twice = mergeHooks(once, SCRIPT);
    expect(twice.hooks!.Stop!.length).toBe(1);
  });

  it("filters only notifications that mean an input/permission wait", () => {
    const merged = mergeHooks({}, SCRIPT);
    expect(merged.hooks!.PreToolUse![0]!.matcher).toBe("*");
    expect(merged.hooks!.Stop![0]!.matcher).toBeUndefined();
    const matcher = new RegExp(merged.hooks!.Notification![0]!.matcher!);
    expect(matcher.test("permission_prompt")).toBe(true);
    expect(matcher.test("elicitation_dialog")).toBe(true);
    for (const type of ["idle_prompt", "auth_success", "agent_completed", "agent_needs_input"])
      expect(matcher.test(type)).toBe(false);
  });
});

describe("removeHooks", () => {
  it("removes exactly our entries, keeping foreign hooks", () => {
    const merged = mergeHooks(
      { hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/hook.sh" }] }] } },
      SCRIPT,
    );
    const removed = removeHooks(merged);
    expect(removed.hooks!.Stop!.length).toBe(1);
    expect(removed.hooks!.Stop![0]!.hooks[0]!.command).toBe("/other/hook.sh");
    expect(removed.hooks!.UserPromptSubmit).toBeUndefined();
  });

  it("drops the hooks key entirely when nothing remains", () => {
    const removed = removeHooks(mergeHooks({}, SCRIPT));
    expect(removed.hooks).toBeUndefined();
  });
});

describe("isInstalled", () => {
  it("detects our entries and their absence", () => {
    expect(isInstalled({})).toBe(false);
    expect(isInstalled(mergeHooks({}, SCRIPT))).toBe(true);
    expect(isInstalled(removeHooks(mergeHooks({}, SCRIPT)))).toBe(false);
  });
});

describe("hook script", () => {
  it("stamps @agent_state with the state arg and epoch, and exits outside tmux", () => {
    expect(HOOK_SCRIPT).toContain('@agent_state "${state}:$(date +%s)"');
    expect(HOOK_SCRIPT).toContain('@agent_hint "claude"');
    expect(HOOK_SCRIPT).toContain('[ -n "$TMUX_PANE" ] || exit 0');
    expect(HOOK_SCRIPT).toContain("@agent_session_id");
  });
});

describe("parseAuthority", () => {
  const now = 1_751_400_000;

  it("parses fresh states", () => {
    expect(parseAuthority(`working:${now - 5}`, now)).toBe("working");
    expect(parseAuthority(`blocked:${now - 5}`, now)).toBe("blocked");
    expect(parseAuthority(`done:${now - 5000}`, now)).toBe("done");
    expect(parseAuthority(`idle:${now - 50000}`, now)).toBe("idle");
  });

  it("treats stale working/blocked as absent (fall back to scraping)", () => {
    expect(parseAuthority(`working:${now - 700}`, now)).toBeNull();
    expect(parseAuthority(`blocked:${now - 700}`, now)).toBeNull();
  });

  it("rejects malformed or unknown values", () => {
    expect(parseAuthority(undefined, now)).toBeNull();
    expect(parseAuthority("", now)).toBeNull();
    expect(parseAuthority("working", now)).toBeNull();
    expect(parseAuthority("dancing:123", now)).toBeNull();
    expect(parseAuthority("working:soon", now)).toBeNull();
  });
});

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach } from "vitest";
import {
  claudeIntegrationStatus,
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from "./claude.ts";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-hooks-unit-"));
  roots.push(root);
  return { scriptPath: join(root, HOOK_SCRIPT_RELPATH), settingsPath: join(root, "settings.json") };
}
import { HOOK_SCRIPT_RELPATH } from "./claude.ts";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("repairs and removes only our command in a mixed hook group", () => {
  const foreign = { type: "command", command: "echo unrelated", timeout: 17 };
  const settings: ClaudeSettings = {
    model: "custom",
    hooks: {
      Stop: [
        {
          matcher: "*",
          custom: true,
          hooks: [foreign, { type: "command", command: `${SCRIPT} done` }],
        },
      ],
    },
  };
  const removed = removeHooks(settings);
  expect(removed.hooks!.Stop).toEqual([{ matcher: "*", custom: true, hooks: [foreign] }]);
  expect(mergeHooks(settings, SCRIPT).hooks!.Stop![0]).toEqual(removed.hooks!.Stop![0]);
  expect(settings.hooks!.Stop![0]!.hooks).toHaveLength(2);
  const mention = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: `echo ${SCRIPT} done` }] }] },
  };
  expect(removeHooks(mention)).toEqual(mention);
});

it("quotes script paths and preserves unrelated configuration through idempotent repair", () => {
  const paths = fixture();
  const before = {
    model: "custom",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }] },
  };
  writeFileSync(paths.settingsPath, JSON.stringify(before));
  installClaudeIntegration(paths);
  const once = readFileSync(paths.settingsPath, "utf8");
  installClaudeIntegration(paths);
  expect(readFileSync(paths.settingsPath, "utf8")).toBe(once);
  expect(JSON.parse(readFileSync(`${paths.settingsPath}.tmux-ide.bak`, "utf8"))).toEqual(before);
  expect(claudeIntegrationStatus(paths)).toMatchObject({
    installed: true,
    registrationComplete: true,
    scriptCurrent: true,
    scriptExecutable: true,
    deliveryVerified: false,
  });
  uninstallClaudeIntegration(paths);
  expect(JSON.parse(readFileSync(paths.settingsPath, "utf8"))).toEqual(before);
});

it("reports incomplete, outdated, non-executable and disabled installations truthfully", () => {
  const paths = fixture();
  installClaudeIntegration(paths);
  const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  delete settings.hooks.PreToolUse;
  settings.disableAllHooks = true;
  writeFileSync(paths.settingsPath, JSON.stringify(settings));
  writeFileSync(paths.scriptPath, "#!/bin/sh\nexit 0\n");
  chmodSync(paths.scriptPath, 0o600);
  expect(claudeIntegrationStatus(paths)).toMatchObject({
    installed: false,
    registered: true,
    missingEvents: ["PreToolUse"],
    issues: [
      "registration_incomplete",
      "hooks_disabled",
      "script_outdated",
      "script_not_executable",
    ],
  });
  installClaudeIntegration(paths);
  expect(claudeIntegrationStatus(paths).issues).toEqual(["hooks_disabled"]);
  expect(claudeIntegrationStatus(paths).repairCommand).toBeNull();
  expect(claudeIntegrationStatus(paths).guidance).toContain("Enable them there if intended");
  expect(JSON.parse(readFileSync(paths.settingsPath, "utf8")).disableAllHooks).toBe(true);
});

it("refuses malformed settings without overwriting the existing script or settings", () => {
  for (const contents of ["invalid", "null", "[]", '{"hooks":{"Stop":{}}}']) {
    const paths = fixture();
    mkdirSync(dirname(paths.scriptPath), { recursive: true });
    writeFileSync(paths.scriptPath, "existing script");
    writeFileSync(paths.settingsPath, contents);
    expect(() => installClaudeIntegration(paths)).toThrow("valid settings JSON");
    expect(readFileSync(paths.scriptPath, "utf8")).toBe("existing script");
    expect(readFileSync(paths.settingsPath, "utf8")).toBe(contents);
    expect(existsSync(`${paths.settingsPath}.tmux-ide.bak`)).toBe(false);
    expect(claudeIntegrationStatus(paths).issues).toContain("settings_invalid");
    expect(claudeIntegrationStatus(paths).repairCommand).toBeNull();
  }
});

it("repairs an exact old unquoted space/apostrophe path and supports namespaced destinations", () => {
  const path = "/fixture with spaces/it's-private/hooks/claude-state.sh";
  const foreign = { type: "command", command: `echo ${path} done` };
  const old: ClaudeSettings = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: `${path} done` }, foreign] }] },
  };
  const repaired = mergeHooks(old, path);
  expect(repaired.hooks!.Stop).toEqual([
    { hooks: [foreign] },
    { hooks: [{ type: "command", command: `${shellEscape(path)} done`, timeout: 5 }] },
  ]);
  expect(mergeHooks(repaired, path)).toEqual(repaired);
  expect(removeHooks(repaired, path)).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
});

it("accepts executable-equivalent legacy unquoted commands without claiming broken notification matching complete", () => {
  const paths = fixture();
  installClaudeIntegration(paths);
  const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  for (const { event, state } of EVENT_STATES)
    settings.hooks[event][0].hooks[0].command = `${paths.scriptPath} ${state}`;
  writeFileSync(paths.settingsPath, JSON.stringify(settings));
  expect(claudeIntegrationStatus(paths).missingEvents).toEqual([]);
  delete settings.hooks.Notification[0].matcher;
  writeFileSync(paths.settingsPath, JSON.stringify(settings));
  expect(claudeIntegrationStatus(paths).missingEvents).toEqual(["Notification"]);
});
