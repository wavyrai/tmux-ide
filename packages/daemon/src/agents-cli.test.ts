import { describe, it, expect } from "vitest";
import type { AgentRecord } from "@tmux-ide/contracts";
import {
  findAgentById,
  resolveSendTarget,
  groupAgentsByMachine,
  formatAgentLine,
  formatAgentList,
} from "./agents-cli.ts";
import { IdeError } from "./lib/errors.ts";

function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "dev:%1",
    kind: "managed",
    tool: "claude",
    name: "Agent 1",
    status: "idle",
    session: "dev",
    paneId: "%1",
    paneTitle: null,
    cwd: null,
    taskId: null,
    taskTitle: null,
    pid: null,
    lastActivity: "2026-07-02T00:00:00.000Z",
    machineId: null,
    machineName: "local-mac",
    ...overrides,
  };
}

const fleet: AgentRecord[] = [
  agent({ id: "dev:%1", name: "Lead", status: "busy", taskTitle: "Fix login" }),
  agent({
    id: "ssh:boxa:project:%1",
    name: "Remote 1",
    status: "idle",
    session: "project",
    machineId: "ssh:boxa",
    machineName: "boxa",
  }),
  agent({
    id: "3c9f0e2a:hq-proj:%2",
    name: "HQ Agent",
    status: "offline",
    session: "hq-proj",
    paneId: "%2",
    machineId: "3c9f0e2a",
    machineName: "studio",
  }),
  agent({
    id: "sess-external-1",
    name: "claude@side-project",
    kind: "external",
    status: "busy",
    session: null,
    paneId: null,
    cwd: "/Users/me/side-project",
  }),
];

describe("findAgentById / resolveSendTarget", () => {
  it("resolves a local agent to machineId null", () => {
    const { agent: found, machineId } = resolveSendTarget(fleet, "dev:%1");
    expect(found.name).toBe("Lead");
    expect(machineId).toBeNull();
  });

  it("resolves an SSH-remote agent to its ssh machineId verbatim", () => {
    const { machineId } = resolveSendTarget(fleet, "ssh:boxa:project:%1");
    expect(machineId).toBe("ssh:boxa");
  });

  it("resolves an HQ-machine agent to its uuid machineId verbatim", () => {
    const { machineId } = resolveSendTarget(fleet, "3c9f0e2a:hq-proj:%2");
    expect(machineId).toBe("3c9f0e2a");
  });

  it("matches ids exactly — never by prefix or parsing", () => {
    expect(findAgentById(fleet, "dev:%")).toBeUndefined();
    expect(findAgentById(fleet, "ssh:boxa")).toBeUndefined();
    expect(findAgentById(fleet, "dev:%1")?.id).toBe("dev:%1");
  });

  it("throws a clear not-found error suggesting the list command", () => {
    expect(() => resolveSendTarget(fleet, "nope")).toThrowError(IdeError);
    expect(() => resolveSendTarget(fleet, "nope")).toThrowError(
      /Agent not found: nope.*tmux-ide agents/s,
    );
  });
});

describe("groupAgentsByMachine", () => {
  it("puts the local machine (machineId null) first", () => {
    const reversed = [...fleet].reverse();
    const groups = groupAgentsByMachine(reversed);
    expect(groups[0]!.machineId).toBeNull();
    expect(groups[0]!.agents.map((a) => a.id)).toEqual(["sess-external-1", "dev:%1"]);
  });

  it("keeps one group per machine with its name attached", () => {
    const groups = groupAgentsByMachine(fleet);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.machineName)).toEqual(["local-mac", "boxa", "studio"]);
  });
});

describe("formatAgentLine", () => {
  it("shows glyph, name, tool, kind, session·paneId, task, and id", () => {
    const line = formatAgentLine(fleet[0]!);
    expect(line).toContain("●");
    expect(line).toContain("Lead");
    expect(line).toContain("claude");
    expect(line).toContain("managed");
    expect(line).toContain("dev·%1");
    expect(line).toContain("— Fix login");
    expect(line).toContain("[dev:%1]");
  });

  it("falls back to cwd when there is no pane, and uses status glyphs", () => {
    const external = formatAgentLine(fleet[3]!);
    expect(external).toContain("/Users/me/side-project");
    expect(external).toContain("external");
    expect(formatAgentLine(fleet[1]!)).toContain("○");
    expect(formatAgentLine(fleet[2]!)).toContain("◌");
  });
});

describe("formatAgentList", () => {
  it("groups output by machine with the local machine first", () => {
    const text = formatAgentList(fleet);
    const lines = text.split("\n");
    expect(lines[0]).toBe("local-mac (this machine)");
    const boxaIndex = lines.indexOf("boxa");
    const studioIndex = lines.indexOf("studio");
    expect(boxaIndex).toBeGreaterThan(0);
    expect(studioIndex).toBeGreaterThan(boxaIndex);
    expect(lines[boxaIndex + 1]).toContain("[ssh:boxa:project:%1]");
  });

  it("labels the local group generically when machineName is missing", () => {
    const text = formatAgentList([agent({ machineName: null })]);
    expect(text.split("\n")[0]).toBe("this machine");
  });

  it("reports an empty fleet", () => {
    expect(formatAgentList([])).toBe("No agents found.");
  });
});
