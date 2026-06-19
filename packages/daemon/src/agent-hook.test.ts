import { describe, it, expect } from "bun:test";
import { buildPayload, buildHookSnippet, mergeHooks } from "./agent-hook.ts";

describe("buildPayload", () => {
  it("maps a SessionStart (start) event to a register payload", () => {
    const payload = buildPayload("start", {
      session_id: "sess-123",
      cwd: "/Users/me/code/my-project",
      hook_event_name: "SessionStart",
    });
    expect(payload).toMatchObject({
      id: "sess-123",
      tool: "claude",
      name: "claude@my-project",
      cwd: "/Users/me/code/my-project",
      session: "sess-123",
      status: "busy",
    });
  });

  it("falls back to a bare 'claude' name when cwd is missing", () => {
    const payload = buildPayload("start", { session_id: "sess-1" });
    expect(payload).toMatchObject({ id: "sess-1", name: "claude", status: "busy" });
    expect((payload as { cwd?: string }).cwd).toBeUndefined();
  });

  it("maps a UserPromptSubmit (activity) event to an idempotent register payload", () => {
    const payload = buildPayload("activity", {
      session_id: "sess-2",
      cwd: "/x/y",
      hook_event_name: "UserPromptSubmit",
    });
    expect(payload).toMatchObject({
      id: "sess-2",
      tool: "claude",
      name: "claude@y",
      cwd: "/x/y",
      session: "sess-2",
      status: "busy",
    });
  });

  it("maps a stop event to an unregister payload (id only)", () => {
    const payload = buildPayload("stop", {
      session_id: "sess-3",
      cwd: "/x/y",
      hook_event_name: "Stop",
    });
    expect(payload).toEqual({ id: "sess-3" });
  });

  it("returns null when there is no session_id", () => {
    expect(buildPayload("start", {})).toBeNull();
    expect(buildPayload("activity", { session_id: "  " })).toBeNull();
    expect(buildPayload("stop", { cwd: "/x" })).toBeNull();
  });
});

describe("buildHookSnippet", () => {
  it("wires all four lifecycle events to the report command", () => {
    const snippet = buildHookSnippet();
    expect(Object.keys(snippet).sort()).toEqual([
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(snippet.SessionStart![0]!.hooks[0]!.command).toBe("tmux-ide agent report start");
    expect(snippet.UserPromptSubmit![0]!.hooks[0]!.command).toBe("tmux-ide agent report activity");
    expect(snippet.Stop![0]!.hooks[0]!.command).toBe("tmux-ide agent report stop");
    expect(snippet.SessionEnd![0]!.hooks[0]!.command).toBe("tmux-ide agent report stop");
  });
});

describe("mergeHooks", () => {
  it("preserves unrelated hooks while adding ours", () => {
    const existing = {
      SessionStart: [{ hooks: [{ type: "command" as const, command: "my-other-tool init" }] }],
      PreToolUse: [{ hooks: [{ type: "command" as const, command: "guard" }] }],
    };
    const merged = mergeHooks(existing, buildHookSnippet());
    expect(merged.PreToolUse).toEqual(existing.PreToolUse);
    const startCommands = merged.SessionStart!.flatMap((m) => m.hooks.map((h) => h.command));
    expect(startCommands).toContain("my-other-tool init");
    expect(startCommands).toContain("tmux-ide agent report start");
  });

  it("is idempotent — re-running does not duplicate our entries", () => {
    const once = mergeHooks(undefined, buildHookSnippet());
    const twice = mergeHooks(once, buildHookSnippet());
    const startCommands = twice.SessionStart!.flatMap((m) => m.hooks.map((h) => h.command));
    expect(startCommands.filter((c) => c === "tmux-ide agent report start")).toHaveLength(1);
  });
});
