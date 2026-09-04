import type { ApplicationShellResourceV2 } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import {
  homeAgentStatusLabel,
  projectHomeAgentRows,
  sortHomeAgentRows,
} from "./application-home-agents.ts";

const shell = {
  daemon: { instanceId: "daemon-one" },
  resource: {
    project: { name: "project" },
    workspace: {
      sidebar: {
        agents: [
          {
            id: "agent.a",
            paneId: "pane.a",
            name: "Same",
            harness: "codex",
            activity: "running",
            attention: false,
          },
          {
            id: "agent.b",
            paneId: null,
            name: "Same",
            harness: "codex",
            activity: "disconnected",
            attention: false,
          },
        ],
      },
    },
  },
} as unknown as ApplicationShellResourceV2;

describe("Home agent row projection", () => {
  it("keeps duplicate names distinct and never invents a pane target or telemetry", () => {
    const rows = projectHomeAgentRows(
      { id: "daemon-one:live-one", liveSessionId: "live-one", name: "session", paneCount: 2 },
      shell,
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows[1]!.paneId).toBeNull();
    expect(rows[0]).toMatchObject({
      projectName: "project",
      name: "Same",
      sessionKey: "daemon-one:live-one",
      liveSessionId: "live-one",
      daemonInstanceId: "daemon-one",
    });
    expect(rows[0]).not.toHaveProperty("progress");
    expect(rows[0]).not.toHaveProperty("lastActivity");
  });

  it("uses incarnation not display name for selection and ties independent of arrival order", () => {
    const session = { id: "one", liveSessionId: "live-one", name: "before", paneCount: 2 };
    const before = projectHomeAgentRows(session, shell);
    expect(projectHomeAgentRows({ ...session, name: "after" }, shell)[0]!.key).toBe(before[0]!.key);
    expect(
      projectHomeAgentRows({ ...session, id: "two", liveSessionId: "live-two" }, shell)[0]!.key,
    ).not.toBe(before[0]!.key);
    const rows = [before[0]!, { ...before[1]!, attention: true }];
    expect(sortHomeAgentRows(rows).map((row) => row.agentId)).toEqual(["agent.b", "agent.a"]);
    expect(sortHomeAgentRows([...rows].reverse())).toEqual(sortHomeAgentRows(rows));
  });

  it("keeps failed and unknown distinct from idle", () => {
    expect(homeAgentStatusLabel("failed")).toBe("FAILED");
    expect(homeAgentStatusLabel("disconnected")).toBe("UNKNOWN");
    expect(homeAgentStatusLabel("idle")).toBe("IDLE");
  });
});
