import { describe, it, expect, afterEach } from "vitest";
import {
  buildPayload,
  buildHookSnippet,
  buildReportRequest,
  hostnameForClient,
  mergeHooks,
} from "./agent-hook.ts";

afterEach(() => {
  delete process.env.TMUX_IDE_AGENT_TOOL;
});

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

  it("falls back to a bare tool name when cwd is missing", () => {
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
      status: "busy",
    });
  });

  it("maps an idle (Stop) event to a status-only heartbeat payload", () => {
    const payload = buildPayload("idle", { session_id: "sess-9", cwd: "/x/y" });
    expect(payload).toEqual({ id: "sess-9", status: "idle" });
  });

  it("maps a stop event to an unregister payload (id only)", () => {
    const payload = buildPayload("stop", {
      session_id: "sess-3",
      cwd: "/x/y",
      hook_event_name: "SessionEnd",
    });
    expect(payload).toEqual({ id: "sess-3" });
  });

  it("honors TMUX_IDE_AGENT_TOOL=codex for tool + name", () => {
    process.env.TMUX_IDE_AGENT_TOOL = "codex";
    const payload = buildPayload("start", { session_id: "s", cwd: "/a/proj" });
    expect(payload).toMatchObject({ tool: "codex", name: "codex@proj" });
  });

  it("returns null when there is no session_id", () => {
    expect(buildPayload("start", {})).toBeNull();
    expect(buildPayload("activity", { session_id: "  " })).toBeNull();
    expect(buildPayload("stop", { cwd: "/x" })).toBeNull();
    // non-string session_id is rejected by the typeof guard
    expect(buildPayload("start", { session_id: 123 as unknown as string })).toBeNull();
  });
});

describe("buildHookSnippet", () => {
  it("wires every lifecycle event to the report command", () => {
    const snippet = buildHookSnippet();
    expect(Object.keys(snippet).sort()).toEqual([
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(snippet.SessionStart![0]!.hooks[0]!.command).toBe("tmux-ide agent report start");
    expect(snippet.UserPromptSubmit![0]!.hooks[0]!.command).toBe("tmux-ide agent report activity");
    expect(snippet.PreToolUse![0]!.hooks[0]!.command).toBe("tmux-ide agent report activity");
    expect(snippet.Stop![0]!.hooks[0]!.command).toBe("tmux-ide agent report idle");
    expect(snippet.SessionEnd![0]!.hooks[0]!.command).toBe("tmux-ide agent report stop");
  });
});

describe("hostnameForClient / buildReportRequest", () => {
  it("rewrites 0.0.0.0 to loopback", () => {
    expect(hostnameForClient("0.0.0.0")).toBe("127.0.0.1");
    expect(hostnameForClient("127.0.0.1")).toBe("127.0.0.1");
  });

  it("builds the action url and attaches the bearer token when present", () => {
    const req = buildReportRequest(
      { bindHostname: "0.0.0.0", port: 6060, authToken: "tok" },
      "agent.register",
    );
    expect(req.url).toBe("http://127.0.0.1:6060/api/v2/action/agent.register");
    expect(req.headers.Authorization).toBe("Bearer tok");
  });

  it("omits Authorization when there is no token", () => {
    const req = buildReportRequest({ bindHostname: "127.0.0.1", port: 7, authToken: null }, "x");
    expect(req.headers.Authorization).toBeUndefined();
  });
});

describe("mergeHooks", () => {
  it("preserves unrelated hooks while adding ours", () => {
    const existing = {
      SessionStart: [{ hooks: [{ type: "command" as const, command: "my-other-tool init" }] }],
      PreToolUse: [{ hooks: [{ type: "command" as const, command: "guard" }] }],
    };
    const merged = mergeHooks(existing, buildHookSnippet());
    const startCommands = merged.SessionStart!.flatMap((m) => m.hooks.map((h) => h.command));
    expect(startCommands).toContain("my-other-tool init");
    expect(startCommands).toContain("tmux-ide agent report start");
    // our PreToolUse entry is added without dropping the unrelated guard
    const preCommands = merged.PreToolUse!.flatMap((m) => m.hooks.map((h) => h.command));
    expect(preCommands).toContain("guard");
    expect(preCommands).toContain("tmux-ide agent report activity");
  });

  it("is idempotent — re-running does not duplicate our entries", () => {
    const once = mergeHooks(undefined, buildHookSnippet());
    const twice = mergeHooks(once, buildHookSnippet());
    const startCommands = twice.SessionStart!.flatMap((m) => m.hooks.map((h) => h.command));
    expect(startCommands.filter((c) => c === "tmux-ide agent report start")).toHaveLength(1);
  });
});
