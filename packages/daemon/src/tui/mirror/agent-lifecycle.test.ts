import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../detect/manifest.ts";
import { BUNDLED_MANIFESTS } from "../detect/manifests.ts";
import {
  AGENT_LAUNCH_COMMANDS,
  CUSTOM_KIND_ID,
  agentKindItems,
  clearAuthorityArgs,
  interruptArgs,
  isShellCommand,
  launchCommandFor,
  paneHostsShell,
  placementItems,
  relaunchArgs,
  respawnArgs,
  spawnAgentArgs,
  spawnSessionArgs,
} from "./agent-lifecycle.ts";

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

describe("placementItems", () => {
  it("offers splits only when there is a pane to split", () => {
    expect(placementItems({ split: false }).map((i) => i.id)).toEqual(["window"]);
    expect(placementItems({ split: true }).map((i) => i.id)).toEqual([
      "window",
      "split-h",
      "split-v",
    ]);
  });
});

describe("spawnAgentArgs", () => {
  it("spawns a new window in the session, with -c when the dir is known", () => {
    expect(spawnAgentArgs("window", { session: "web" }, "/proj", "claude")).toEqual([
      "new-window",
      "-t",
      "web:",
      "-c",
      "/proj",
      "claude",
    ]);
    expect(spawnAgentArgs("window", { session: "web" }, null, "claude")).toEqual([
      "new-window",
      "-t",
      "web:",
      "claude",
    ]);
  });

  it("splits the concrete pane when one is given, else the session's active pane", () => {
    expect(spawnAgentArgs("split-h", { session: "web", paneId: "%3" }, "/proj", "codex")).toEqual([
      "split-window",
      "-h",
      "-t",
      "%3",
      "-c",
      "/proj",
      "codex",
    ]);
    expect(spawnAgentArgs("split-v", { session: "web" }, null, "codex")).toEqual([
      "split-window",
      "-v",
      "-t",
      "web:",
      "codex",
    ]);
  });
});

describe("spawnSessionArgs", () => {
  it("creates a detached session running the command in the project dir", () => {
    expect(spawnSessionArgs("api", "/proj", "claude")).toEqual([
      "new-session",
      "-d",
      "-s",
      "api",
      "-c",
      "/proj",
      "claude",
    ]);
    expect(spawnSessionArgs("api", null, "claude")).toEqual([
      "new-session",
      "-d",
      "-s",
      "api",
      "claude",
    ]);
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
