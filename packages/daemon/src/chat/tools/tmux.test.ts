import { describe, expect, it } from "vitest";
import type { PaneInfo } from "@tmux-ide/contracts";
import { createTmuxTools, type TmuxToolDeps } from "./tmux.ts";
import { buildChatToolRegistry } from "../tool-registry.ts";

function makePanes(): PaneInfo[] {
  return [
    {
      id: "%0",
      index: 0,
      title: "Lead",
      currentCommand: "claude",
      width: 80,
      height: 24,
      active: true,
      role: "lead",
      name: "lead",
      type: null,
    },
    {
      id: "%1",
      index: 1,
      title: "Dev Server",
      currentCommand: "node",
      width: 80,
      height: 24,
      active: false,
      role: "teammate",
      name: "dev",
      type: null,
    },
  ];
}

function buildDeps(overrides: Partial<TmuxToolDeps> = {}): {
  deps: TmuxToolDeps;
  sendCalls: Array<{ target: string; text: string; enter: boolean }>;
  recentCalls: Array<{ target: string; lines: number }>;
  captureCalls: Array<{ target: string; scrollback: number }>;
} {
  const sendCalls: Array<{ target: string; text: string; enter: boolean }> = [];
  const recentCalls: Array<{ target: string; lines: number }> = [];
  const captureCalls: Array<{ target: string; scrollback: number }> = [];
  return {
    sendCalls,
    recentCalls,
    captureCalls,
    deps: {
      listPanes: () => makePanes(),
      sendKeys: (target, text, opts) => {
        sendCalls.push({ target, text, enter: opts.enter });
      },
      captureRecent: (target, lines) => {
        recentCalls.push({ target, lines });
        return `recent ${target} ${lines}`;
      },
      capturePane: (target, opts) => {
        captureCalls.push({ target, scrollback: opts.scrollback });
        return `scrollback ${target} ${opts.scrollback}`;
      },
      ...overrides,
    },
  };
}

describe("createTmuxTools — send_to_pane", () => {
  it("resolves by title and forwards text with Enter by default", async () => {
    const { deps, sendCalls } = buildDeps();
    const { send_to_pane } = createTmuxTools("alpha", deps);
    const result = await send_to_pane.handler({ target: "Dev Server", text: "ls\n" });
    expect(result).toEqual({
      ok: true,
      output: { paneId: "%1", title: "Dev Server", bytes: 3, enter: true },
    });
    expect(sendCalls).toEqual([{ target: "%1", text: "ls\n", enter: true }]);
  });

  it("honors enter: false", async () => {
    const { deps, sendCalls } = buildDeps();
    const { send_to_pane } = createTmuxTools("alpha", deps);
    const result = await send_to_pane.handler({ target: "%0", text: "hi", enter: false });
    expect(result.ok).toBe(true);
    expect(sendCalls).toEqual([{ target: "%0", text: "hi", enter: false }]);
  });

  it("resolves by role and pane id", async () => {
    const { deps, sendCalls } = buildDeps();
    const { send_to_pane } = createTmuxTools("alpha", deps);
    await send_to_pane.handler({ target: "lead", text: "/help" });
    await send_to_pane.handler({ target: "%1", text: "pwd" });
    expect(sendCalls.map((c) => c.target)).toEqual(["%0", "%1"]);
  });

  it("returns ok: false when the pane cannot be resolved", async () => {
    const { deps } = buildDeps();
    const { send_to_pane } = createTmuxTools("alpha", deps);
    const result = await send_to_pane.handler({ target: "nonexistent-pane", text: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/);
    }
  });

  it("returns ok: false when the session has no panes", async () => {
    const { deps } = buildDeps({ listPanes: () => [] });
    const { send_to_pane } = createTmuxTools("alpha", deps);
    const result = await send_to_pane.handler({ target: "Lead", text: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no panes/);
    }
  });

  it("returns ok: false when input fails Zod validation", async () => {
    const { deps } = buildDeps();
    const { send_to_pane } = createTmuxTools("alpha", deps);
    const result = await send_to_pane.handler({ target: "", text: "x" } as never);
    expect(result.ok).toBe(false);
  });
});

describe("createTmuxTools — read_pane", () => {
  it("defaults to 50 lines and forwards the resolved pane id", async () => {
    const { deps, recentCalls } = buildDeps();
    const { read_pane } = createTmuxTools("alpha", deps);
    const result = await read_pane.handler({ target: "Dev Server" });
    expect(result).toEqual({
      ok: true,
      output: { paneId: "%1", title: "Dev Server", lines: 50, content: "recent %1 50" },
    });
    expect(recentCalls).toEqual([{ target: "%1", lines: 50 }]);
  });

  it("honors a custom line count", async () => {
    const { deps, recentCalls } = buildDeps();
    const { read_pane } = createTmuxTools("alpha", deps);
    const result = await read_pane.handler({ target: "%0", lines: 200 });
    expect(result.ok).toBe(true);
    expect(recentCalls).toEqual([{ target: "%0", lines: 200 }]);
  });

  it("rejects non-positive line counts via Zod", async () => {
    const { deps } = buildDeps();
    const { read_pane } = createTmuxTools("alpha", deps);
    const result = await read_pane.handler({ target: "%0", lines: 0 });
    expect(result.ok).toBe(false);
  });
});

describe("createTmuxTools — capture_pane", () => {
  it("defaults scrollback to 5000", async () => {
    const { deps, captureCalls } = buildDeps();
    const { capture_pane } = createTmuxTools("alpha", deps);
    const result = await capture_pane.handler({ target: "%0" });
    expect(result).toEqual({
      ok: true,
      output: { paneId: "%0", title: "Lead", scrollback: 5000, content: "scrollback %0 5000" },
    });
    expect(captureCalls).toEqual([{ target: "%0", scrollback: 5000 }]);
  });

  it("honors a custom scrollback depth", async () => {
    const { deps, captureCalls } = buildDeps();
    const { capture_pane } = createTmuxTools("alpha", deps);
    const result = await capture_pane.handler({ target: "dev", scrollback: 100 });
    expect(result.ok).toBe(true);
    expect(captureCalls).toEqual([{ target: "%1", scrollback: 100 }]);
  });

  it("propagates underlying tmux errors as ok: false", async () => {
    const { deps } = buildDeps({
      capturePane: () => {
        throw new Error("tmux: can't find pane");
      },
    });
    const { capture_pane } = createTmuxTools("alpha", deps);
    const result = await capture_pane.handler({ target: "%0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/can't find pane/);
    }
  });
});

describe("createTmuxTools — JSON Schema advertisement", () => {
  it("emits ACP-compatible JSON Schema for each tool input", () => {
    const { deps } = buildDeps();
    const tools = createTmuxTools("alpha", deps);
    const send = tools.send_to_pane.jsonSchema;
    expect(send.type).toBe("object");
    expect((send.properties as Record<string, { type: string }>).target.type).toBe("string");
    expect((send.properties as Record<string, { type: string }>).text.type).toBe("string");
    expect((send.properties as Record<string, { type: string }>).enter.type).toBe("boolean");
    expect(send.required).toEqual(["target", "text"]);
    expect((send.properties as Record<string, { minLength?: number }>).target.minLength).toBe(1);

    const read = tools.read_pane.jsonSchema;
    expect((read.properties as Record<string, { type: string }>).lines.type).toBe("integer");
    expect(read.required).toEqual(["target"]);

    const capture = tools.capture_pane.jsonSchema;
    expect((capture.properties as Record<string, { type: string }>).scrollback.type).toBe(
      "integer",
    );
    expect(capture.required).toEqual(["target"]);
  });
});

describe("buildChatToolRegistry", () => {
  it("registers all three tmux tools and exposes advertise()", () => {
    const { deps } = buildDeps();
    const registry = buildChatToolRegistry({ session: "alpha", tmuxDeps: deps });
    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["capture_pane", "read_pane", "send_to_pane"].sort());
    const ad = registry.advertise();
    expect(ad).toHaveLength(3);
    for (const entry of ad) {
      expect(entry.inputSchema.type).toBe("object");
      expect(typeof entry.description).toBe("string");
    }
    expect(registry.get("send_to_pane")?.name).toBe("send_to_pane");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("threads tool calls through to the mocked deps", async () => {
    const { deps, sendCalls } = buildDeps();
    const registry = buildChatToolRegistry({ session: "alpha", tmuxDeps: deps });
    const tool = registry.get<{ target: string; text: string }, unknown>("send_to_pane");
    expect(tool).toBeDefined();
    const result = await tool!.handler({ target: "lead", text: "ping" });
    expect(result.ok).toBe(true);
    expect(sendCalls).toEqual([{ target: "%0", text: "ping", enter: true }]);
  });

  it("rejects duplicate tool registrations", () => {
    const { deps } = buildDeps();
    expect(() =>
      buildChatToolRegistry({
        session: "alpha",
        tmuxDeps: deps,
        extraTools: [
          {
            name: "send_to_pane",
            description: "dup",
            inputSchema: { parse: (x: unknown) => x } as never,
            jsonSchema: {},
            handler: async () => ({ ok: true, output: null }),
          },
        ],
      }),
    ).toThrow(/Duplicate/);
  });
});
