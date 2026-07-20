import { describe, expect, it } from "vitest";
import {
  assessProjectReadiness as publicAssessProjectReadiness,
  probeProjectReadiness as publicProbeProjectReadiness,
} from "../../index.ts";
import {
  assessProjectReadiness,
  probeProjectReadiness,
  type ProjectReadinessProbeIo,
  type ReadinessCommandOptions,
  type ReadinessCommandResult,
  type ReadinessPathKind,
} from "../project-readiness-probe.ts";
import type { Availability } from "../project-readiness.ts";

interface CommandCall {
  executable: string;
  argv: readonly string[];
  options: ReadinessCommandOptions;
}

interface FakeIoOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: { os: NodeJS.Platform; arch: string };
  inspectPath?: (path: string) => ReadinessPathKind;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  isExecutable?: (path: string) => Availability;
  runCommand?: (call: CommandCall) => Promise<ReadinessCommandResult>;
}

function defaultCommand(call: CommandCall): ReadinessCommandResult {
  const binary = call.executable.split("/").at(-1) ?? call.executable;
  if (binary === "git" && call.argv.includes("--show-toplevel")) {
    return { status: "failure", stderr: "fatal: not a git repository", exitCode: 128 };
  }
  if (binary === "git" && call.argv.includes("--git-common-dir")) {
    return { status: "failure", stderr: "fatal: not a git repository", exitCode: 128 };
  }
  if (binary === "git" && call.argv.includes("--is-inside-work-tree")) {
    return { status: "failure", stderr: "fatal: not a git repository", exitCode: 128 };
  }
  const version =
    binary === "tmux" ? "tmux 3.5a" : binary === "git" ? "git version 2.50.0" : `${binary} 1.0.0`;
  return { status: "success", stdout: `${version}\n`, exitCode: 0 };
}

function createFakeIo(options: FakeIoOptions = {}): {
  io: ProjectReadinessProbeIo;
  calls: CommandCall[];
} {
  const calls: CommandCall[] = [];
  const executables = new Set([
    "/usr/bin/git",
    "/usr/bin/tmux",
    "/opt/bin/codex",
    "/opt/bin/claude",
    "/opt/bin/opencode",
    "/bin/zsh",
    "/bin/sh",
  ]);
  const io: ProjectReadinessProbeIo = {
    cwd: () => options.cwd ?? "/cwd",
    environment: () => options.environment ?? { PATH: "/usr/bin:/opt/bin:/bin", SHELL: "/bin/zsh" },
    platform: () => options.platform ?? { os: "darwin", arch: "arm64" },
    inspectPath: options.inspectPath ?? (() => "directory"),
    exists: options.exists ?? (() => false),
    realpath: options.realpath ?? ((path) => path),
    isExecutable:
      options.isExecutable ?? ((path) => (executables.has(path) ? "available" : "missing")),
    runCommand: async (executable, argv, commandOptions) => {
      const call = { executable, argv: [...argv], options: commandOptions };
      calls.push(call);
      return options.runCommand ? options.runCommand(call) : defaultCommand(call);
    },
  };
  return { io, calls };
}

function gitWorktreeCommand(call: CommandCall): ReadinessCommandResult {
  if (call.argv.includes("--show-toplevel")) {
    return {
      status: "success",
      stdout: call.argv[1]!.startsWith("/worktrees/feature") ? "/worktrees/feature\n" : "/repo\n",
    };
  }
  if (call.argv.includes("--git-common-dir")) {
    return { status: "success", stdout: "/repo/.git\n" };
  }
  if (call.argv.includes("--is-inside-work-tree")) {
    return { status: "success", stdout: "true\n" };
  }
  return defaultCommand(call);
}

describe("project readiness probe adapter", () => {
  it("is exported through the public daemon entry point", () => {
    expect(publicProbeProjectReadiness).toBe(probeProjectReadiness);
    expect(publicAssessProjectReadiness).toBe(assessProjectReadiness);
  });

  it("shares Git common-dir identity across a main checkout and linked worktree", async () => {
    const { io, calls } = createFakeIo({ runCommand: async (call) => gitWorktreeCommand(call) });

    const main = await probeProjectReadiness("/repo", { io });
    const linked = await probeProjectReadiness("/worktrees/feature/src", { io });

    expect(main.project.root).toBe("/repo");
    expect(linked.project.root).toBe("/worktrees/feature");
    expect(main.project.identitySource).toBe("git-common-dir");
    expect(linked.project.identitySource).toBe("git-common-dir");
    expect(linked.project.identityKey).toBe(main.project.identityKey);
    expect(main.git.repository).toBe(true);
    expect(linked.git.repository).toBe(true);
    expect(calls).toContainEqual(
      expect.objectContaining({
        executable: "/usr/bin/git",
        argv: ["-C", "/repo", "rev-parse", "--show-toplevel"],
      }),
    );
    expect(calls.every((call) => Array.isArray(call.argv))).toBe(true);
  });

  it("uses canonical realpath identity without Git or a config file", async () => {
    const { io } = createFakeIo({
      realpath: (path) => (path === "/alias/project" ? "/actual/project" : path),
      isExecutable: (path) => (path === "/bin/zsh" ? "available" : "missing"),
    });

    const probe = await probeProjectReadiness("/alias/project", { io });

    expect(probe.project).toMatchObject({
      root: "/actual/project",
      name: "project",
      identitySource: "canonical-realpath",
      exists: true,
      isDirectory: true,
    });
    expect(probe.project.identityKey).toMatch(/^path-[a-f0-9]{64}$/u);
    expect(probe.harnesses.map((harness) => harness.installation)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
  });

  it("gives symlink aliases one canonical non-Git identity", async () => {
    const { io } = createFakeIo({
      realpath: (path) => (path === "/alias-a" || path === "/alias-b" ? "/actual/project" : path),
      isExecutable: (path) => (path === "/bin/zsh" ? "available" : "missing"),
    });

    const left = await probeProjectReadiness("/alias-a", { io });
    const right = await probeProjectReadiness("/alias-b", { io });

    expect(left.project.root).toBe("/actual/project");
    expect(right.project.root).toBe("/actual/project");
    expect(left.project.identityKey).toBe(right.project.identityKey);
  });

  it("blocks missing and malformed canonical paths without fabricating identity", async () => {
    const missingIo = createFakeIo({ inspectPath: () => "missing" }).io;
    const malformedIo = createFakeIo({ realpath: () => "/bad\npath" }).io;

    const missing = await assessProjectReadiness("/missing", { io: missingIo });
    const malformed = await assessProjectReadiness("/malformed", { io: malformedIo });

    expect(missing.project).toMatchObject({ root: null, identityKey: null });
    expect(missing.blockingIssues.map((issue) => issue.code)).toContain("PROJECT_NOT_FOUND");
    expect(malformed.project).toMatchObject({ root: null, identityKey: null });
    expect(malformed.blockingIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["PROJECT_ROOT_UNRESOLVED", "PROJECT_IDENTITY_UNRESOLVED"]),
    );
    expect(malformed.recommendedLaunchPlan.configRequired).toBe(false);
  });

  it("reports PATH-dependent tools as unknown while retaining an absolute shell fallback", async () => {
    const { io, calls } = createFakeIo({
      environment: {},
      isExecutable: (path) => (path === "/bin/sh" ? "available" : "unknown"),
    });

    const probe = await probeProjectReadiness("/project", { io });

    expect(probe.git.availability).toBe("unknown");
    expect(probe.tmux.availability).toBe("unknown");
    expect(probe.shell).toMatchObject({ availability: "available", command: ["/bin/sh"] });
    expect(probe.harnesses.map((harness) => harness.installation)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(calls).toEqual([]);
  });

  it("keeps built-in harnesses in Codex, Claude Code, OpenCode order", async () => {
    const { io } = createFakeIo();
    const result = await assessProjectReadiness("/project", {
      io,
      authentication: { codex: "ready", claude: "ready", opencode: "ready" },
    });

    expect(result.harnesses.map(({ id, version }) => [id, version])).toEqual([
      ["shell", null],
      ["codex", "codex 1.0.0"],
      ["claude", "claude 1.0.0"],
      ["opencode", "opencode 1.0.0"],
    ]);
    expect(result.recommendedLaunchPlan.selectedHarnessId).toBe("codex");
    expect(result.recommendedLaunchPlan.configRequired).toBe(false);
  });

  it("preserves custom argv and never executes the custom launch command", async () => {
    const { io, calls } = createFakeIo({
      isExecutable: (path) =>
        path === "/opt/bin/acme-agent" ||
        [
          "/usr/bin/git",
          "/usr/bin/tmux",
          "/opt/bin/codex",
          "/opt/bin/claude",
          "/opt/bin/opencode",
          "/bin/zsh",
        ].includes(path)
          ? "available"
          : "missing",
    });

    const result = await assessProjectReadiness("/project", {
      io,
      preferredHarnessId: "acme",
      customHarnesses: [
        {
          id: "acme",
          label: "Acme Agent",
          command: ["acme-agent", "run", "--interactive"],
          authentication: "not-required",
          commandReadiness: "ready",
          version: "4.2.0",
        },
      ],
    });

    const custom = result.harnesses.find((harness) => harness.id === "acme");
    expect(custom).toMatchObject({
      command: ["acme-agent", "run", "--interactive"],
      version: "4.2.0",
      usable: true,
    });
    expect(result.recommendedLaunchPlan.selectedHarnessId).toBe("acme");
    expect(calls.some((call) => call.executable.endsWith("/acme-agent"))).toBe(false);
    expect(calls.every((call) => !call.argv.includes("login"))).toBe(true);
  });

  it("times out hanging probes and treats failures/authentication conservatively", async () => {
    const { io, calls } = createFakeIo({
      runCommand: async (call) => {
        if (call.executable.endsWith("/codex")) {
          return new Promise<ReadinessCommandResult>(() => {});
        }
        if (call.executable.endsWith("/claude")) {
          return { status: "failure", stderr: "version unavailable", exitCode: 1 };
        }
        return defaultCommand(call);
      },
    });

    const started = Date.now();
    const probe = await probeProjectReadiness("/project", { io, timeoutMs: 10 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      probe.harnesses.map(({ id, commandReadiness, authentication }) => ({
        id,
        commandReadiness,
        authentication,
      })),
    ).toEqual([
      { id: "codex", commandReadiness: "unknown", authentication: "unknown" },
      { id: "claude", commandReadiness: "unknown", authentication: "unknown" },
      { id: "opencode", commandReadiness: "ready", authentication: "unknown" },
    ]);
    expect(calls.every((call) => !call.argv.some((arg) => /auth|login/iu.test(arg)))).toBe(true);
    expect(calls.every((call) => call.options.timeoutMs === 10)).toBe(true);
  });

  it("normalizes a missing registered folder to stale without running project commands", async () => {
    const { io, calls } = createFakeIo({ inspectPath: () => "missing" });

    const probe = await probeProjectReadiness("/moved", { io, registration: "current" });

    expect(probe.project.registration).toBe("stale");
    expect(probe.project.root).toBeNull();
    expect(calls.some((call) => call.argv.includes("--is-inside-work-tree"))).toBe(false);
  });
});
