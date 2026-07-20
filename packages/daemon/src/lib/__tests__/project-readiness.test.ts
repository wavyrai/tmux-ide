import { describe, expect, it } from "vitest";
import {
  classifyProjectReadiness,
  type ProjectReadinessHarnessProbe,
  type ProjectReadinessProbe,
} from "../project-readiness.ts";

function harness(
  overrides: Partial<ProjectReadinessHarnessProbe> = {},
): ProjectReadinessHarnessProbe {
  return {
    id: "codex",
    kind: "codex",
    label: "Codex",
    command: ["codex"],
    installation: "available",
    commandReadiness: "ready",
    authentication: "ready",
    source: "detected",
    ...overrides,
  };
}

function cleanProbe(overrides: Partial<ProjectReadinessProbe> = {}): ProjectReadinessProbe {
  return {
    project: {
      requestedPath: "/work/tmux-ide",
      root: "/work/tmux-ide",
      name: "tmux-ide",
      identityKey: "git-a1b2c3",
      identitySource: "git-common-dir",
      exists: true,
      isDirectory: true,
      registration: "current",
    },
    platform: { os: "darwin", arch: "arm64" },
    git: { availability: "available", version: "2.50.0", repository: true },
    tmux: { availability: "available", version: "3.5a" },
    shell: { availability: "available", command: ["/bin/zsh"] },
    harnesses: [harness()],
    ...overrides,
  };
}

function issueCodes(result: ReturnType<typeof classifyProjectReadiness>): string[] {
  return result.issues.map((issue) => issue.code);
}

describe("classifyProjectReadiness", () => {
  it("classifies a clean project and recommends a config-free agent workbench", () => {
    const result = classifyProjectReadiness(cleanProbe());

    expect(result.status).toBe("ready");
    expect(result.canLaunch).toBe(true);
    expect(result.project).toEqual({
      requestedPath: "/work/tmux-ide",
      root: "/work/tmux-ide",
      name: "tmux-ide",
      identityKey: "git-a1b2c3",
      identitySource: "git-common-dir",
      registration: "current",
    });
    expect(result.capabilities).toEqual({
      platform: "supported",
      git: "ready",
      tmux: "ready",
      shell: "ready",
      agentHarness: "ready",
    });
    expect(result.issues).toEqual([]);
    expect(result.recoveryActions).toEqual([]);
    expect(result.recommendedLaunchPlan).toEqual({
      source: "config-free-default",
      mode: "agent-workbench",
      projectRoot: "/work/tmux-ide",
      selectedHarnessId: "codex",
      panes: [
        {
          id: "agent-1",
          title: "Codex",
          role: "agent",
          harnessId: "codex",
          command: ["codex"],
          focus: true,
        },
        {
          id: "shell",
          title: "Shell",
          role: "shell",
          harnessId: "shell",
          command: ["/bin/zsh"],
          focus: false,
        },
      ],
      configRequired: false,
    });
  });

  it("degrades cleanly when Git is unavailable without blocking launch", () => {
    const result = classifyProjectReadiness(
      cleanProbe({ git: { availability: "missing", repository: null } }),
    );

    expect(result.status).toBe("needs-attention");
    expect(result.canLaunch).toBe(true);
    expect(result.capabilities.git).toBe("degraded");
    expect(result.blockingIssues).toEqual([]);
    expect(issueCodes(result)).toContain("GIT_MISSING");
    expect(result.recoveryActions).toContainEqual(
      expect.objectContaining({
        issueId: "issue:git_missing:project",
        kind: "install-tool",
        target: "git",
        label: "Install Git",
      }),
    );
    expect(result.recommendedLaunchPlan.mode).toBe("agent-workbench");
  });

  it("offers Git initialization for a non-repository project", () => {
    const result = classifyProjectReadiness(
      cleanProbe({ git: { availability: "available", repository: false } }),
    );

    expect(result.canLaunch).toBe(true);
    expect(result.capabilities.git).toBe("degraded");
    expect(issueCodes(result)).toContain("NOT_GIT_REPOSITORY");
    expect(result.recoveryActions).toContainEqual(
      expect.objectContaining({
        kind: "initialize-git",
        command: ["git", "init"],
      }),
    );
  });

  it("falls back to a useful shell-only workspace when no agent harness is detected", () => {
    const result = classifyProjectReadiness(cleanProbe({ harnesses: [] }));

    expect(result.status).toBe("needs-attention");
    expect(result.canLaunch).toBe(true);
    expect(result.capabilities.agentHarness).toBe("missing");
    expect(issueCodes(result)).toEqual(["NO_AGENT_HARNESS"]);
    expect(result.recommendedLaunchPlan).toMatchObject({
      mode: "terminal-workspace",
      selectedHarnessId: "shell",
      configRequired: false,
    });
    expect(result.recommendedLaunchPlan.panes).toEqual([
      expect.objectContaining({ role: "shell", command: ["/bin/zsh"], focus: true }),
    ]);
    expect(result.recoveryActions).toContainEqual(
      expect.objectContaining({ kind: "choose-harness", target: "harness" }),
    );
  });

  it("uses a ready harness when other detected harnesses are only partially ready", () => {
    const result = classifyProjectReadiness(
      cleanProbe({
        harnesses: [
          harness({
            id: "codex",
            installation: "missing",
            installCommand: ["npm", "install", "-g", "@openai/codex"],
          }),
          harness({
            id: "claude",
            kind: "claude",
            label: "Claude Code",
            command: ["claude"],
          }),
          harness({
            id: "opencode",
            kind: "opencode",
            label: "OpenCode",
            command: ["opencode"],
            authentication: "required",
            authCommand: ["opencode", "auth", "login"],
          }),
        ],
      }),
    );

    expect(result.canLaunch).toBe(true);
    expect(result.status).toBe("needs-attention");
    expect(result.recommendedLaunchPlan.selectedHarnessId).toBe("claude");
    expect(result.harnesses.map(({ id, state }) => [id, state])).toEqual([
      ["shell", "ready"],
      ["codex", "install-required"],
      ["claude", "ready"],
      ["opencode", "auth-required"],
    ]);
    expect(issueCodes(result)).toEqual(["HARNESS_INSTALL_REQUIRED", "HARNESS_AUTH_REQUIRED"]);
    expect(result.recoveryActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "install-harness",
          harnessId: "codex",
          command: ["npm", "install", "-g", "@openai/codex"],
        }),
        expect.objectContaining({
          kind: "authenticate-harness",
          harnessId: "opencode",
          command: ["opencode", "auth", "login"],
        }),
      ]),
    );
  });

  it("accepts a user-selected custom command without provider assumptions", () => {
    const custom = harness({
      id: "acme-agent",
      kind: "custom",
      label: "Acme Agent",
      command: ["acme-agent", "run", "--interactive"],
      authentication: "not-required",
      source: "user",
    });
    const result = classifyProjectReadiness(
      cleanProbe({
        harnesses: [harness({ id: "claude", kind: "claude", label: "Claude Code" }), custom],
        preferredHarnessId: "acme-agent",
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.recommendedLaunchPlan.selectedHarnessId).toBe("acme-agent");
    expect(result.recommendedLaunchPlan.panes[0]).toEqual(
      expect.objectContaining({
        title: "Acme Agent",
        harnessId: "acme-agent",
        command: ["acme-agent", "run", "--interactive"],
      }),
    );
  });

  it("classifies install, authentication, command, and verification failures independently", () => {
    const result = classifyProjectReadiness(
      cleanProbe({
        harnesses: [
          harness({ id: "codex", installation: "unknown" }),
          harness({
            id: "claude",
            kind: "claude",
            label: "Claude Code",
            authentication: "unknown",
          }),
          harness({
            id: "opencode",
            kind: "opencode",
            label: "OpenCode",
            commandReadiness: "invalid",
          }),
          harness({
            id: "custom",
            kind: "custom",
            label: "Custom",
            commandReadiness: "unknown",
          }),
        ],
      }),
    );

    expect(result.canLaunch).toBe(true);
    expect(result.capabilities.agentHarness).toBe("unverified");
    expect(result.harnesses.map(({ id, state }) => [id, state])).toEqual([
      ["shell", "ready"],
      ["codex", "install-unverified"],
      ["claude", "auth-unverified"],
      ["opencode", "command-invalid"],
      ["custom", "command-unverified"],
    ]);
    expect(issueCodes(result)).toEqual([
      "HARNESS_INSTALL_UNVERIFIED",
      "HARNESS_AUTH_UNVERIFIED",
      "HARNESS_COMMAND_INVALID",
      "HARNESS_COMMAND_UNVERIFIED",
      "NO_AGENT_HARNESS",
    ]);
    expect(result.recommendedLaunchPlan.mode).toBe("terminal-workspace");
  });

  it("distinguishes a stale registered project from an unknown missing path", () => {
    const stale = classifyProjectReadiness(
      cleanProbe({
        project: {
          ...cleanProbe().project,
          root: null,
          exists: false,
          isDirectory: false,
          registration: "stale",
        },
      }),
    );
    const missing = classifyProjectReadiness(
      cleanProbe({
        project: {
          ...cleanProbe().project,
          root: null,
          name: null,
          identityKey: null,
          identitySource: null,
          exists: false,
          isDirectory: false,
          registration: "unregistered",
        },
      }),
    );

    expect(stale.status).toBe("blocked");
    expect(issueCodes(stale)).toContain("PROJECT_REGISTRATION_STALE");
    expect(stale.recoveryActions.map((action) => action.kind)).toEqual(
      expect.arrayContaining(["relink-project", "remove-stale-project"]),
    );
    expect(missing.status).toBe("blocked");
    expect(issueCodes(missing)).toContain("PROJECT_NOT_FOUND");
    expect(missing.recoveryActions).toContainEqual(
      expect.objectContaining({ kind: "choose-project" }),
    );
    for (const result of [stale, missing]) {
      expect(result.canLaunch).toBe(false);
      expect(result.recommendedLaunchPlan).toMatchObject({
        mode: "unavailable",
        panes: [],
        configRequired: false,
      });
    }
  });

  it("blocks a file path and supplies a directory recovery action", () => {
    const result = classifyProjectReadiness(
      cleanProbe({ project: { ...cleanProbe().project, isDirectory: false } }),
    );

    expect(result.canLaunch).toBe(false);
    expect(issueCodes(result)).toContain("PROJECT_NOT_DIRECTORY");
    expect(result.recoveryActions).toContainEqual(
      expect.objectContaining({ kind: "choose-project", label: "Choose a project directory" }),
    );
  });

  it("makes unsupported platforms and missing tmux hard launch constraints", () => {
    const unsupported = classifyProjectReadiness(
      cleanProbe({ platform: { os: "win32", arch: "x64" } }),
    );
    const noTmux = classifyProjectReadiness(cleanProbe({ tmux: { availability: "missing" } }));

    expect(unsupported.capabilities.platform).toBe("unsupported");
    expect(unsupported.status).toBe("blocked");
    expect(issueCodes(unsupported)).toContain("PLATFORM_UNSUPPORTED");
    expect(unsupported.recoveryActions).toContainEqual(
      expect.objectContaining({ kind: "view-platform-support", target: "platform" }),
    );
    expect(noTmux.capabilities.tmux).toBe("missing");
    expect(noTmux.status).toBe("blocked");
    expect(issueCodes(noTmux)).toContain("TMUX_MISSING");
    expect(noTmux.recoveryActions).toContainEqual(
      expect.objectContaining({ kind: "install-tool", target: "tmux" }),
    );
  });

  it("blocks an unavailable shell and does not expose a misleading launch plan", () => {
    const result = classifyProjectReadiness(
      cleanProbe({ shell: { availability: "missing", command: ["/missing/fish"] } }),
    );

    expect(result.status).toBe("blocked");
    expect(result.capabilities.shell).toBe("missing");
    expect(issueCodes(result)).toContain("SHELL_MISSING");
    expect(result.recommendedLaunchPlan.mode).toBe("unavailable");
    expect(result.recommendedLaunchPlan.panes).toEqual([]);
  });

  it("reserves the shell identity and reports duplicate harness profiles deterministically", () => {
    const result = classifyProjectReadiness(
      cleanProbe({
        harnesses: [
          harness({ id: "shell", kind: "custom", label: "Not Shell", command: ["agent"] }),
          harness(),
          harness({ id: "codex", label: "Duplicate Codex" }),
        ],
      }),
    );

    expect(result.harnesses.map((item) => item.id)).toEqual(["shell", "codex"]);
    expect(issueCodes(result)).toEqual(["DUPLICATE_HARNESS_ID", "DUPLICATE_HARNESS_ID"]);
    expect(result.recommendedLaunchPlan.selectedHarnessId).toBe("codex");
  });
});
