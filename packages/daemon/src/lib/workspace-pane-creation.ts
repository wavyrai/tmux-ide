import { realpathSync, statSync } from "node:fs";

import {
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  type Workspace,
  type WorkspaceHarnessProfile,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
  type WorkspacePaneCreatedResource,
} from "@tmux-ide/contracts";
import { runTmux, TmuxError } from "@tmux-ide/tmux-bridge";

import { probeProjectReadiness } from "./project-readiness-probe.ts";
import { loadWorkspaceConfig, WorkspaceConfigLoadError } from "./workspace-config-loader.ts";
import { getDefaultWorkspaceRegistry, type WorkspaceRegistry } from "./workspace-registry.ts";
import { shellEscape } from "./shell.ts";
import { MissionRepository } from "./mission-repository.ts";

const MAX_LIVE_OR_UNSAFE_OPERATIONS = 128;
const MAX_REPLAYABLE_FAILURES = 64;
const MAX_COMMAND_ARGUMENTS = 64;
const MAX_COMMAND_ARGUMENT_BYTES = 4_096;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_BYTES = 64 * 1024;
const TMUX_OUTPUT_BYTES = 64 * 1024;

const CREATION_OPTION = "@tmux_ide_creation_id";
const HARNESS_OPTION = "@tmux_ide_harness";
const MISSION_OPTION = "@tmux_ide_mission";
const SEMANTIC_PANE_OPTION = "@tmux_ide_pane_id";

export type WorkspacePaneCreationErrorCode =
  | "daemon_instance_mismatch"
  | "workspace_not_found"
  | "workspace_unavailable"
  | "harness_not_allowed"
  | "harness_unavailable"
  | "mission_not_found"
  | "operation_conflict"
  | "operation_capacity"
  | "pane_creation_failed"
  | "pane_cleanup_unproven"
  | "pane_resource_changed";

const ERROR_MESSAGES: Readonly<Record<WorkspacePaneCreationErrorCode, string>> = {
  daemon_instance_mismatch: "The daemon generation changed before the pane was created.",
  workspace_not_found: "The requested workspace is not registered.",
  workspace_unavailable: "The requested workspace is not available for pane creation.",
  harness_not_allowed: "The requested harness is not in the workspace capability catalog.",
  harness_unavailable: "The requested harness is not currently launchable.",
  mission_not_found: "The requested mission is not present in the workspace mission repository.",
  operation_conflict: "The operation id was already used for a different pane intent.",
  operation_capacity: "The daemon has reached its bounded pane-creation operation capacity.",
  pane_creation_failed: "tmux could not create and verify the requested pane.",
  pane_cleanup_unproven: "The failed pane mutation could not be cleaned up safely.",
  pane_resource_changed: "The created pane changed outside tmux-ide before the retry.",
};

export class WorkspacePaneCreationError extends Error {
  readonly code: WorkspacePaneCreationErrorCode;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: WorkspacePaneCreationErrorCode,
    context: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "WorkspacePaneCreationError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

interface ResolvedHarnessLaunch {
  readonly id: string;
  readonly label: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

interface RuntimePaneIdentity {
  readonly paneId: string;
  readonly windowId: string;
  readonly creationId: string;
  readonly provisionalWindowName: string;
}

interface SuccessfulOperation {
  readonly fingerprint: string;
  readonly status: "success";
  readonly result: WorkspacePaneCreateMutationResult;
  readonly runtime: RuntimePaneIdentity;
}

interface FailedOperation {
  readonly fingerprint: string;
  readonly status: "error";
  readonly error: WorkspacePaneCreationError;
}

type OperationRecord = SuccessfulOperation | FailedOperation;

export interface WorkspacePaneCreationIo {
  readonly canonicalProjectDir: (path: string) => string;
  readonly runTmux: (args: readonly string[]) => string;
  readonly resolveHarness: (
    workspace: Workspace,
    canonicalProjectDir: string,
    harnessProfileId: string,
  ) => Promise<ResolvedHarnessLaunch>;
  readonly resolveMission: (
    workspace: Workspace,
    canonicalProjectDir: string,
    missionId: string,
  ) => Promise<string>;
  readonly isMissingTmuxTarget: (error: unknown) => boolean;
  readonly creationFailureCannotHaveMutated: (error: unknown) => boolean;
}

function canonicalProjectDir(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("project root is not a directory");
  return canonical;
}

function tmux(args: readonly string[]): string {
  return String(
    runTmux([...args], {
      encoding: "utf8",
      maxBuffer: TMUX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).replace(/(?:\r?\n)+$/u, "");
}

function profileCommand(profile: WorkspaceHarnessProfile): readonly string[] {
  return Array.isArray(profile.command)
    ? [...profile.command]
    : ["/bin/sh", "-lc", profile.command];
}

async function resolveHarness(
  workspace: Workspace,
  canonicalRoot: string,
  harnessProfileId: string,
): Promise<ResolvedHarnessLaunch> {
  let configuredProfiles: Readonly<Record<string, WorkspaceHarnessProfile>> = {};
  try {
    const loaded = await loadWorkspaceConfig(canonicalRoot, {
      explicitConfigPath: workspace.configPath ?? workspace.ideConfigPath,
    });
    configuredProfiles = loaded.config.harnesses ?? {};
  } catch (error) {
    if (!(error instanceof WorkspaceConfigLoadError)) throw error;
    const configIsOptional =
      workspace.configKind !== "workspace" &&
      workspace.hasWorkspaceConfig !== true &&
      error.code === "WORKSPACE_CONFIG_REQUIRED";
    if (!configIsOptional) {
      throw new WorkspacePaneCreationError("workspace_unavailable", {
        workspaceName: workspace.name,
      });
    }
  }

  const customProfiles = Object.entries(configuredProfiles).map(([id, profile]) => ({
    id,
    label: id,
    command: profileCommand(profile),
    source: "workspace" as const,
    authentication: "not-required" as const,
    commandReadiness: "ready" as const,
  }));
  const probe = await probeProjectReadiness(canonicalRoot, { customHarnesses: customProfiles });
  const matches = probe.harnesses.filter((candidate) => candidate.id === harnessProfileId);
  if (matches.length !== 1) {
    throw new WorkspacePaneCreationError("harness_not_allowed", {
      workspaceName: workspace.name,
      harnessProfileId,
    });
  }
  const capability = matches[0]!;
  if (
    capability.kind === "shell" ||
    capability.installation !== "available" ||
    capability.commandReadiness !== "ready"
  ) {
    throw new WorkspacePaneCreationError("harness_unavailable", {
      workspaceName: workspace.name,
      harnessProfileId,
    });
  }
  const configured = configuredProfiles[harnessProfileId];
  const resolved: ResolvedHarnessLaunch = {
    id: capability.id,
    label: capability.label,
    command: [...capability.command],
    environment: Object.freeze({ ...(configured?.env ?? {}) }),
  };
  assertBoundedLaunch(resolved);
  return resolved;
}

async function resolveMission(
  workspace: Workspace,
  canonicalRoot: string,
  missionId: string,
): Promise<string> {
  const repository = await MissionRepository.open(canonicalRoot, {
    explicitConfigPath: workspace.configPath ?? workspace.ideConfigPath,
  });
  const mission = repository.get(missionId);
  if (!mission) {
    throw new WorkspacePaneCreationError("mission_not_found", {
      workspaceName: workspace.name,
      missionId,
    });
  }
  return mission.id;
}

const DEFAULT_IO: WorkspacePaneCreationIo = {
  canonicalProjectDir,
  runTmux: tmux,
  resolveHarness,
  resolveMission,
  isMissingTmuxTarget: (error) => error instanceof TmuxError && error.code === "SESSION_NOT_FOUND",
  creationFailureCannotHaveMutated: (error) =>
    error instanceof TmuxError &&
    (error.code === "SESSION_NOT_FOUND" || error.code === "TMUX_UNAVAILABLE"),
};

function assertBoundedLaunch(launch: ResolvedHarnessLaunch): void {
  if (launch.command.length === 0 || launch.command.length > MAX_COMMAND_ARGUMENTS) {
    throw new WorkspacePaneCreationError("harness_unavailable", {
      harnessProfileId: launch.id,
    });
  }
  let commandBytes = 0;
  for (const argument of launch.command) {
    const bytes = Buffer.byteLength(argument);
    if (argument.length === 0 || argument.includes("\0") || bytes > MAX_COMMAND_ARGUMENT_BYTES) {
      throw new WorkspacePaneCreationError("harness_unavailable", {
        harnessProfileId: launch.id,
      });
    }
    commandBytes += bytes;
  }
  if (commandBytes > MAX_COMMAND_BYTES) {
    throw new WorkspacePaneCreationError("harness_unavailable", {
      harnessProfileId: launch.id,
    });
  }
  const environment = Object.entries(launch.environment);
  if (environment.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new WorkspacePaneCreationError("harness_unavailable", {
      harnessProfileId: launch.id,
    });
  }
  let environmentBytes = 0;
  for (const [key, value] of environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0")) {
      throw new WorkspacePaneCreationError("harness_unavailable", {
        harnessProfileId: launch.id,
      });
    }
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  if (environmentBytes > MAX_ENVIRONMENT_BYTES) {
    throw new WorkspacePaneCreationError("harness_unavailable", {
      harnessProfileId: launch.id,
    });
  }
}

function semanticPaneId(operationId: string): string {
  return `pane.${operationId.replaceAll("-", "")}`;
}

function provisionalWindowName(operationId: string): string {
  return `tmux-ide-${operationId.replaceAll("-", "").slice(0, 24)}`;
}

/** tmux command arguments may still be format-expanded; `##` is a literal `#`. */
function tmuxFormatLiteral(value: string): string {
  return value.replaceAll("#", "##");
}

function fingerprint(request: WorkspacePaneCreateMutationRequest): string {
  return JSON.stringify(request);
}

function parseCreatedRuntime(
  output: string,
  creationId: string,
  provisionalName: string,
): RuntimePaneIdentity {
  const match = /^(%[0-9]+)\t(@[0-9]+)$/u.exec(output);
  if (!match) throw new WorkspacePaneCreationError("pane_creation_failed");
  return {
    paneId: match[1]!,
    windowId: match[2]!,
    creationId,
    provisionalWindowName: provisionalName,
  };
}

function defaultTitle(
  intent: WorkspacePaneCreateMutationRequest["intent"],
  harness: ResolvedHarnessLaunch | null,
): string {
  if (intent.displayTitle) return intent.displayTitle;
  if (intent.kind === "agent") return (harness?.label ?? intent.harnessProfileId).slice(0, 80);
  return "Terminal";
}

function resourceFor(
  request: WorkspacePaneCreateMutationRequest,
  title: string,
  resolvedMissionId: string | null,
): WorkspacePaneCreatedResource {
  const intent = request.intent;
  const common = {
    resourceVersion: 1,
    workspaceName: intent.workspaceName,
    semanticPaneId: semanticPaneId(request.operationId),
    displayTitle: title,
  } as const;
  if (intent.kind === "agent") {
    return {
      ...common,
      kind: "agent",
      harnessProfileId: intent.harnessProfileId,
      role: intent.role,
      missionId: resolvedMissionId,
    };
  }
  return {
    ...common,
    kind: "terminal",
    harnessProfileId: null,
    role: null,
    missionId: null,
  };
}

function expectedPaneFacts(resource: WorkspacePaneCreatedResource, creationId: string): string[] {
  return [
    resource.semanticPaneId,
    creationId,
    resource.kind === "agent" ? "agent" : "shell",
    resource.role ?? "shell",
    resource.displayTitle,
    resource.harnessProfileId ?? "",
    resource.missionId ?? "",
  ];
}

function inspectArgs(runtime: RuntimePaneIdentity): readonly string[] {
  return [
    "display-message",
    "-p",
    "-t",
    runtime.paneId,
    [
      "#{pane_id}",
      "#{window_id}",
      `#{${SEMANTIC_PANE_OPTION}}`,
      `#{${CREATION_OPTION}}`,
      "#{@ide_type}",
      "#{@ide_role}",
      "#{@ide_name}",
      `#{${HARNESS_OPTION}}`,
      `#{${MISSION_OPTION}}`,
      "#{window_name}",
    ].join("\t"),
  ];
}

function inspectMatches(
  output: string,
  runtime: RuntimePaneIdentity,
  resource: WorkspacePaneCreatedResource,
): boolean {
  const fields = output.split("\t");
  return (
    fields.length === 10 &&
    fields[0] === runtime.paneId &&
    fields[1] === runtime.windowId &&
    fields
      .slice(2, 9)
      .every((value, index) => value === expectedPaneFacts(resource, runtime.creationId)[index]) &&
    fields[9] === resource.displayTitle
  );
}

function boundedAuthorityLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIVE_OR_UNSAFE_OPERATIONS) {
    throw new TypeError(
      `authority limit must be an integer from 1 to ${MAX_LIVE_OR_UNSAFE_OPERATIONS}`,
    );
  }
  return value;
}

export class WorkspacePaneCreationAuthority {
  readonly #daemonInstanceId: string;
  readonly #registry: WorkspaceRegistry;
  readonly #io: WorkspacePaneCreationIo;
  readonly #operations = new Map<string, OperationRecord>();
  readonly #replayableFailures = new Map<string, FailedOperation>();
  readonly #maxLiveOrUnsafeOperations: number;
  readonly #maxPendingOperations: number;
  #tail: Promise<void> = Promise.resolve();
  #pendingOperations = 0;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: {
    daemonInstanceId: string;
    registry?: WorkspaceRegistry;
    io?: Partial<WorkspacePaneCreationIo>;
    maxLiveOrUnsafeOperations?: number;
    maxPendingOperations?: number;
  }) {
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#registry = options.registry ?? getDefaultWorkspaceRegistry();
    this.#io = { ...DEFAULT_IO, ...options.io };
    this.#maxLiveOrUnsafeOperations = boundedAuthorityLimit(
      options.maxLiveOrUnsafeOperations,
      MAX_LIVE_OR_UNSAFE_OPERATIONS,
    );
    this.#maxPendingOperations = boundedAuthorityLimit(
      options.maxPendingOperations,
      MAX_LIVE_OR_UNSAFE_OPERATIONS,
    );
  }

  create(raw: WorkspacePaneCreateMutationRequest): Promise<WorkspacePaneCreateMutationResult> {
    if (this.#disposed) return Promise.reject(this.#disposedError());
    if (this.#pendingOperations >= this.#maxPendingOperations) {
      return Promise.reject(
        new WorkspacePaneCreationError("operation_capacity", { reason: "admission_queue_full" }),
      );
    }
    this.#pendingOperations += 1;
    const run = this.#tail.then(
      () => this.#create(raw),
      () => this.#create(raw),
    );
    const admitted = run.finally(() => {
      this.#pendingOperations -= 1;
    });
    this.#tail = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  }

  /**
   * Stop admitting mutations immediately and wait for the serialized authority
   * queue to quiesce. In-flight async capability resolution observes the
   * disposed state before it is allowed to mutate tmux.
   */
  dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposePromise ??= this.#tail.then(() => {
      this.#operations.clear();
      this.#replayableFailures.clear();
    });
    return this.#disposePromise;
  }

  async #create(
    raw: WorkspacePaneCreateMutationRequest,
  ): Promise<WorkspacePaneCreateMutationResult> {
    this.#assertActive();
    const request = WorkspacePaneCreateMutationRequestSchemaZ.parse(raw);
    if (request.expectedDaemonInstanceId !== this.#daemonInstanceId) {
      throw new WorkspacePaneCreationError("daemon_instance_mismatch", {
        operationId: request.operationId,
      });
    }
    const requestFingerprint = fingerprint(request);
    const existing =
      this.#operations.get(request.operationId) ??
      this.#replayableFailures.get(request.operationId);
    if (existing) return this.#replay(existing, request, requestFingerprint);
    if (this.#operations.size >= this.#maxLiveOrUnsafeOperations) {
      this.#retireClosedResources();
    }
    if (this.#operations.size >= this.#maxLiveOrUnsafeOperations) {
      throw new WorkspacePaneCreationError("operation_capacity", {
        operationId: request.operationId,
      });
    }

    const workspace = this.#registry.get(request.intent.workspaceName);
    if (!workspace) {
      return this.#rememberFailure(
        request,
        requestFingerprint,
        new WorkspacePaneCreationError("workspace_not_found", {
          operationId: request.operationId,
          workspaceName: request.intent.workspaceName,
        }),
      );
    }

    let runtime: RuntimePaneIdentity | null = null;
    try {
      const canonicalRoot = this.#io.canonicalProjectDir(workspace.projectDir);
      this.#io.runTmux(["has-session", "-t", `=${workspace.sessionName}`]);
      const harness =
        request.intent.kind === "agent"
          ? await this.#io.resolveHarness(workspace, canonicalRoot, request.intent.harnessProfileId)
          : null;
      this.#assertActive(request.operationId);
      if (harness) assertBoundedLaunch(harness);
      const resolvedMissionId =
        request.intent.kind === "agent" && request.intent.missionId
          ? await this.#io.resolveMission(workspace, canonicalRoot, request.intent.missionId)
          : null;
      this.#assertActive(request.operationId);
      const title = defaultTitle(request.intent, harness);
      const resource = resourceFor(request, title, resolvedMissionId);
      const recoveredSuccess = this.#completedRuntime(
        workspace.sessionName,
        request.operationId,
        resource,
      );
      if (recoveredSuccess) {
        const result = WorkspacePaneCreateMutationResultSchemaZ.parse({
          operationId: request.operationId,
          daemonInstanceId: this.#daemonInstanceId,
          outcome: "replayed",
          resource,
        });
        this.#operations.set(request.operationId, {
          fingerprint: requestFingerprint,
          status: "success",
          result,
          runtime: recoveredSuccess,
        });
        return result;
      }
      const provisionalName = provisionalWindowName(request.operationId);
      if (
        this.#provisionalRuntimes(workspace.sessionName, provisionalName, request.operationId)
          .length > 0
      ) {
        throw new WorkspacePaneCreationError("pane_resource_changed", {
          operationId: request.operationId,
          workspaceName: workspace.name,
        });
      }
      const createArgs = [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}\t#{window_id}",
        "-t",
        `=${workspace.sessionName}:`,
        "-c",
        canonicalRoot,
        "-n",
        provisionalName,
      ];
      for (const [key, value] of Object.entries(harness?.environment ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        createArgs.push("-e", `${key}=${value}`);
      }
      if (harness) createArgs.push(harness.command.map(shellEscape).join(" "));
      let createOutput: string;
      try {
        createOutput = this.#io.runTmux(createArgs);
      } catch (error) {
        let recovered: RuntimePaneIdentity[];
        try {
          recovered = this.#provisionalRuntimes(
            workspace.sessionName,
            provisionalName,
            request.operationId,
          );
        } catch (recoveryError) {
          throw new WorkspacePaneCreationError(
            "pane_cleanup_unproven",
            { operationId: request.operationId, workspaceName: workspace.name },
            new AggregateError([error, recoveryError], "tmux create and recovery both failed"),
          );
        }
        runtime = recovered[0] ?? null;
        if (!runtime && !this.#io.creationFailureCannotHaveMutated(error)) {
          throw new WorkspacePaneCreationError(
            "pane_cleanup_unproven",
            { operationId: request.operationId, workspaceName: workspace.name },
            error,
          );
        }
        throw error;
      }
      try {
        runtime = parseCreatedRuntime(createOutput, request.operationId, provisionalName);
      } catch (error) {
        let recovered: RuntimePaneIdentity[];
        try {
          recovered = this.#provisionalRuntimes(
            workspace.sessionName,
            provisionalName,
            request.operationId,
          );
        } catch (recoveryError) {
          throw new WorkspacePaneCreationError(
            "pane_cleanup_unproven",
            { operationId: request.operationId, workspaceName: workspace.name },
            new AggregateError([error, recoveryError], "tmux output and recovery both failed"),
          );
        }
        runtime = recovered[0] ?? null;
        if (!runtime) {
          throw new WorkspacePaneCreationError(
            "pane_cleanup_unproven",
            { operationId: request.operationId, workspaceName: workspace.name },
            error,
          );
        }
        throw error;
      }
      this.#assertActive(request.operationId);

      const options: ReadonlyArray<readonly [string, string]> = [
        [CREATION_OPTION, request.operationId],
        [SEMANTIC_PANE_OPTION, resource.semanticPaneId],
        ["@ide_type", resource.kind === "agent" ? "agent" : "shell"],
        ["@ide_role", resource.role ?? "shell"],
        ["@ide_name", resource.displayTitle],
        [HARNESS_OPTION, resource.harnessProfileId ?? ""],
        [MISSION_OPTION, resource.missionId ?? ""],
      ];
      for (const [option, value] of options) {
        this.#io.runTmux(["set-option", "-p", "-t", runtime.paneId, option, value]);
      }
      this.#io.runTmux([
        "rename-window",
        "-t",
        runtime.windowId,
        tmuxFormatLiteral(resource.displayTitle),
      ]);
      const inspected = this.#io.runTmux(inspectArgs(runtime));
      if (!inspectMatches(inspected, runtime, resource)) {
        throw new WorkspacePaneCreationError("pane_creation_failed", {
          operationId: request.operationId,
          workspaceName: workspace.name,
        });
      }
      this.#assertActive(request.operationId);

      const result = WorkspacePaneCreateMutationResultSchemaZ.parse({
        operationId: request.operationId,
        daemonInstanceId: this.#daemonInstanceId,
        outcome: "created",
        resource,
      });
      this.#operations.set(request.operationId, {
        fingerprint: requestFingerprint,
        status: "success",
        result,
        runtime,
      });
      return result;
    } catch (error) {
      const mapped =
        error instanceof WorkspacePaneCreationError
          ? error
          : new WorkspacePaneCreationError(
              runtime ? "pane_creation_failed" : "workspace_unavailable",
              {
                operationId: request.operationId,
                workspaceName: request.intent.workspaceName,
              },
              error,
            );
      if (runtime && !this.#cleanupOwnedWindow(runtime)) {
        return this.#rememberFailure(
          request,
          requestFingerprint,
          new WorkspacePaneCreationError(
            "pane_cleanup_unproven",
            {
              operationId: request.operationId,
              workspaceName: request.intent.workspaceName,
            },
            mapped,
          ),
        );
      }
      return this.#rememberFailure(request, requestFingerprint, mapped);
    }
  }

  #assertActive(operationId?: string): void {
    if (this.#disposed) throw this.#disposedError(operationId);
  }

  #disposedError(operationId?: string): WorkspacePaneCreationError {
    return new WorkspacePaneCreationError("workspace_unavailable", {
      ...(operationId ? { operationId } : {}),
      reason: "authority_disposed",
    });
  }

  #replay(
    existing: OperationRecord,
    request: WorkspacePaneCreateMutationRequest,
    requestFingerprint: string,
  ): WorkspacePaneCreateMutationResult {
    if (existing.fingerprint !== requestFingerprint) {
      throw new WorkspacePaneCreationError("operation_conflict", {
        operationId: request.operationId,
      });
    }
    if (existing.status === "error") throw existing.error;
    try {
      const inspected = this.#io.runTmux(inspectArgs(existing.runtime));
      if (!inspectMatches(inspected, existing.runtime, existing.result.resource)) throw new Error();
    } catch (cause) {
      const changed = new WorkspacePaneCreationError(
        "pane_resource_changed",
        {
          operationId: request.operationId,
          workspaceName: request.intent.workspaceName,
        },
        cause,
      );
      this.#operations.set(request.operationId, {
        fingerprint: requestFingerprint,
        status: "error",
        error: changed,
      });
      throw changed;
    }
    return WorkspacePaneCreateMutationResultSchemaZ.parse({
      ...existing.result,
      outcome: "replayed",
    });
  }

  #cleanupOwnedWindow(runtime: RuntimePaneIdentity): boolean {
    try {
      const proof = this.#io.runTmux([
        "list-panes",
        "-t",
        runtime.windowId,
        "-F",
        `#{pane_id}\t#{${CREATION_OPTION}}\t#{window_name}\t#{window_panes}`,
      ]);
      const [paneId, marker, windowName, paneCount, extra] = proof.split("\t");
      const markerProvesOwnership = marker === runtime.creationId;
      const provisionalNameProvesPreMarkerOwnership =
        marker === "" && windowName === runtime.provisionalWindowName;
      if (
        extra !== undefined ||
        paneId !== runtime.paneId ||
        paneCount !== "1" ||
        (!markerProvesOwnership && !provisionalNameProvesPreMarkerOwnership)
      ) {
        return false;
      }
      this.#io.runTmux(["kill-window", "-t", runtime.windowId]);
      return true;
    } catch {
      // If the exact window is already gone, no created process remains to clean.
      try {
        this.#io.runTmux(["display-message", "-p", "-t", runtime.windowId, "#{window_id}"]);
        return false;
      } catch (error) {
        return this.#io.isMissingTmuxTarget(error);
      }
    }
  }

  #completedRuntime(
    sessionName: string,
    creationId: string,
    resource: WorkspacePaneCreatedResource,
  ): RuntimePaneIdentity | null {
    const output = this.#io.runTmux([
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      ["#{pane_id}", "#{window_id}", `#{${CREATION_OPTION}}`, `#{${SEMANTIC_PANE_OPTION}}`].join(
        "\t",
      ),
    ]);
    if (!output) return null;
    const candidates: RuntimePaneIdentity[] = [];
    for (const line of output.split("\n")) {
      const [paneId, windowId, marker, semanticPaneId, extra] = line.split("\t");
      if (marker !== creationId && semanticPaneId !== resource.semanticPaneId) continue;
      if (
        extra !== undefined ||
        !/^%[0-9]+$/u.test(paneId ?? "") ||
        !/^@[0-9]+$/u.test(windowId ?? "")
      ) {
        throw new WorkspacePaneCreationError("pane_resource_changed", { creationId });
      }
      candidates.push({
        paneId: paneId!,
        windowId: windowId!,
        creationId,
        provisionalWindowName: provisionalWindowName(creationId),
      });
    }
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new WorkspacePaneCreationError("pane_resource_changed", { creationId });
    }
    const runtime = candidates[0]!;
    const inspected = this.#io.runTmux(inspectArgs(runtime));
    if (!inspectMatches(inspected, runtime, resource)) {
      throw new WorkspacePaneCreationError("pane_resource_changed", { creationId });
    }
    const topology = this.#io.runTmux([
      "list-panes",
      "-t",
      runtime.windowId,
      "-F",
      "#{pane_id}\t#{window_panes}",
    ]);
    if (topology !== `${runtime.paneId}\t1`) {
      throw new WorkspacePaneCreationError("pane_resource_changed", { creationId });
    }
    return runtime;
  }

  #provisionalRuntimes(
    sessionName: string,
    expectedWindowName: string,
    creationId: string,
  ): RuntimePaneIdentity[] {
    const output = this.#io.runTmux([
      "list-windows",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{window_id}\t#{window_name}\t#{window_panes}\t#{pane_id}",
    ]);
    if (!output) return [];
    const matches: RuntimePaneIdentity[] = [];
    for (const line of output.split("\n")) {
      const [windowId, windowName, paneCount, paneId, extra] = line.split("\t");
      if (windowName !== expectedWindowName) continue;
      if (
        extra !== undefined ||
        !/^@[0-9]+$/u.test(windowId ?? "") ||
        !/^%[0-9]+$/u.test(paneId ?? "") ||
        paneCount !== "1"
      ) {
        throw new WorkspacePaneCreationError("pane_cleanup_unproven", { creationId });
      }
      matches.push({
        windowId: windowId!,
        paneId: paneId!,
        creationId,
        provisionalWindowName: expectedWindowName,
      });
    }
    if (matches.length > 1) {
      throw new WorkspacePaneCreationError("pane_cleanup_unproven", { creationId });
    }
    return matches;
  }

  #retireClosedResources(): void {
    for (const [operationId, record] of this.#operations) {
      if (record.status !== "success") continue;
      try {
        // A mismatched-but-present pane is retained and will fail closed on
        // replay. Only a typed exact-target absence can retire idempotency.
        const inspected = this.#io.runTmux(inspectArgs(record.runtime));
        if (inspectMatches(inspected, record.runtime, record.result.resource)) continue;
        this.#io.runTmux([
          "list-panes",
          "-t",
          record.runtime.windowId,
          "-F",
          "#{pane_id}\t#{window_id}",
        ]);
      } catch (error) {
        if (this.#io.isMissingTmuxTarget(error)) this.#operations.delete(operationId);
      }
    }
  }

  #rememberFailure(
    request: WorkspacePaneCreateMutationRequest,
    requestFingerprint: string,
    error: WorkspacePaneCreationError,
  ): never {
    const failure: FailedOperation = {
      fingerprint: requestFingerprint,
      status: "error",
      error,
    };
    if (error.code === "pane_cleanup_unproven" || error.code === "pane_resource_changed") {
      this.#operations.set(request.operationId, failure);
    } else {
      this.#replayableFailures.delete(request.operationId);
      this.#replayableFailures.set(request.operationId, failure);
      while (this.#replayableFailures.size > MAX_REPLAYABLE_FAILURES) {
        const oldest = this.#replayableFailures.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#replayableFailures.delete(oldest);
      }
    }
    throw error;
  }
}
