import { describe, it, expect, afterEach } from "vitest";
import {
  _setExecutor,
  discoverTmuxAgents,
  inferAgentTool,
  listAllTmuxPanes,
} from "../agent-discovery.ts";

// session, pane_id, index, command, cwd, pid, w, h, active, role, name, type, title
// (title is LAST so a tab inside it doesn't corrupt the other fields)
function row(fields: Partial<Record<string, string>>): string {
  return [
    fields.session ?? "proj",
    fields.id ?? "%1",
    fields.index ?? "0",
    fields.cmd ?? "claude",
    fields.cwd ?? "/work/proj",
    fields.pid ?? "1234",
    fields.width ?? "120",
    fields.height ?? "40",
    fields.active ?? "1",
    fields.role ?? "",
    fields.name ?? "",
    fields.type ?? "",
    fields.title ?? "Claude Code",
  ].join("\t");
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("inferAgentTool", () => {
  it("detects claude, codex, version-string, and unknown", () => {
    expect(inferAgentTool("claude")).toBe("claude");
    expect(inferAgentTool("codex")).toBe("codex");
    expect(inferAgentTool("2.1.80")).toBe("claude");
    expect(inferAgentTool("zsh")).toBe("unknown");
  });
});

describe("listAllTmuxPanes", () => {
  it("parses session/cwd/pid out of list-panes -a", () => {
    restore = _setExecutor((_cmd, args) => {
      expect(args).toContain("-a");
      return row({ session: "alpha", id: "%3", cwd: "/x", pid: "999" }) + "\n";
    });
    const panes = listAllTmuxPanes();
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({ session: "alpha", id: "%3", cwd: "/x", pid: 999 });
  });

  it("returns [] when no tmux server is running", () => {
    restore = _setExecutor(() => "");
    expect(listAllTmuxPanes()).toEqual([]);
  });

  it("recovers a tab embedded in the pane title (title is last field)", () => {
    restore = _setExecutor(() => row({ title: "Claude\tCode\twork" }));
    const panes = listAllTmuxPanes();
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({ session: "proj", id: "%1", title: "Claude\tCode\twork" });
  });

  it("skips malformed short rows instead of emitting NaN garbage", () => {
    restore = _setExecutor(() => ["proj\t%1", row({ id: "%2" })].join("\n"));
    const panes = listAllTmuxPanes();
    expect(panes).toHaveLength(1);
    expect(panes[0]!.id).toBe("%2");
  });
});

describe("discoverTmuxAgents", () => {
  it("classifies managed vs unmanaged and skips shells", () => {
    restore = _setExecutor(() =>
      [
        row({ session: "mine", id: "%1", cmd: "claude" }),
        row({ session: "other", id: "%2", cmd: "codex", title: "codex" }),
        row({ session: "mine", id: "%3", cmd: "zsh", title: "Shell" }),
      ].join("\n"),
    );
    const agents = discoverTmuxAgents(new Set(["mine"]));
    expect(agents).toHaveLength(2);
    const managed = agents.find((a) => a.paneId === "%1")!;
    const unmanaged = agents.find((a) => a.paneId === "%2")!;
    expect(managed.kind).toBe("managed");
    expect(managed.tool).toBe("claude");
    expect(managed.id).toBe("mine:%1");
    expect(unmanaged.kind).toBe("tmux-unmanaged");
    expect(unmanaged.tool).toBe("codex");
  });

  it("marks spinner-titled panes busy", () => {
    restore = _setExecutor(() => row({ title: "⠙ Working…", cmd: "claude" }));
    const [agent] = discoverTmuxAgents(new Set(["proj"]));
    expect(agent!.status).toBe("busy");
  });
});
