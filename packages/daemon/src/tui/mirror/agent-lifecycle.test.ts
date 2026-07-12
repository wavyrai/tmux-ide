import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../detect/manifest.ts";
import { BUNDLED_MANIFESTS } from "../detect/manifests.ts";
import {
  AGAIN_ID,
  AGENT_LAUNCH_COMMANDS,
  CUSTOM_KIND_ID,
  TEAM_ACTIONS,
  TEAM_NEW_ID,
  agentKindItems,
  clearAuthorityArgs,
  compatiblePlacement,
  customRecentId,
  customRecentIndex,
  defaultSpawnPlacement,
  interruptArgs,
  isShellCommand,
  isSpawnWhere,
  labelPaneArgs,
  labelWindowArgs,
  lastSpawnName,
  launchCommandFor,
  newAgentItems,
  paneHostsShell,
  placementActions,
  placementLabel,
  relaunchArgs,
  resolvePlacement,
  respawnArgs,
  spawnAgentArgs,
  spawnLabelFor,
  spawnSessionArgs,
  stampLaunchArgs,
  teamAgentIndex,
  teamItems,
} from "./agent-lifecycle.ts";
import type { AgentRowInput } from "./agent-rows.ts";

const manifest = (id: string, commands: string[]): AgentManifest => ({
  id,
  commands,
  states: {},
});

describe("launchCommandFor", () => {
  it("uses the shipped map for bundled kinds", () => {
    expect(launchCommandFor("claude", BUNDLED_MANIFESTS)).toBe("claude");
    // cursor's manifest matches `cursor-agent`/`cursor`; the launch binary is cursor-agent.
    expect(launchCommandFor("cursor", BUNDLED_MANIFESTS)).toBe("cursor-agent");
  });

  it("falls back to a user-override manifest's first command token", () => {
    const custom = manifest("my-agent", ["my-agent-cli", "my-agent"]);
    expect(launchCommandFor("my-agent", [...BUNDLED_MANIFESTS, custom])).toBe("my-agent-cli");
  });

  it("falls back to the kind itself when nothing else is known", () => {
    expect(launchCommandFor("mystery", [])).toBe("mystery");
  });

  it("covers every bundled agent kind in the launch map (shell excluded)", () => {
    for (const m of BUNDLED_MANIFESTS) {
      if (m.id === "shell") continue;
      expect(AGENT_LAUNCH_COMMANDS[m.id], m.id).toBeTruthy();
    }
  });
});

describe("agentKindItems", () => {
  it("lists every manifest id except the shell catch-all, then the custom row last", () => {
    const items = agentKindItems(BUNDLED_MANIFESTS);
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("shell");
    expect(ids[ids.length - 1]).toBe(CUSTOM_KIND_ID);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(items).toHaveLength(BUNDLED_MANIFESTS.length - 1 + 1);
  });

  it("shows the launch command as the row detail", () => {
    const items = agentKindItems(BUNDLED_MANIFESTS);
    expect(items.find((i) => i.id === "cursor")?.detail).toBe("cursor-agent");
  });

  it("includes user-override manifests (the loader's merged list is the source)", () => {
    const items = agentKindItems([...BUNDLED_MANIFESTS, manifest("my-agent", ["my-agent"])]);
    expect(items.map((i) => i.id)).toContain("my-agent");
  });
});

describe("defaultSpawnPlacement", () => {
  it("splits right of a focused pane, else a window in the session, else a fresh session", () => {
    expect(defaultSpawnPlacement({ pane: true, session: true })).toBe("split-h");
    expect(defaultSpawnPlacement({ pane: false, session: true })).toBe("window");
    expect(defaultSpawnPlacement({ pane: false, session: false })).toBe("session");
  });
});

describe("compatiblePlacement", () => {
  it("splits need a pane, windows a session, a fresh session always works", () => {
    expect(compatiblePlacement("split-h", { pane: true, session: true })).toBe(true);
    expect(compatiblePlacement("split-h", { pane: false, session: true })).toBe(false);
    expect(compatiblePlacement("split-v", { pane: false, session: false })).toBe(false);
    expect(compatiblePlacement("window", { pane: false, session: true })).toBe(true);
    expect(compatiblePlacement("window", { pane: false, session: false })).toBe(false);
    expect(compatiblePlacement("session", { pane: false, session: false })).toBe(true);
  });
});

describe("placementActions", () => {
  it("offers ^w window / ^d split-below only where a pane exists (the default is split-right)", () => {
    expect(placementActions({ pane: true, session: true }).map((a) => a.key)).toEqual(["w", "d"]);
    expect(placementActions({ pane: false, session: true })).toEqual([]);
    expect(placementActions({ pane: false, session: false })).toEqual([]);
  });
});

describe("resolvePlacement", () => {
  it("maps the footer action keys, and keeps the fallback on plain enter", () => {
    expect(resolvePlacement("split-h", "w")).toBe("window");
    expect(resolvePlacement("split-h", "d")).toBe("split-v");
    expect(resolvePlacement("split-h", undefined)).toBe("split-h");
    expect(resolvePlacement("session", undefined)).toBe("session");
  });
});

describe("placementLabel", () => {
  it("names every placement in plain language", () => {
    expect(placementLabel("split-h")).toBe("split right");
    expect(placementLabel("split-v")).toBe("split below");
    expect(placementLabel("window")).toBe("new window");
    expect(placementLabel("session")).toBe("new session");
  });
});

describe("isSpawnWhere", () => {
  it("accepts the four placements and rejects everything else", () => {
    for (const p of ["window", "split-h", "split-v", "session"]) expect(isSpawnWhere(p)).toBe(true);
    expect(isSpawnWhere("pane")).toBe(false);
    expect(isSpawnWhere(3)).toBe(false);
    expect(isSpawnWhere(undefined)).toBe(false);
  });
});

describe("newAgentItems", () => {
  const last = { kind: "claude", command: "claude", placement: "split-h" as const };

  it("front-loads the again row (pre-selected at index 0) when a spawn is remembered", () => {
    const items = newAgentItems({ manifests: BUNDLED_MANIFESTS, last, customRecents: [] });
    expect(items[0]!.id).toBe(AGAIN_ID);
    expect(items[0]!.label).toBe("claude — again");
    expect(items[0]!.detail).toBe("split right");
  });

  it("labels a remembered custom spawn by its argv and shows the checked placement", () => {
    const items = newAgentItems({
      manifests: BUNDLED_MANIFESTS,
      last: { kind: CUSTOM_KIND_ID, command: "my-agent --x", placement: "split-h" },
      againPlacement: "window", // context lost its pane — the row says where it will REALLY go
      customRecents: [],
    });
    expect(items[0]!.label).toBe("my-agent --x — again");
    expect(items[0]!.detail).toBe("new window");
  });

  it("omits the again row without memory and keeps the kind list + custom row", () => {
    const items = newAgentItems({ manifests: BUNDLED_MANIFESTS, last: null, customRecents: [] });
    expect(items[0]!.id).not.toBe(AGAIN_ID);
    expect(items.map((i) => i.id)).toContain("claude");
    expect(items.map((i) => i.id)).toContain(CUSTOM_KIND_ID);
  });

  it("lists custom recents as selectable rows beneath the custom row", () => {
    const items = newAgentItems({
      manifests: BUNDLED_MANIFESTS,
      last: null,
      customRecents: ["my-agent --x", "other --y"],
    });
    const ids = items.map((i) => i.id);
    const customIdx = ids.indexOf(CUSTOM_KIND_ID);
    expect(ids[customIdx + 1]).toBe(customRecentId(0));
    expect(ids[customIdx + 2]).toBe(customRecentId(1));
    expect(items[customIdx + 1]!.label).toBe("my-agent --x");
    expect(customRecentIndex(customRecentId(1))).toBe(1);
    expect(customRecentIndex("claude")).toBeNull();
    expect(customRecentIndex(`${customRecentId(0)}x`)).toBeNull();
  });
});

describe("lastSpawnName", () => {
  it("names a kind spawn by kind and a custom spawn by its argv", () => {
    expect(lastSpawnName({ kind: "codex", command: "codex", placement: "window" })).toBe("codex");
    expect(lastSpawnName({ kind: CUSTOM_KIND_ID, command: "m --f", placement: "window" })).toBe(
      "m --f",
    );
  });
});

describe("spawnLabelFor", () => {
  it("labels kind spawns by kind and custom spawns by the command's basename", () => {
    expect(spawnLabelFor("claude", "claude")).toBe("claude");
    expect(spawnLabelFor(CUSTOM_KIND_ID, "/usr/local/bin/my-agent --flag")).toBe("my-agent");
    expect(spawnLabelFor(CUSTOM_KIND_ID, "  ")).toBe("agent");
  });
});

describe("spawnAgentArgs", () => {
  it("spawns a new window in the session (printing the pane id), with -c when the dir is known", () => {
    expect(spawnAgentArgs("window", { session: "web" }, "/proj", "claude")).toEqual([
      "new-window",
      "-t",
      "web:",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      "/proj",
      "claude",
    ]);
    expect(spawnAgentArgs("window", { session: "web" }, null, "claude")).toEqual([
      "new-window",
      "-t",
      "web:",
      "-P",
      "-F",
      "#{pane_id}",
      "claude",
    ]);
  });

  it("splits the concrete pane when one is given, else the session's active pane", () => {
    expect(spawnAgentArgs("split-h", { session: "web", paneId: "%3" }, "/proj", "codex")).toEqual([
      "split-window",
      "-h",
      "-t",
      "%3",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      "/proj",
      "codex",
    ]);
    expect(spawnAgentArgs("split-v", { session: "web" }, null, "codex")).toEqual([
      "split-window",
      "-v",
      "-t",
      "web:",
      "-P",
      "-F",
      "#{pane_id}",
      "codex",
    ]);
  });
});

describe("spawnSessionArgs", () => {
  it("creates a detached session running the command in the project dir, printing the pane id", () => {
    expect(spawnSessionArgs("api", "/proj", "claude")).toEqual([
      "new-session",
      "-d",
      "-s",
      "api",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      "/proj",
      "claude",
    ]);
    expect(spawnSessionArgs("api", null, "claude")).toEqual([
      "new-session",
      "-d",
      "-s",
      "api",
      "-P",
      "-F",
      "#{pane_id}",
      "claude",
    ]);
  });
});

describe("label + stamp argv (M24.1 auto-label)", () => {
  it("titles the spawned pane / names the spawned window after the agent", () => {
    expect(labelPaneArgs("%7", "claude")).toEqual(["select-pane", "-t", "%7", "-T", "claude"]);
    expect(labelWindowArgs("%7", "codex")).toEqual(["rename-window", "-t", "%7", "codex"]);
  });

  it("stamps the exact launch argv as a pane-local option", () => {
    expect(stampLaunchArgs("%7", "claude --resume abc")).toEqual([
      "set-option",
      "-p",
      "-t",
      "%7",
      "@agent_launch",
      "claude --resume abc",
    ]);
  });
});

describe("teamItems", () => {
  const agents: AgentRowInput[] = [
    { paneId: "%1", windowIndex: 0, session: "web", kind: "claude", state: "working", since: 970 },
    { paneId: "%2", windowIndex: 1, session: "api", kind: "codex", state: "blocked", since: null },
  ];

  it("pins + new agent first, then one row per fleet agent with state (+ dwell) detail", () => {
    const items = teamItems(agents, 1000);
    expect(items[0]!.id).toBe(TEAM_NEW_ID);
    expect(items[1]!.label).toBe("claude · web");
    expect(items[1]!.detail).toBe("working 30s"); // stamped → dwell shown
    expect(items[2]!.label).toBe("codex · api");
    expect(items[2]!.detail).toBe("blocked"); // scraped → bare state
    expect(teamAgentIndex(items[1]!.id)).toBe(0);
    expect(teamAgentIndex(items[2]!.id)).toBe(1);
    expect(teamAgentIndex(TEAM_NEW_ID)).toBeNull();
  });

  it("offers restart/stop as the footer ctrl-actions", () => {
    expect(TEAM_ACTIONS.map((a) => a.key)).toEqual(["r", "s"]);
  });

  it("a stamped display name replaces the kind in the row label (M25.4)", () => {
    const named: AgentRowInput[] = [{ ...agents[0]!, displayName: "reviewer" }];
    expect(teamItems(named, 1000)[1]!.label).toBe("reviewer · web");
  });
});

describe("isShellCommand", () => {
  it("recognizes the shell manifest's commands plus common extras", () => {
    for (const sh of ["zsh", "bash", "sh", "fish", "nu", "dash", "ksh", "tcsh"]) {
      expect(isShellCommand(sh, BUNDLED_MANIFESTS), sh).toBe(true);
    }
  });

  it("strips login-shell dashes and paths", () => {
    expect(isShellCommand("-zsh", BUNDLED_MANIFESTS)).toBe(true);
    expect(isShellCommand("/bin/bash", BUNDLED_MANIFESTS)).toBe(true);
  });

  it("says no for agent processes (they ARE the pane command — respawn path)", () => {
    expect(isShellCommand("claude", BUNDLED_MANIFESTS)).toBe(false);
    expect(isShellCommand("python3.13", BUNDLED_MANIFESTS)).toBe(false);
    expect(isShellCommand("node", BUNDLED_MANIFESTS)).toBe(false);
  });
});

describe("paneHostsShell", () => {
  it("an empty start command is tmux's default shell — every plain user pane", () => {
    expect(paneHostsShell("", BUNDLED_MANIFESTS)).toBe(true);
    expect(paneHostsShell("  ", BUNDLED_MANIFESTS)).toBe(true);
  });

  it("an explicit shell start command still hosts a shell", () => {
    expect(paneHostsShell("zsh", BUNDLED_MANIFESTS)).toBe(true);
    expect(paneHostsShell("/bin/zsh -l", BUNDLED_MANIFESTS)).toBe(true);
  });

  it("an agent start command means the pane dies with the process — respawn path", () => {
    expect(paneHostsShell("aider", BUNDLED_MANIFESTS)).toBe(false);
    expect(paneHostsShell("claude --resume abc123", BUNDLED_MANIFESTS)).toBe(false);
  });
});

describe("respawnArgs", () => {
  it("kills and relaunches the pane in place, pinning the cwd explicitly", () => {
    expect(respawnArgs("%7", "claude", "/proj")).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "%7",
      "-c",
      "/proj",
      "claude",
    ]);
    expect(respawnArgs("%7", "claude", null)).toEqual(["respawn-pane", "-k", "-t", "%7", "claude"]);
  });
});

describe("stop/restart argv", () => {
  it("interrupts via send-keys C-c", () => {
    expect(interruptArgs("%7")).toEqual(["send-keys", "-t", "%7", "C-c"]);
  });

  it("relaunches as literal text then a real Enter key (two calls — -l must not eat Enter)", () => {
    expect(relaunchArgs("%7", "claude --resume")).toEqual([
      ["send-keys", "-t", "%7", "-l", "claude --resume"],
      ["send-keys", "-t", "%7", "Enter"],
    ]);
  });

  it("clears BOTH authority stamps pane-locally (the SessionEnd-equivalent hygiene)", () => {
    expect(clearAuthorityArgs("%7")).toEqual([
      ["set-option", "-p", "-t", "%7", "-u", "@agent_state"],
      ["set-option", "-p", "-t", "%7", "-u", "@agent_session_id"],
    ]);
  });
});
