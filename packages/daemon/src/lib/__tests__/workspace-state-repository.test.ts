import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProjectResolution } from "../project-resolver.ts";
import { createProjectRuntimeRepository } from "../project-runtime-repository.ts";
import {
  captureWorkspaceObservation,
  createWorkspaceLayout,
  defaultWorkspaceState,
  renameWorkspaceLayout,
} from "../workspace-state.ts";
import {
  WORKSPACE_STATE_LOCK_FILENAME,
  WORKSPACE_STATE_PATH,
  WorkspaceStateLockRecoveryError,
  WorkspaceStateLockTimeoutError,
  clearWorkspaceStateLockOffline,
  inspectWorkspaceStateLock,
  loadWorkspaceState,
  withWorkspaceStateLock,
  workspaceCheckoutKey,
  workspaceProjectIdentity,
  writeWorkspaceStateWithRetry,
} from "../workspace-state-repository.ts";

const roots: string[] = [];
const IDENTITY_KEY = `git-${"c".repeat(64)}`;
const NOW = "2026-07-20T12:00:00.000Z";

function temporaryRoot(prefix = "workspace-state-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function resolution(projectRoot: string, identityAnchor = "/shared/.git"): ProjectResolution {
  return {
    inputDir: projectRoot,
    projectRoot,
    identityKey: IDENTITY_KEY,
    identitySource: "git-common-dir",
    identityAnchor,
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
  };
}

function addEmptyLayout(
  state: ReturnType<typeof defaultWorkspaceState>,
  projectRoot: string,
  layoutId: string,
) {
  const checkoutKey = workspaceCheckoutKey(projectRoot);
  const captured = captureWorkspaceObservation(state, {
    checkoutKey,
    projectRoot,
    observedAt: NOW,
    sessionName: null,
    windowIndex: null,
    windowName: null,
    panes: [],
    focusedPaneId: null,
    workbench: {
      canvasPanel: "home",
      dock: { activeTab: "files", mode: "open", preferredHeight: null, focusZone: "canvas" },
    },
  });
  return {
    checkoutKey,
    state: createWorkspaceLayout(captured, {
      id: layoutId,
      name: layoutId,
      checkoutKey,
      now: NOW,
    }),
  };
}

function writeRaw(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function lockOwner(
  token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  processInstanceId = "11111111-1111-4111-8111-111111111111",
) {
  return { version: 1, token, processInstanceId, pid: 4242, createdAtMs: 123_456 } as const;
}

function expectLockRecoveryError(
  action: () => unknown,
  code: WorkspaceStateLockRecoveryError["code"],
): void {
  try {
    action();
    throw new Error("expected workspace lock recovery to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceStateLockRecoveryError);
    expect((error as WorkspaceStateLockRecoveryError).code).toBe(code);
  }
}

function checkoutIntents(
  checkoutKey: string,
  ...domains: Array<"live" | "workbench" | "focus" | "active-layout">
) {
  return new Map([[checkoutKey, new Set(domains)]]);
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface ChildObservation {
  exit: Promise<ChildExitResult>;
  stderr: () => string;
}

function observeChild(child: ReturnType<typeof spawn>): ChildObservation {
  let stderr = "";
  const exit = new Promise<ChildExitResult>((resolvePromise, reject) => {
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", (error) => {
      reject(new Error(`child process failed: ${String(error)}; stderr: ${stderr || "<empty>"}`));
    });
    child.once("close", (code, signal) => resolvePromise({ code, signal, stderr }));
  });
  return { exit, stderr: () => stderr };
}

function childExitDetails(result: ChildExitResult): string {
  return `code ${String(result.code)}, signal ${result.signal ?? "none"}; stderr: ${result.stderr || "<empty>"}`;
}

async function waitForFileOrChildExit(
  path: string,
  child: ReturnType<typeof spawn>,
  observation: ChildObservation,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const readiness = (async () => {
    while (!existsSync(path)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for ${path} from child ${String(child.pid)}; stderr: ${observation.stderr() || "<empty>"}`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  })();
  const earlyExit = observation.exit.then(
    (result) => {
      throw new Error(
        `child ${String(child.pid)} exited before signaling readiness at ${path}: ${childExitDetails(result)}`,
      );
    },
    (error) => {
      throw new Error(
        `child ${String(child.pid)} failed before signaling readiness at ${path}: ${String(error)}`,
      );
    },
  );
  await Promise.race([readiness, earlyExit]);
}

async function requireSuccessfulChildExit(observation: ChildObservation): Promise<void> {
  const result = await observation.exit;
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`child exited unsuccessfully: ${childExitDetails(result)}`);
  }
}

async function terminateChild(
  child: ReturnType<typeof spawn>,
  observation: ChildObservation,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await observation.exit.catch(() => undefined);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace state repository", () => {
  it("loads missing state, deterministically migrates V2, writes, and reopens outside checkout", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const legacy = {
      version: 2,
      active: { viewId: "home", panel: "home" },
      dock: {
        activeTab: "changes",
        mode: "open",
        preferredHeight: 10,
        focusZone: "dock-tabs",
      },
      surfaces: {},
      views: {},
    };
    const loaded = loadWorkspaceState(repository, {
      legacyWorkspaceUiState: legacy,
      migratedAt: NOW,
    });
    const checkoutKey = workspaceCheckoutKey(projectRoot);

    expect(loaded).toMatchObject({ revision: null, writeProtected: false });
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "MIGRATED" }));
    expect(loaded.state.checkouts[checkoutKey]!.workbench).toMatchObject({
      canvasPanel: "home",
      dock: { activeTab: "changes" },
    });

    const written = writeWorkspaceStateWithRetry({
      repository,
      revision: loaded.revision,
      next: loaded.state,
      touchedLayoutIds: new Set(["default"]),
      checkoutIntents: checkoutIntents(checkoutKey, "live", "workbench", "focus", "active-layout"),
    });
    expect(written).toMatchObject({ saved: true, revision: 1 });
    expect(
      loadWorkspaceState(createProjectRuntimeRepository(resolution(projectRoot), { home })),
    ).toMatchObject({
      state: written.state,
      revision: 1,
      writeProtected: false,
    });
    expect(existsSync(join(projectRoot, ".tmux-ide"))).toBe(false);
  });

  it("preserves a future-version payload byte-for-byte", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const path = join(repository.runtimeRoot, WORKSPACE_STATE_PATH);
    const future =
      '{\n  "version": 1,\n  "revision": 7,\n  "payload": {"version": 42, "opaque": [3, 2, 1]}\n}\n';
    writeRaw(path, future);

    const loaded = loadWorkspaceState(repository);
    expect(loaded.writeProtected).toBe(true);
    const result = writeWorkspaceStateWithRetry({
      repository,
      revision: loaded.revision,
      next: defaultWorkspaceState(workspaceProjectIdentity(repository)),
      touchedLayoutIds: new Set(),
    });

    expect(result.saved).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "WRITE_PROTECTED" }));
    expect(readFileSync(path, "utf8")).toBe(future);
  });

  it("write-protects a corrupt existing envelope instead of replacing evidence", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const path = join(repository.runtimeRoot, WORKSPACE_STATE_PATH);
    const corrupt = "{not valid JSON\n";
    writeRaw(path, corrupt);

    const loaded = loadWorkspaceState(repository);
    expect(loaded).toMatchObject({ revision: null, writeProtected: true });
    const result = writeWorkspaceStateWithRetry({
      repository,
      revision: null,
      next: defaultWorkspaceState(workspaceProjectIdentity(repository)),
      touchedLayoutIds: new Set(),
    });

    expect(result.saved).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  it("preserves structurally corrupt supported V1 payload bytes", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const path = join(repository.runtimeRoot, WORKSPACE_STATE_PATH);
    const corruptV1 = `${JSON.stringify(
      {
        version: 1,
        revision: 4,
        payload: {
          version: 1,
          project: workspaceProjectIdentity(repository),
          layouts: [],
          checkouts: {},
        },
      },
      null,
      2,
    )}\n`;
    writeRaw(path, corruptV1);

    const loaded = loadWorkspaceState(repository);
    expect(loaded.writeProtected).toBe(true);
    const result = writeWorkspaceStateWithRetry({
      repository,
      revision: loaded.revision,
      next: defaultWorkspaceState(workspaceProjectIdentity(repository)),
      touchedLayoutIds: new Set(),
    });

    expect(result.saved).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "WRITE_PROTECTED" }));
    expect(readFileSync(path, "utf8")).toBe(corruptV1);
  });

  it("merges stale shared layouts while isolating live bindings by linked checkout", () => {
    const home = temporaryRoot("workspace-home-");
    const mainRoot = temporaryRoot("workspace-main-");
    const linkedRoot = temporaryRoot("workspace-linked-");
    const main = createProjectRuntimeRepository(resolution(mainRoot), { home });
    const linked = createProjectRuntimeRepository(resolution(linkedRoot), { home });
    const mainLoaded = loadWorkspaceState(main);
    const linkedLoaded = loadWorkspaceState(linked);
    const mainLocal = addEmptyLayout(mainLoaded.state, mainRoot, "main-layout");
    const linkedLocal = addEmptyLayout(linkedLoaded.state, linkedRoot, "linked-layout");

    expect(
      writeWorkspaceStateWithRetry({
        repository: main,
        revision: mainLoaded.revision,
        next: mainLocal.state,
        touchedLayoutIds: new Set(["main-layout"]),
        checkoutIntents: checkoutIntents(
          mainLocal.checkoutKey,
          "live",
          "workbench",
          "focus",
          "active-layout",
        ),
      }).saved,
    ).toBe(true);
    const linkedWrite = writeWorkspaceStateWithRetry({
      repository: linked,
      revision: linkedLoaded.revision,
      next: linkedLocal.state,
      touchedLayoutIds: new Set(["linked-layout"]),
      checkoutIntents: checkoutIntents(
        linkedLocal.checkoutKey,
        "live",
        "workbench",
        "focus",
        "active-layout",
      ),
    });
    expect(linkedWrite.saved).toBe(true);
    expect(linkedWrite.diagnostics).toContainEqual(expect.objectContaining({ code: "STALE" }));

    const final = loadWorkspaceState(main);
    expect(Object.keys(final.state.layouts)).toEqual(["linked-layout", "main-layout"]);
    expect(Object.keys(final.state.checkouts)).toEqual(
      [linkedLocal.checkoutKey, mainLocal.checkoutKey].sort(),
    );
    expect(final.state.checkouts[mainLocal.checkoutKey]!.projectRoot).toBe(mainRoot);
    expect(final.state.checkouts[linkedLocal.checkoutKey]!.projectRoot).toBe(linkedRoot);
    expect(final.revision).toBe(2);
  });

  it("merges stale checkout subdomains without regressing bindings or workbench state", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const checkoutKey = workspaceCheckoutKey(projectRoot);
    const capture = (
      state: ReturnType<typeof defaultWorkspaceState>,
      runtimePaneId: `%${number}`,
      activeTab: "files" | "changes" | "missions",
      observedAt: string,
    ) =>
      captureWorkspaceObservation(state, {
        checkoutKey,
        projectRoot,
        observedAt,
        sessionName: "workspace",
        windowIndex: 0,
        windowName: "main",
        panes: [
          {
            semanticPaneId: "agent",
            runtimePaneId,
            role: "agent",
            harness: "codex",
            title: "Agent",
            command: "codex",
            cwd: projectRoot,
            rect: { left: 0, top: 0, width: 80, height: 40 },
            active: true,
          },
        ],
        focusedPaneId: "agent",
        workbench: {
          canvasPanel: "terminals",
          dock: { activeTab, mode: "open", preferredHeight: 12, focusZone: "canvas" },
        },
      });
    const initial = capture(
      defaultWorkspaceState(workspaceProjectIdentity(repository)),
      "%1",
      "files",
      NOW,
    );
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: null,
        next: initial,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(
          checkoutKey,
          "live",
          "workbench",
          "focus",
          "active-layout",
        ),
      }).saved,
    ).toBe(true);

    const liveBase = loadWorkspaceState(repository);
    const tuiBase = loadWorkspaceState(repository);
    const liveNext = capture(liveBase.state, "%2", "files", "2026-07-20T12:01:00.000Z");
    const tuiNext = structuredClone(tuiBase.state);
    tuiNext.checkouts[checkoutKey]!.workbench.dock.activeTab = "missions";
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: liveBase.revision,
        next: liveNext,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(checkoutKey, "live", "focus"),
      }).saved,
    ).toBe(true);
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: tuiBase.revision,
        next: tuiNext,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(checkoutKey, "workbench"),
      }).saved,
    ).toBe(true);
    let final = loadWorkspaceState(repository);
    expect(final.state.checkouts[checkoutKey]!.bindings.agent!.runtimePaneId).toBe("%2");
    expect(final.state.checkouts[checkoutKey]!.workbench.dock.activeTab).toBe("missions");

    const tuiFirstBase = loadWorkspaceState(repository);
    const staleLiveBase = loadWorkspaceState(repository);
    const tuiFirst = structuredClone(tuiFirstBase.state);
    tuiFirst.checkouts[checkoutKey]!.workbench.dock.activeTab = "changes";
    const staleLive = capture(staleLiveBase.state, "%3", "files", "2026-07-20T12:02:00.000Z");
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: tuiFirstBase.revision,
        next: tuiFirst,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(checkoutKey, "workbench"),
      }).saved,
    ).toBe(true);
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: staleLiveBase.revision,
        next: staleLive,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(checkoutKey, "live", "focus"),
      }).saved,
    ).toBe(true);
    final = loadWorkspaceState(repository);
    expect(final.state.checkouts[checkoutKey]!.bindings.agent!.runtimePaneId).toBe("%3");
    expect(final.state.checkouts[checkoutKey]!.workbench.dock.activeTab).toBe("changes");
  });

  it("returns a typed conflict when stale focus targets a concurrently removed live pane", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const checkoutKey = workspaceCheckoutKey(projectRoot);
    const initial = captureWorkspaceObservation(
      defaultWorkspaceState(workspaceProjectIdentity(repository)),
      {
        checkoutKey,
        projectRoot,
        observedAt: NOW,
        sessionName: "workspace",
        windowIndex: 0,
        windowName: "main",
        panes: [
          {
            semanticPaneId: "agent",
            runtimePaneId: "%1",
            role: "agent",
            harness: "codex",
            title: "Agent",
            command: "codex",
            cwd: projectRoot,
            rect: { left: 0, top: 0, width: 80, height: 40 },
            active: true,
          },
        ],
        focusedPaneId: "agent",
        workbench: {
          canvasPanel: "terminals",
          dock: { activeTab: "files", mode: "open", preferredHeight: 12, focusZone: "canvas" },
        },
      },
    );
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: null,
        next: initial,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(checkoutKey, "live", "workbench", "focus"),
      }).saved,
    ).toBe(true);

    const focusBase = loadWorkspaceState(repository);
    const liveBase = loadWorkspaceState(repository);
    const paneRemoved = structuredClone(liveBase.state);
    paneRemoved.checkouts[checkoutKey]!.topology = { panes: {}, root: null };
    paneRemoved.checkouts[checkoutKey]!.focusedPaneId = null;
    paneRemoved.checkouts[checkoutKey]!.bindings = {};
    paneRemoved.checkouts[checkoutKey]!.recovery = {
      status: "empty",
      capturedAt: "2026-07-20T12:01:00.000Z",
      sessionName: "workspace",
      windowIndex: 0,
      windowName: "main",
      missingPaneIds: ["agent"],
      externalPaneIds: [],
    };
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: liveBase.revision,
        next: paneRemoved,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(checkoutKey, "live"),
      }).saved,
    ).toBe(true);

    const result = writeWorkspaceStateWithRetry({
      repository,
      revision: focusBase.revision,
      next: focusBase.state,
      touchedLayoutIds: new Set(),
      checkoutIntents: checkoutIntents(checkoutKey, "focus"),
    });

    expect(result.saved).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFLICT",
        path: `$.checkouts.${checkoutKey}.focusedPaneId`,
      }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "WRITE_FAILED" }),
    );
    expect(loadWorkspaceState(repository).state.checkouts[checkoutKey]).toMatchObject({
      focusedPaneId: null,
      topology: { panes: {} },
    });
  });

  it("rejects stale same-layout edits when their base revision changed", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const initial = addEmptyLayout(
      defaultWorkspaceState(workspaceProjectIdentity(repository)),
      projectRoot,
      "shared-layout",
    );
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: null,
        next: initial.state,
        touchedLayoutIds: new Set(["shared-layout"]),
        checkoutIntents: checkoutIntents(
          initial.checkoutKey,
          "live",
          "workbench",
          "focus",
          "active-layout",
        ),
      }).saved,
    ).toBe(true);
    const firstBase = loadWorkspaceState(repository);
    const secondBase = loadWorkspaceState(repository);
    const first = renameWorkspaceLayout(
      firstBase.state,
      "shared-layout",
      "First rename",
      "2026-07-20T12:01:00.000Z",
    );
    const second = renameWorkspaceLayout(
      secondBase.state,
      "shared-layout",
      "Second rename",
      "2026-07-20T12:02:00.000Z",
    );
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: firstBase.revision,
        next: first,
        touchedLayoutIds: new Set(["shared-layout"]),
        layoutBaseRevisions: new Map([["shared-layout", 1]]),
      }).saved,
    ).toBe(true);
    const conflict = writeWorkspaceStateWithRetry({
      repository,
      revision: secondBase.revision,
      next: second,
      touchedLayoutIds: new Set(["shared-layout"]),
      layoutBaseRevisions: new Map([["shared-layout", 1]]),
    });

    expect(conflict.saved).toBe(false);
    expect(conflict.diagnostics).toContainEqual(expect.objectContaining({ code: "CONFLICT" }));
    expect(loadWorkspaceState(repository).state.layouts["shared-layout"]!.name).toBe(
      "First rename",
    );
  });

  it("rejects deprecated whole-checkout replacement when its document is stale", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    const repository = createProjectRuntimeRepository(resolution(projectRoot), { home });
    const initial = addEmptyLayout(
      defaultWorkspaceState(workspaceProjectIdentity(repository)),
      projectRoot,
      "layout",
    );
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: null,
        next: initial.state,
        touchedLayoutIds: new Set(["layout"]),
        touchedCheckoutKeys: new Set([initial.checkoutKey]),
      }).saved,
    ).toBe(true);
    const legacyBase = loadWorkspaceState(repository);
    const competingBase = loadWorkspaceState(repository);
    const competing = structuredClone(competingBase.state);
    competing.checkouts[initial.checkoutKey]!.workbench.dock.activeTab = "missions";
    expect(
      writeWorkspaceStateWithRetry({
        repository,
        revision: competingBase.revision,
        next: competing,
        touchedLayoutIds: new Set(),
        checkoutIntents: checkoutIntents(initial.checkoutKey, "workbench"),
      }).saved,
    ).toBe(true);
    const legacyNext = structuredClone(legacyBase.state);
    legacyNext.checkouts[initial.checkoutKey]!.workbench.dock.activeTab = "changes";
    const result = writeWorkspaceStateWithRetry({
      repository,
      revision: legacyBase.revision,
      next: legacyNext,
      touchedLayoutIds: new Set(),
      touchedCheckoutKeys: new Set([initial.checkoutKey]),
    });

    expect(result.saved).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONFLICT" }));
    expect(
      loadWorkspaceState(repository).state.checkouts[initial.checkoutKey]!.workbench.dock.activeTab,
    ).toBe("missions");
  });

  it.each([
    ["empty", ""],
    ["malformed", "not-json\n"],
  ])("never reclaims an existing %s lock file", (_label, contents) => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    writeRaw(lockPath, contents);

    expect(() =>
      withWorkspaceStateLock(
        repository,
        { timeoutMs: 25, pollMs: 5, staleAfterMs: 1 },
        () => undefined,
      ),
    ).toThrow(WorkspaceStateLockTimeoutError);
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
  });

  it.each([
    ["ancient live owner", process.pid, "11111111-1111-4111-8111-111111111111"],
    ["dead-looking owner", 2_147_000_000, "22222222-2222-4222-8222-222222222222"],
    ["PID-reused-looking owner", process.pid, "33333333-3333-4333-8333-333333333333"],
  ])("never reclaims a structured %s lock", (_label, pid, processInstanceId) => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    const contents = `${JSON.stringify({
      version: 1,
      token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      processInstanceId,
      pid,
      createdAtMs: 0,
    })}\n`;
    writeRaw(lockPath, contents);

    expect(() =>
      withWorkspaceStateLock(repository, { timeoutMs: 25, pollMs: 5 }, () => undefined),
    ).toThrow(WorkspaceStateLockTimeoutError);
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
  });

  it("inspects exact lock ownership and preserves bytes without confirmation or on mismatch", () => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    const owner = lockOwner();
    const contents = `${JSON.stringify(owner)}\n`;
    writeRaw(lockPath, contents);

    const inspected = inspectWorkspaceStateLock(repository);
    expect(inspected).toMatchObject({
      status: "valid",
      lockPath,
      owner: {
        version: 1,
        token: owner.token,
        processInstanceId: owner.processInstanceId,
        pid: owner.pid,
        createdAt: owner.createdAtMs,
      },
    });
    if (inspected.status !== "valid") throw new Error("expected valid lock inspection");
    expectLockRecoveryError(
      () =>
        clearWorkspaceStateLockOffline(repository, {
          expectedToken: owner.token,
          expectedProcessInstanceId: owner.processInstanceId,
          expectedDevice: inspected.device,
          expectedInode: inspected.inode,
          confirmAllWritersStopped: false as true,
        }),
      "CONFIRMATION_REQUIRED",
    );
    expect(readFileSync(lockPath, "utf8")).toBe(contents);

    expectLockRecoveryError(
      () =>
        clearWorkspaceStateLockOffline(repository, {
          expectedToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          expectedProcessInstanceId: owner.processInstanceId,
          expectedDevice: inspected.device,
          expectedInode: inspected.inode,
          confirmAllWritersStopped: true,
        }),
      "OWNER_MISMATCH",
    );
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
  });

  it("clears an explicitly confirmed structured abandoned lock and allows acquisition", () => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    const owner = lockOwner();
    writeRaw(lockPath, `${JSON.stringify(owner)}\n`);
    const inspected = inspectWorkspaceStateLock(repository);
    expect(inspected.status).toBe("valid");
    if (inspected.status !== "valid") throw new Error("expected valid lock inspection");

    expect(
      clearWorkspaceStateLockOffline(repository, {
        expectedToken: inspected.owner.token,
        expectedProcessInstanceId: inspected.owner.processInstanceId,
        expectedDevice: inspected.device,
        expectedInode: inspected.inode,
        confirmAllWritersStopped: true,
      }),
    ).toMatchObject({
      cleared: true,
      lockPath,
      owner: inspected.owner,
      device: inspected.device,
      inode: inspected.inode,
    });
    expect(inspectWorkspaceStateLock(repository)).toEqual({ status: "absent", lockPath });
    expect(withWorkspaceStateLock(repository, { timeoutMs: 100 }, () => "acquired")).toBe(
      "acquired",
    );
  });

  it("refuses malformed offline locks and preserves their bytes", () => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    const contents = "not-json\n";
    writeRaw(lockPath, contents);

    const inspected = inspectWorkspaceStateLock(repository);
    expect(inspected).toMatchObject({
      status: "malformed",
      lockPath,
    });
    if (inspected.status !== "malformed") throw new Error("expected malformed lock inspection");
    expectLockRecoveryError(
      () =>
        clearWorkspaceStateLockOffline(repository, {
          expectedToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          expectedProcessInstanceId: "11111111-1111-4111-8111-111111111111",
          expectedDevice: inspected.device,
          expectedInode: inspected.inode,
          confirmAllWritersStopped: true,
        }),
      "LOCK_MALFORMED",
    );
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
  });

  it("does not delete a replacement lock that differs from the inspected owner", () => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    const original = lockOwner();
    writeRaw(lockPath, `${JSON.stringify(original)}\n`);
    const inspected = inspectWorkspaceStateLock(repository);
    expect(inspected.status).toBe("valid");
    if (inspected.status !== "valid") throw new Error("expected valid lock inspection");

    const replacement = lockOwner(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "22222222-2222-4222-8222-222222222222",
    );
    const replacementContents = `${JSON.stringify(replacement)}\n`;
    const replacementPath = `${lockPath}.replacement`;
    writeRaw(replacementPath, replacementContents);
    renameSync(replacementPath, lockPath);

    expectLockRecoveryError(
      () =>
        clearWorkspaceStateLockOffline(repository, {
          expectedToken: original.token,
          expectedProcessInstanceId: original.processInstanceId,
          expectedDevice: inspected.device,
          expectedInode: inspected.inode,
          confirmAllWritersStopped: true,
        }),
      "OWNER_MISMATCH",
    );
    expect(readFileSync(lockPath, "utf8")).toBe(replacementContents);
  });

  it("preserves a byte-identical replacement installed on a new inode", () => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    const owner = lockOwner();
    const contents = `${JSON.stringify(owner)}\n`;
    writeRaw(lockPath, contents);
    const inspected = inspectWorkspaceStateLock(repository);
    expect(inspected.status).toBe("valid");
    if (inspected.status !== "valid") throw new Error("expected valid lock inspection");

    const replacementPath = `${lockPath}.replacement-identical`;
    writeRaw(replacementPath, contents);
    const replacementIdentity = lstatSync(replacementPath);
    expect({ device: replacementIdentity.dev, inode: replacementIdentity.ino }).not.toEqual({
      device: inspected.device,
      inode: inspected.inode,
    });
    renameSync(replacementPath, lockPath);

    expectLockRecoveryError(
      () =>
        clearWorkspaceStateLockOffline(repository, {
          expectedToken: inspected.owner.token,
          expectedProcessInstanceId: inspected.owner.processInstanceId,
          expectedDevice: inspected.device,
          expectedInode: inspected.inode,
          confirmAllWritersStopped: true,
        }),
      "LOCK_CHANGED",
    );
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
    expect(lstatSync(lockPath)).toMatchObject({
      dev: replacementIdentity.dev,
      ino: replacementIdentity.ino,
    });
  });

  it("installs and releases a fully populated lock atomically", () => {
    const home = temporaryRoot("workspace-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const lockPath = join(repository.runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
    expect(
      withWorkspaceStateLock(repository, { timeoutMs: 100 }, () => {
        const owner = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
        expect(owner).toMatchObject({ version: 1, pid: process.pid });
        expect(owner.token).toMatch(/^[0-9a-f-]{36}$/iu);
        expect(owner.processInstanceId).toMatch(/^[0-9a-f-]{36}$/iu);
        return "done";
      }),
    ).toBe("done");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps a successful document write saved when lock release fails", () => {
    const home = temporaryRoot("workspace-home-");
    const projectRoot = temporaryRoot("workspace-project-");
    let runtimeRoot = "";
    const repository = createProjectRuntimeRepository(resolution(projectRoot), {
      home,
      io: {
        rename: (from, to) => {
          renameSync(from, to);
          if (to.endsWith(WORKSPACE_STATE_PATH)) {
            const lockPath = join(runtimeRoot, "workspace", WORKSPACE_STATE_LOCK_FILENAME);
            const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
            const collision = `${lockPath}.released-${owner.token}`;
            mkdirSync(collision, { recursive: true });
            writeFileSync(join(collision, "occupied"), "occupied\n", "utf8");
          }
        },
      },
    });
    runtimeRoot = repository.runtimeRoot;
    const result = writeWorkspaceStateWithRetry({
      repository,
      revision: null,
      next: defaultWorkspaceState(workspaceProjectIdentity(repository)),
      touchedLayoutIds: new Set(),
    });

    expect(result).toMatchObject({ saved: true, revision: 1 });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOCK_RELEASE_FAILED" }),
    );
    expect(loadWorkspaceState(repository).revision).toBe(1);
  });

  it("rejects a symlinked runtime root without writing through it", () => {
    const home = temporaryRoot("workspace-home-");
    const external = temporaryRoot("workspace-external-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    mkdirSync(dirname(repository.runtimeRoot), { recursive: true });
    symlinkSync(external, repository.runtimeRoot, "dir");

    expect(() => withWorkspaceStateLock(repository, { timeoutMs: 25 }, () => undefined)).toThrow(
      /symbolic link/u,
    );
    expect(existsSync(join(external, "workspace"))).toBe(false);
  });

  it("serializes stale writers across real processes without losing disjoint changes", async () => {
    const home = temporaryRoot("workspace-home-");
    const firstRoot = temporaryRoot("workspace-child-a-");
    const secondRoot = temporaryRoot("workspace-child-b-");
    const barrier = temporaryRoot("workspace-barrier-");
    const readyA = join(barrier, "ready-a");
    const readyB = join(barrier, "ready-b");
    const go = join(barrier, "go");
    const fixture = fileURLToPath(new URL("./fixtures/workspace-state-writer.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const first = spawn(tsx, [fixture, home, firstRoot, "layout-a", readyA, go], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const second = spawn(tsx, [fixture, home, secondRoot, "layout-b", readyB, go], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const firstObservation = observeChild(first);
    const secondObservation = observeChild(second);
    try {
      await Promise.all([
        waitForFileOrChildExit(readyA, first, firstObservation),
        waitForFileOrChildExit(readyB, second, secondObservation),
      ]);
      writeFileSync(go, "go\n", "utf8");
      await Promise.all([
        requireSuccessfulChildExit(firstObservation),
        requireSuccessfulChildExit(secondObservation),
      ]);

      const repository = createProjectRuntimeRepository(resolution(firstRoot), { home });
      const final = loadWorkspaceState(repository);
      expect(final.revision).toBe(2);
      expect(Object.keys(final.state.layouts)).toEqual(["layout-a", "layout-b"]);
      expect(Object.keys(final.state.checkouts)).toHaveLength(2);
    } finally {
      await Promise.all([
        terminateChild(first, firstObservation),
        terminateChild(second, secondObservation),
      ]);
    }
  }, 30_000);
});
