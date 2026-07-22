import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePaneCreateMutationRequest } from "@tmux-ide/contracts";

import {
  WorkspacePaneCreationAuthority,
  WorkspacePaneCreationError,
  type WorkspacePaneCreationIo,
} from "../workspace-pane-creation.ts";
import { WorkspaceRegistry } from "../workspace-registry.ts";

const DAEMON = "20000000-0000-4000-8000-000000000002";
const OPERATION = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(
  overrides: Partial<WorkspacePaneCreateMutationRequest> = {},
): WorkspacePaneCreateMutationRequest {
  return {
    operationId: OPERATION,
    expectedDaemonInstanceId: DAEMON,
    intent: { kind: "terminal", workspaceName: "workspace.alpha" },
    ...overrides,
  };
}

class FakeTmux {
  readonly calls: string[][] = [];
  readonly options = new Map<string, string>();
  paneId = "%7";
  windowId = "@3";
  exists = false;
  failOption: string | null = null;
  mutateOwnerOnFailure = false;
  windowName = "";
  paneCount = 1;
  readonly missingTargets = new Set<string>();
  malformedCreateOutput = false;
  throwAfterCreate = false;
  failRecoveryInventory = false;
  failCleanupProof = false;
  creations = 0;

  run = (args: readonly string[]): string => {
    const owned = [...args];
    this.calls.push(owned);
    switch (args[0]) {
      case "has-session":
        return "";
      case "new-window":
        this.creations += 1;
        this.paneId = `%${6 + this.creations}`;
        this.windowId = `@${2 + this.creations}`;
        this.exists = true;
        this.options.clear();
        this.windowName = args[args.indexOf("-n") + 1]!;
        this.paneCount = 1;
        if (this.throwAfterCreate) throw new Error("uncertain create failure");
        return this.malformedCreateOutput ? "malformed" : `${this.paneId}\t${this.windowId}`;
      case "set-option": {
        const option = args.at(-2)!;
        const value = args.at(-1)!;
        if (option === this.failOption) {
          if (this.mutateOwnerOnFailure) this.options.set("@tmux_ide_creation_id", "external");
          throw new Error("injected tmux failure");
        }
        this.options.set(option, value);
        return "";
      }
      case "display-message": {
        if (this.failCleanupProof) throw new Error("temporary tmux failure");
        if (!this.exists) throw new Error("missing");
        const target = args[args.indexOf("-t") + 1];
        if (target && this.missingTargets.has(target)) throw new Error("missing target");
        if (target === `=${this.windowId}`) return this.windowId;
        return [
          this.paneId,
          this.windowId,
          this.options.get("@tmux_ide_pane_id") ?? "",
          this.options.get("@tmux_ide_creation_id") ?? "",
          this.options.get("@ide_type") ?? "",
          this.options.get("@ide_role") ?? "",
          this.options.get("@ide_name") ?? "",
          this.options.get("@tmux_ide_harness") ?? "",
          this.options.get("@tmux_ide_mission") ?? "",
          this.windowName,
        ].join("\t");
      }
      case "list-panes":
        if (args.includes("-s")) {
          if (!this.exists) return "";
          return [
            this.paneId,
            this.windowId,
            this.options.get("@tmux_ide_creation_id") ?? "",
            this.options.get("@tmux_ide_pane_id") ?? "",
          ].join("\t");
        }
        if (this.failCleanupProof) throw new Error("temporary tmux failure");
        if (!this.exists) throw new Error("missing");
        if (args.includes("-t")) {
          const target = args[args.indexOf("-t") + 1];
          if (target && this.missingTargets.has(target)) throw new Error("missing target");
        }
        if (args.at(-1) === "#{pane_id}\t#{window_panes}") {
          return `${this.paneId}\t${this.paneCount}`;
        }
        if (args.at(-1) === "#{pane_id}\t#{window_id}") {
          return `${this.paneId}\t${this.windowId}`;
        }
        return [
          this.paneId,
          this.options.get("@tmux_ide_creation_id") ?? "",
          this.windowName,
          String(this.paneCount),
        ].join("\t");
      case "list-windows":
        if (this.failRecoveryInventory && this.creations > 0) {
          throw new Error("temporary recovery failure");
        }
        if (!this.exists) return "";
        return [this.windowId, this.windowName, String(this.paneCount), this.paneId].join("\t");
      case "rename-window":
        this.windowName = args.at(-1)!;
        return "";
      case "kill-window":
        if (!this.exists) throw new Error("missing");
        this.exists = false;
        return "";
      default:
        throw new Error(`unexpected tmux command ${String(args[0])}`);
    }
  };
}

function rig(
  options: {
    fake?: FakeTmux;
    resolveHarness?: WorkspacePaneCreationIo["resolveHarness"];
    resolveMission?: WorkspacePaneCreationIo["resolveMission"];
    maxPendingOperations?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-pane-create-"));
  roots.push(root);
  const registry = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
  registry.add({
    name: "workspace.alpha",
    sessionName: "runtime-session",
    projectDir: root,
  });
  const fake = options.fake ?? new FakeTmux();
  const resolveHarness =
    options.resolveHarness ??
    vi.fn(async () => ({
      id: "codex",
      label: "Codex",
      command: ["/opt/bin/codex", "--approval-mode", "safe"],
      environment: { LANG: "en_US.UTF-8", TMUX_IDE_ROLE: "worker" },
    }));
  const authority = new WorkspacePaneCreationAuthority({
    daemonInstanceId: DAEMON,
    registry,
    io: {
      canonicalProjectDir: () => "/canonical/project",
      runTmux: fake.run,
      resolveHarness,
      resolveMission: options.resolveMission ?? (async (_workspace, _root, missionId) => missionId),
      isMissingTmuxTarget: (error) => (error as Error).message.includes("missing"),
      creationFailureCannotHaveMutated: () => false,
    },
    maxPendingOperations: options.maxPendingOperations,
  });
  return { authority, fake, registry, resolveHarness };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof WorkspacePaneCreationError ? error.code : undefined;
}

describe("WorkspacePaneCreationAuthority", () => {
  it("creates a terminal from canonical daemon-owned facts and returns semantic identity only", async () => {
    const { authority, fake } = rig();
    const result = await authority.create(request());

    expect(result).toEqual({
      operationId: OPERATION,
      daemonInstanceId: DAEMON,
      outcome: "created",
      resource: {
        resourceVersion: 1,
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.10000000000040008000000000000001",
        kind: "terminal",
        displayTitle: "Terminal",
        harnessProfileId: null,
        role: null,
        missionId: null,
      },
    });
    expect(fake.calls.find((call) => call[0] === "new-window")).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{window_id}",
      "-t",
      "=runtime-session:",
      "-c",
      "/canonical/project",
      "-n",
      "tmux-ide-100000000000400080000000",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/paneId|windowId|sessionName|cwd|argv|env/u);
  });

  it("resolves an allowed agent profile and passes only its daemon-owned argv and environment", async () => {
    const { authority, fake, resolveHarness } = rig();
    const result = await authority.create(
      request({
        intent: {
          kind: "agent",
          workspaceName: "workspace.alpha",
          displayTitle: "Implementer",
          harnessProfileId: "codex",
          role: "implementer",
          missionId: "mis_alpha",
        },
      }),
    );
    expect(resolveHarness).toHaveBeenCalledWith(
      expect.objectContaining({ name: "workspace.alpha", projectDir: expect.any(String) }),
      "/canonical/project",
      "codex",
    );
    const create = fake.calls.find((call) => call[0] === "new-window")!;
    expect(create).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{window_id}",
      "-t",
      "=runtime-session:",
      "-c",
      "/canonical/project",
      "-n",
      "tmux-ide-100000000000400080000000",
      "-e",
      "LANG=en_US.UTF-8",
      "-e",
      "TMUX_IDE_ROLE=worker",
      "'/opt/bin/codex' '--approval-mode' 'safe'",
    ]);
    expect(result.resource).toMatchObject({
      kind: "agent",
      harnessProfileId: "codex",
      role: "implementer",
      missionId: "mis_alpha",
    });
  });

  it("loads a workspace-defined harness capability without accepting renderer command data", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-pane-create-config-"));
    roots.push(root);
    const configDir = join(root, ".tmux-ide");
    const configPath = join(configDir, "workspace.yml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        "version: 1",
        "harnesses:",
        "  portable-agent:",
        "    adapter: generic",
        "    command: [/bin/sh, -c, 'sleep 30']",
        "    env:",
        "      TMUX_IDE_PROFILE: portable",
        "",
      ].join("\n"),
    );
    const registry = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
    registry.add({
      name: "workspace.configured",
      sessionName: "configured-session",
      projectDir: root,
      configKind: "workspace",
      configPath,
      hasWorkspaceConfig: true,
    });
    const fake = new FakeTmux();
    const authority = new WorkspacePaneCreationAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: {
        canonicalProjectDir: () => realpathSync(root),
        runTmux: fake.run,
        isMissingTmuxTarget: (error) => (error as Error).message.includes("missing"),
        creationFailureCannotHaveMutated: () => false,
      },
    });

    await authority.create(
      request({
        intent: {
          kind: "agent",
          workspaceName: "workspace.configured",
          harnessProfileId: "portable-agent",
          role: "validator",
        },
      }),
    );
    const create = fake.calls.find((call) => call[0] === "new-window")!;
    expect(create).toContain("TMUX_IDE_PROFILE=portable");
    expect(create.at(-1)).toBe(`'${realpathSync("/bin/sh")}' '-c' 'sleep 30'`);
    expect(create).not.toContain("portable-agent");
  });

  it("rejects a registry config symlink that escapes the selected workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-pane-config-root-"));
    const outside = mkdtempSync(join(tmpdir(), "tmux-ide-pane-config-outside-"));
    roots.push(root, outside);
    mkdirSync(join(root, ".tmux-ide"), { recursive: true });
    const outsideConfig = join(outside, "hostile.yml");
    writeFileSync(
      outsideConfig,
      [
        "version: 1",
        "harnesses:",
        "  escaped-agent:",
        "    adapter: generic",
        "    command: [/bin/sh, -c, 'touch /tmp/escaped']",
        "",
      ].join("\n"),
    );
    const configPath = join(root, ".tmux-ide", "workspace.yml");
    symlinkSync(outsideConfig, configPath);
    const registry = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
    registry.add({
      name: "workspace.escaped",
      sessionName: "escaped-session",
      projectDir: root,
      configKind: "workspace",
      configPath,
      hasWorkspaceConfig: true,
    });
    const fake = new FakeTmux();
    const authority = new WorkspacePaneCreationAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: { canonicalProjectDir: () => realpathSync(root), runTmux: fake.run },
    });

    await expect(
      authority.create(
        request({
          intent: {
            kind: "agent",
            workspaceName: "workspace.escaped",
            harnessProfileId: "escaped-agent",
            role: "implementer",
          },
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "workspace_unavailable");
    expect(fake.creations).toBe(0);
  });

  it("serializes concurrent retries and creates exactly once", async () => {
    const { authority, fake } = rig();
    const [first, second] = await Promise.all([
      authority.create(request()),
      authority.create(request()),
    ]);
    expect([first.outcome, second.outcome]).toEqual(["created", "replayed"]);
    expect(fake.creations).toBe(1);
  });

  it("quiesces an in-flight agent create before shutdown can mutate tmux", async () => {
    let releaseHarness!: (launch: {
      id: string;
      label: string;
      command: readonly string[];
      environment: Readonly<Record<string, string>>;
    }) => void;
    const resolveHarness = vi.fn(
      () =>
        new Promise<{
          id: string;
          label: string;
          command: readonly string[];
          environment: Readonly<Record<string, string>>;
        }>((resolve) => {
          releaseHarness = resolve;
        }),
    );
    const { authority, fake } = rig({ resolveHarness });
    const creating = authority.create(
      request({
        intent: {
          kind: "agent",
          workspaceName: "workspace.alpha",
          harnessProfileId: "codex",
          role: "implementer",
        },
      }),
    );
    await vi.waitFor(() => expect(resolveHarness).toHaveBeenCalledOnce());

    const disposing = authority.dispose();
    releaseHarness({
      id: "codex",
      label: "Codex",
      command: ["/opt/bin/codex"],
      environment: {},
    });

    await expect(creating).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_unavailable",
    );
    await disposing;
    expect(fake.creations).toBe(0);
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_unavailable",
    );
    expect(fake.calls.filter((call) => call[0] === "new-window")).toEqual([]);
  });

  it("bounds pending admission while capability resolution is stalled", async () => {
    let releaseHarness!: WorkspacePaneCreationIo["resolveHarness"] extends (
      ...args: never[]
    ) => Promise<infer Result>
      ? (result: Result) => void
      : never;
    const resolveHarness = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<WorkspacePaneCreationIo["resolveHarness"]>>>((resolve) => {
          releaseHarness = resolve;
        }),
    );
    const { authority, fake } = rig({ resolveHarness, maxPendingOperations: 1 });
    const first = authority.create(
      request({
        intent: {
          kind: "agent",
          workspaceName: "workspace.alpha",
          harnessProfileId: "codex",
          role: "implementer",
        },
      }),
    );
    await vi.waitFor(() => expect(resolveHarness).toHaveBeenCalledOnce());
    await expect(
      authority.create(request({ operationId: "90000000-0000-4000-8000-000000000009" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "operation_capacity");
    releaseHarness({
      id: "codex",
      label: "Codex",
      command: ["/opt/bin/codex"],
      environment: {},
    });
    await expect(first).resolves.toMatchObject({ outcome: "created" });
    expect(fake.creations).toBe(1);
  });

  it("rejects operation reuse with different semantic intent", async () => {
    const { authority, fake } = rig();
    await authority.create(request());
    await expect(
      authority.create(
        request({
          intent: { kind: "terminal", workspaceName: "workspace.alpha", displayTitle: "Other" },
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "operation_conflict");
    expect(fake.creations).toBe(1);
  });

  it("rejects a stale daemon generation before reading workspace or tmux state", async () => {
    const { authority, fake } = rig();
    await expect(
      authority.create(
        request({ expectedDaemonInstanceId: "30000000-0000-4000-8000-000000000003" }),
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "daemon_instance_mismatch");
    expect(fake.calls).toEqual([]);
  });

  it("rolls back a partially stamped owned window on failure", async () => {
    const fake = new FakeTmux();
    fake.failOption = "@ide_type";
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_creation_failed",
    );
    expect(fake.calls).toContainEqual(["kill-window", "-t", "@3"]);
    expect(fake.exists).toBe(false);
  });

  it("uses the create-returned identity to clean up when the first marker write fails", async () => {
    const fake = new FakeTmux();
    fake.failOption = "@tmux_ide_creation_id";
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_creation_failed",
    );
    expect(fake.calls).toContainEqual(["kill-window", "-t", "@3"]);
    expect(fake.exists).toBe(false);
  });

  it("never kills a same-name window when create output has no runtime identity", async () => {
    const fake = new FakeTmux();
    fake.malformedCreateOutput = true;
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_cleanup_unproven",
    );
    expect(fake.calls.some((call) => call[0] === "kill-window")).toBe(false);
    expect(fake.exists).toBe(true);
  });

  it("pins an uncertain failure without adopting or killing by provisional name", async () => {
    const fake = new FakeTmux();
    fake.throwAfterCreate = true;
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_cleanup_unproven",
    );
    fake.throwAfterCreate = false;
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_cleanup_unproven",
    );
    expect(fake.creations).toBe(1);
    expect(fake.calls.some((call) => call[0] === "kill-window")).toBe(false);
    expect(fake.exists).toBe(true);
  });

  it("never treats transient cleanup probes as proof that a partial mutation is gone", async () => {
    const fake = new FakeTmux();
    fake.failOption = "@ide_type";
    const original = fake.run;
    fake.run = (args) => {
      try {
        return original(args);
      } catch (error) {
        fake.failCleanupProof = true;
        throw error;
      }
    };
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_cleanup_unproven",
    );
    expect(fake.exists).toBe(true);
    expect(fake.calls.some((call) => call[0] === "kill-window")).toBe(false);
  });

  it("fails closed when an external mutation removes cleanup ownership proof", async () => {
    const fake = new FakeTmux();
    fake.failOption = "@ide_type";
    fake.mutateOwnerOnFailure = true;
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_cleanup_unproven",
    );
    expect(fake.calls.some((call) => call[0] === "kill-window")).toBe(false);
    expect(fake.exists).toBe(true);
  });

  it("fails closed when an external split invalidates one-pane cleanup proof", async () => {
    const fake = new FakeTmux();
    fake.failOption = "@ide_type";
    const original = fake.run;
    fake.run = (args) => {
      try {
        return original(args);
      } catch (error) {
        fake.paneCount = 2;
        throw error;
      }
    };
    const { authority } = rig({ fake });
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_cleanup_unproven",
    );
    expect(fake.calls.some((call) => call[0] === "kill-window")).toBe(false);
  });

  it("never duplicates a resource when external mutation invalidates an idempotent replay", async () => {
    const { authority, fake } = rig();
    await authority.create(request());
    fake.options.set("@tmux_ide_pane_id", "pane.external");
    await expect(authority.create(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "pane_resource_changed",
    );
    expect(fake.creations).toBe(1);
  });

  it("recovers a completed operation after daemon authority restart without duplication", async () => {
    const { authority, fake, registry, resolveHarness } = rig();
    await authority.create(request());
    const nextDaemon = "30000000-0000-4000-8000-000000000003";
    const restarted = new WorkspacePaneCreationAuthority({
      daemonInstanceId: nextDaemon,
      registry,
      io: {
        canonicalProjectDir: () => "/canonical/project",
        runTmux: fake.run,
        resolveHarness,
        resolveMission: async (_workspace, _root, missionId) => missionId,
        isMissingTmuxTarget: (error) => (error as Error).message.includes("missing"),
        creationFailureCannotHaveMutated: () => false,
      },
    });

    await expect(
      restarted.create(request({ expectedDaemonInstanceId: nextDaemon })),
    ).resolves.toMatchObject({ outcome: "replayed", daemonInstanceId: nextDaemon });
    expect(fake.creations).toBe(1);
  });

  it("resolves mission identity through daemon-owned project state", async () => {
    const resolveMission = vi.fn(async () => {
      throw new WorkspacePaneCreationError("mission_not_found");
    });
    const { authority, fake } = rig({ resolveMission });
    await expect(
      authority.create(
        request({
          intent: {
            kind: "agent",
            workspaceName: "workspace.alpha",
            harnessProfileId: "codex",
            role: "implementer",
            missionId: "mis_missing",
          },
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "mission_not_found");
    expect(resolveMission).toHaveBeenCalledWith(
      expect.objectContaining({ name: "workspace.alpha" }),
      "/canonical/project",
      "mis_missing",
    );
    expect(fake.creations).toBe(0);
  });

  it("evicts bounded safe failures so a hostile request flood cannot exhaust creation", async () => {
    const { authority, fake } = rig();
    for (let index = 1; index <= 200; index += 1) {
      await expect(
        authority.create(
          request({
            operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            intent: { kind: "terminal", workspaceName: "workspace.missing" },
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "workspace_not_found");
    }
    await expect(authority.create(request())).resolves.toMatchObject({ outcome: "created" });
    expect(fake.creations).toBe(1);
  });

  it("rejects capacity instead of forgetting a live success and risking duplication", async () => {
    const { authority, fake } = rig();
    for (let index = 1; index <= 128; index += 1) {
      await authority.create(
        request({
          operationId: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }),
      );
    }
    await expect(
      authority.create(request({ operationId: "50000000-0000-4000-8000-000000000001" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "operation_capacity");
    expect(fake.creations).toBe(128);
  });

  it("retires only proven-missing successful resources when capacity is under pressure", async () => {
    const { authority, fake } = rig();
    await authority.create(request());
    fake.missingTargets.add("%7");
    for (let index = 2; index <= 128; index += 1) {
      await authority.create(
        request({
          operationId: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }),
      );
    }
    await expect(
      authority.create(request({ operationId: "70000000-0000-4000-8000-000000000001" })),
    ).resolves.toMatchObject({ outcome: "created" });
    expect(fake.creations).toBe(129);
  });
});
