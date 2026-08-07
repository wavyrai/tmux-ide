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
import { parseAuthority } from "../detect/classify.ts";

const SCRIPT = "/home/u/.tmux-ide/hooks/claude-state.sh";

describe("mergeHooks", () => {
  it("adds one entry per lifecycle event with the right state arg", () => {
    const merged = mergeHooks({}, SCRIPT);
    for (const { event, state } of EVENT_STATES) {
      const groups = merged.hooks?.[event] ?? [];
      expect(groups.length).toBe(1);
      expect(groups[0]!.hooks[0]!.command).toBe(`${SCRIPT} ${state}`);
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
    expect(stop.some((g) => g.hooks[0]!.command === `${SCRIPT} done`)).toBe(true);
  });

  it("is idempotent — reinstalling replaces rather than duplicates", () => {
    const once = mergeHooks({}, SCRIPT);
    const twice = mergeHooks(once, SCRIPT);
    expect(twice.hooks!.Stop!.length).toBe(1);
  });

  it("only PreToolUse carries a matcher", () => {
    const merged = mergeHooks({}, SCRIPT);
    expect(merged.hooks!.PreToolUse![0]!.matcher).toBe("*");
    expect(merged.hooks!.Stop![0]!.matcher).toBeUndefined();
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
