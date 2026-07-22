import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  TerminalAttachmentSemanticTargetSchemaZ,
  TerminalAttachmentViewportSchemaZ,
} from "@tmux-ide/contracts";
import { runTmuxBinary, TmuxError } from "@tmux-ide/tmux-bridge";
import { z } from "zod";

import type { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import type { PtyAdapter } from "../PtyAdapter.ts";
import {
  TerminalAttachmentAdmissionCoordinator,
  type TerminalAttachmentAdmissionCoordinatorOptions,
  type TerminalAttachmentAdmissionSnapshot,
  type TerminalAttachmentGeometry,
  type TerminalAttachmentGeometryClientProof,
} from "./direct-websocket.ts";
import {
  GROUPED_TMUX_MAX_GENERATION,
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  groupedTmuxViewSessionName,
  type TmuxArgvPlan,
} from "./grouped-tmux.ts";
import {
  AttachmentLeaseManager,
  type AttachmentLeaseManagerOptions,
  type AttachmentLeaseDescriptor,
} from "./lease-manager.ts";
import {
  PtyTmuxAttachmentLauncher,
  type DaemonTmuxSocketSelector,
  type PtyTmuxAttachmentLauncherOptions,
} from "./pty-tmux-attachment-launcher.ts";
import {
  SemanticPaneCatalog,
  analyzeTrustedSemanticPaneCatalog,
  type TrustedSemanticPaneCatalogAnalysis,
  type TrustedSemanticPaneSnapshot,
} from "./semantic-pane-catalog.ts";
import {
  TmuxAttachmentOperationSerializer,
  TmuxAttachmentViewExecutor,
  type TmuxAttachmentCommandResult,
  type TmuxAttachmentCommandRunner,
} from "./tmux-view-executor.ts";

const MAX_TMUX_OUTPUT_BYTES = 128 * 1024;
const MAX_DISCOVERED_WORKSPACES = 128;
const MAX_DISCOVERED_PANES = 4_096;
const MAX_GEOMETRY_CLIENTS = 32;
const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_TERMINAL_VALUE = /^(?:xterm|screen|tmux|rxvt|vt100|ansi)[A-Za-z0-9+._-]{0,58}$/u;
const SAFE_COLOR_TERMINAL_VALUE = /^(?:truecolor|24bit)$/u;
const SAFE_LOCALE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const VIEW_MISMATCH = "__tmux_ide_geometry_view_mismatch_v1__";
const SESSION_WIRE_SENTINEL = "tmux-ide-session-v2";
const PANE_WIRE_SENTINEL = "tmux-ide-pane-v2";
const WIRE_SEPARATOR = "|tmux-ide-field-v2|";
const RUNTIME_SESSION_ID = /^\$(?:0|[1-9][0-9]*)$/u;
const RUNTIME_WINDOW_ID = /^@(?:0|[1-9][0-9]*)$/u;
const RUNTIME_PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;

export type NativeTerminalAttachmentRuntimeErrorCode =
  | "invalid-authority"
  | "discovery-failed"
  | "invalid-tmux-output"
  | "geometry-mismatch"
  | "orphan-reconciliation-failed"
  | "runtime-disposed";

const ERROR_MESSAGES: Readonly<Record<NativeTerminalAttachmentRuntimeErrorCode, string>> = {
  "invalid-authority": "The daemon tmux authority is invalid.",
  "discovery-failed": "Trusted semantic pane discovery failed.",
  "invalid-tmux-output": "Trusted tmux discovery returned invalid output.",
  "geometry-mismatch": "Terminal attachment geometry no longer matches its proof.",
  "orphan-reconciliation-failed": "Daemon-owned terminal view startup reconciliation failed.",
  "runtime-disposed": "The native terminal attachment runtime was disposed during startup.",
};

export class NativeTerminalAttachmentRuntimeError extends Error {
  readonly code: NativeTerminalAttachmentRuntimeErrorCode;

  constructor(code: NativeTerminalAttachmentRuntimeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "NativeTerminalAttachmentRuntimeError";
    this.code = code;
  }
}

export interface NativeTerminalAttachmentTmuxAuthority {
  readonly executablePath: string;
  readonly socketSelector: DaemonTmuxSocketSelector;
  readonly trustedCwd: string;
  /** Captured once at factory construction; only validated presentation fields survive. */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface NativeTerminalAttachmentCommandExecutor {
  (
    executable: string,
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly maxBuffer: number;
    },
  ): string | Buffer;
}

interface CanonicalTmuxAuthority {
  readonly executablePath: string;
  readonly socketSelector: DaemonTmuxSocketSelector;
  readonly socketArgv: readonly string[];
  readonly trustedCwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

function presentationEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    TERM: SAFE_TERMINAL_VALUE.test(source.TERM ?? "") ? source.TERM : "xterm-256color",
  };
  if (SAFE_COLOR_TERMINAL_VALUE.test(source.COLORTERM ?? "")) {
    environment.COLORTERM = source.COLORTERM;
  }
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = source[name];
    if (value && SAFE_LOCALE_VALUE.test(value)) environment[name] = value;
  }
  return environment;
}

function canonicalAuthority(input: NativeTerminalAttachmentTmuxAuthority): CanonicalTmuxAuthority {
  try {
    if (!isAbsolute(input.executablePath) || !isAbsolute(input.trustedCwd)) throw new Error();
    const executablePath = realpathSync(input.executablePath);
    const trustedCwd = realpathSync(input.trustedCwd);
    accessSync(executablePath, constants.X_OK);
    if (!statSync(executablePath).isFile() || !statSync(trustedCwd).isDirectory())
      throw new Error();
    let socketSelector: DaemonTmuxSocketSelector;
    let socketArgv: readonly string[];
    if (input.socketSelector.kind === "path") {
      if (!isAbsolute(input.socketSelector.path)) throw new Error();
      const path = realpathSync(input.socketSelector.path);
      if (!statSync(path).isSocket()) throw new Error();
      socketSelector = { kind: "path", path };
      socketArgv = ["-S", path];
    } else {
      if (!SAFE_SESSION_NAME.test(input.socketSelector.name)) throw new Error();
      socketSelector = { kind: "name", name: input.socketSelector.name };
      socketArgv = ["-L", input.socketSelector.name];
    }
    return Object.freeze({
      executablePath,
      socketSelector: Object.freeze(socketSelector),
      socketArgv: Object.freeze([...socketArgv]),
      trustedCwd,
      environment: Object.freeze(presentationEnvironment(input.environment ?? process.env)),
    });
  } catch {
    throw new NativeTerminalAttachmentRuntimeError("invalid-authority");
  }
}

function defaultCommandExecutor(
  executable: string,
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly maxBuffer: number },
): string | Buffer {
  return runTmuxBinary(executable, [...argv], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function pinnedRunner(
  authority: CanonicalTmuxAuthority,
  execute: NativeTerminalAttachmentCommandExecutor,
  startupPolicy: { allowUnavailableDefaultEnumeration: boolean },
): TmuxAttachmentCommandRunner {
  return Object.freeze({
    run(command: TmuxArgvPlan): TmuxAttachmentCommandResult {
      if (command.executable !== "tmux") return { status: "failed" };
      try {
        const stdout = execute(
          authority.executablePath,
          [...authority.socketArgv, ...command.argv],
          {
            cwd: authority.trustedCwd,
            env: authority.environment,
            maxBuffer: MAX_TMUX_OUTPUT_BYTES,
          },
        );
        const value = String(stdout);
        if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TMUX_OUTPUT_BYTES) {
          return { status: "failed" };
        }
        return { status: "ok", stdout: value };
      } catch (error) {
        if (error instanceof TmuxError && error.code === "SESSION_NOT_FOUND") {
          return { status: "not-found" };
        }
        if (
          error instanceof TmuxError &&
          error.code === "TMUX_UNAVAILABLE" &&
          startupPolicy.allowUnavailableDefaultEnumeration &&
          authority.socketSelector.kind === "name" &&
          authority.socketSelector.name === "default" &&
          command.argv.length === 3 &&
          command.argv[0] === "list-sessions" &&
          command.argv[1] === "-F" &&
          command.argv[2] === "#{session_name}|tmux-ide-view-field-v1|#{session_id}"
        ) {
          // A first-run project may have no default tmux server yet. This
          // one construction-time orphan enumeration is equivalent to zero
          // sessions; every other command/socket/registry state stays strict.
          return { status: "not-found" };
        }
        if (error instanceof TmuxError && error.code === "ENVIRONMENT_VARIABLE_NOT_FOUND") {
          return { status: "variable-not-found" };
        }
        return { status: "failed" };
      }
    },
  });
}

function strictLines(stdout: string, maximum: number): readonly string[] {
  if (
    typeof stdout !== "string" ||
    stdout.includes("\0") ||
    Buffer.byteLength(stdout, "utf8") > MAX_TMUX_OUTPUT_BYTES
  ) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  const normalized = stdout.replace(/(?:\r?\n)+$/u, "");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.length > maximum || lines.some((line) => line.includes("\r"))) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  return lines;
}

function positiveInteger(value: string): number {
  if (!INTEGER.test(value)) throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  return parsed;
}

function nonnegativeInteger(value: string): number {
  if (!INTEGER.test(value)) throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  return parsed;
}

function boundedWireValue(value: string, maximum: number, allowEmpty = true): string {
  if (value.length > maximum || (!allowEmpty && value.length === 0) || /[\0\r\n\t]/u.test(value)) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  return value;
}

function viewport(cols: string, rows: string): TerminalAttachmentGeometry["sourceGrid"] {
  try {
    return TerminalAttachmentViewportSchemaZ.parse({
      cols: positiveInteger(cols),
      rows: positiveInteger(rows),
    });
  } catch {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
}

export type NativeTerminalInventoryCatalogIssue =
  | "invalid-runtime-proof"
  | "missing-semantic-stamp"
  | "duplicate-semantic-stamp"
  | "duplicate-runtime-pane-binding";

export interface NativeTerminalInventoryPaneSnapshot extends TrustedSemanticPaneSnapshot {
  readonly sessionName: string;
  readonly index: number;
  readonly title: string;
  readonly currentCommand: string;
  readonly active: boolean;
  readonly role: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly dir: string;
}

export interface NativeTerminalInventorySnapshot {
  readonly panes: readonly NativeTerminalInventoryPaneSnapshot[];
  readonly catalog: TrustedSemanticPaneCatalogAnalysis;
}

export interface NativeApplicationShellSessionSnapshot {
  readonly name: string;
  readonly runtimeSessionId: string;
  readonly dir: string;
  readonly catalogIssue: NativeTerminalInventoryCatalogIssue | null;
  readonly panes: readonly Omit<
    NativeTerminalInventoryPaneSnapshot,
    "workspaceName" | "sessionName" | "sessionId" | "sessionWindowCount" | "dir"
  >[];
}

const SESSION_FORMAT = ["#{session_name}", "#{session_id}", SESSION_WIRE_SENTINEL].join(
  WIRE_SEPARATOR,
);
const PANE_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  "#{window_id}",
  "#{pane_id}",
  "#{window_panes}",
  "#{session_windows}",
  "#{@tmux_ide_pane_id}",
  "#{pane_index}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{window_active}",
  "#{pane_active}",
  "#{@ide_role}",
  "#{@ide_name}",
  "#{@ide_type}",
  "#{pane_current_path}",
  PANE_WIRE_SENTINEL,
].join(WIRE_SEPARATOR);

function requiredTmuxResult(
  runner: TmuxAttachmentCommandRunner,
  argv: readonly string[],
): string | null {
  const result = runner.run({ executable: "tmux", argv });
  if (result.status === "not-found") return null;
  if (result.status !== "ok") {
    throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
  }
  return result.stdout;
}

interface LiveSessionIdentity {
  readonly name: string;
  readonly id: string;
}

function liveSessionIdentities(
  runner: TmuxAttachmentCommandRunner,
): readonly LiveSessionIdentity[] {
  const stdout = requiredTmuxResult(runner, ["list-sessions", "-F", SESSION_FORMAT]);
  if (stdout === null) return [];
  const identities: LiveSessionIdentity[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const line of strictLines(stdout, MAX_DISCOVERED_WORKSPACES * 4)) {
    const fields = line.split(WIRE_SEPARATOR);
    if (fields.length !== 3 || fields[2] !== SESSION_WIRE_SENTINEL) {
      throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
    }
    const name = boundedWireValue(fields[0]!, 160, false);
    const id = fields[1]!;
    if (!RUNTIME_SESSION_ID.test(id) || names.has(name) || ids.has(id)) {
      throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
    }
    names.add(name);
    ids.add(id);
    identities.push({ name, id });
  }
  return identities;
}

type LivePaneFacts = Omit<NativeTerminalInventoryPaneSnapshot, "workspaceName">;

function parsePaneSnapshot(
  stdout: string,
  expected: LiveSessionIdentity,
): readonly LivePaneFacts[] {
  const panes: LivePaneFacts[] = [];
  const runtimeIds = new Set<string>();
  for (const line of strictLines(stdout, MAX_DISCOVERED_PANES)) {
    const fields = line.split(WIRE_SEPARATOR);
    if (fields.length !== 17 || fields[16] !== PANE_WIRE_SENTINEL) {
      throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
    }
    const [
      sessionName,
      sessionId,
      windowId,
      runtimePaneId,
      paneCountValue,
      windowCountValue,
      stamp,
      indexValue,
      title,
      currentCommand,
      windowActive,
      paneActive,
      role,
      name,
      type,
      dir,
    ] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      sessionName !== expected.name ||
      sessionId !== expected.id ||
      !RUNTIME_WINDOW_ID.test(windowId) ||
      !RUNTIME_PANE_ID.test(runtimePaneId) ||
      runtimeIds.has(runtimePaneId) ||
      !["0", "1"].includes(windowActive) ||
      !["0", "1"].includes(paneActive)
    ) {
      throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
    }
    runtimeIds.add(runtimePaneId);
    const nullable = (value: string): string | null =>
      boundedWireValue(value, 256).length === 0 ? null : value;
    panes.push({
      sessionName,
      sessionId,
      windowId,
      runtimePaneId,
      windowPaneCount: positiveInteger(paneCountValue),
      sessionWindowCount: positiveInteger(windowCountValue),
      semanticPaneId: nullable(stamp),
      index: nonnegativeInteger(indexValue),
      title: boundedWireValue(title, 1_024),
      currentCommand: boundedWireValue(currentCommand, 512),
      active: windowActive === "1" && paneActive === "1",
      role: nullable(role),
      name: nullable(name),
      type: nullable(type),
      dir: boundedWireValue(dir, 4_096, false),
    });
  }
  const counts = new Map<string, number>();
  for (const pane of panes) counts.set(pane.windowId, (counts.get(pane.windowId) ?? 0) + 1);
  const windows = new Set(panes.map((pane) => pane.windowId));
  if (
    panes.some(
      (pane) =>
        counts.get(pane.windowId) !== pane.windowPaneCount ||
        windows.size !== pane.sessionWindowCount,
    ) ||
    panes.filter((pane) => pane.active).length > 1
  ) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  return panes;
}

/**
 * One bounded, old-tmux-safe discovery path for both live attachment and the
 * application-shell inventory. Names are resolved exactly to `$session_id`
 * before any pane query, and a byte-identical second snapshot closes races.
 */
export async function discoverWorkspaceRegistryTerminalInventory(
  registry: WorkspaceRegistry,
  runner: TmuxAttachmentCommandRunner,
): Promise<NativeTerminalInventorySnapshot> {
  const workspaces = registry.list();
  if (workspaces.length > MAX_DISCOVERED_WORKSPACES) {
    throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
  }
  if (workspaces.length === 0) {
    const catalog = analyzeTrustedSemanticPaneCatalog([]);
    return Object.freeze({ panes: Object.freeze([]), catalog });
  }
  const liveSessions = liveSessionIdentities(runner);
  const byName = new Map(liveSessions.map((session) => [session.name, session]));
  const uniqueSessionNames = new Set(workspaces.map((workspace) => workspace.sessionName));
  const bySessionName = new Map<string, readonly LivePaneFacts[]>();
  for (const sessionName of uniqueSessionNames) {
    const identity = byName.get(sessionName);
    if (!identity) continue;
    const argv = ["list-panes", "-s", "-t", identity.id, "-F", PANE_FORMAT] as const;
    const before = requiredTmuxResult(runner, argv);
    if (before === null) continue;
    const panes = parsePaneSnapshot(before, identity);
    const after = requiredTmuxResult(runner, argv);
    if (after === null || before !== after) {
      throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
    }
    parsePaneSnapshot(after, identity);
    bySessionName.set(sessionName, panes);
  }

  const panes: NativeTerminalInventoryPaneSnapshot[] = [];
  for (const workspace of workspaces) {
    for (const pane of bySessionName.get(workspace.sessionName) ?? []) {
      panes.push({ ...pane, workspaceName: workspace.name });
      if (panes.length > MAX_DISCOVERED_PANES) {
        throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
      }
    }
  }
  const catalog = analyzeTrustedSemanticPaneCatalog(
    panes.map(
      ({
        sessionName: _sessionName,
        index: _index,
        title: _title,
        currentCommand: _currentCommand,
        active: _active,
        role: _role,
        name: _name,
        type: _type,
        dir: _dir,
        ...row
      }) => row,
    ),
  );
  return Object.freeze({ panes: Object.freeze(panes), catalog });
}

/** Internal raw-id discovery; callers expose only SemanticPaneCatalog resolution. */
export async function discoverWorkspaceRegistrySemanticPanes(
  registry: WorkspaceRegistry,
  runner: TmuxAttachmentCommandRunner,
): Promise<readonly TrustedSemanticPaneSnapshot[]> {
  const inventory = await discoverWorkspaceRegistryTerminalInventory(registry, runner);
  return inventory.panes.map(
    ({
      sessionName: _sessionName,
      index: _index,
      title: _title,
      currentCommand: _currentCommand,
      active: _active,
      role: _role,
      name: _name,
      type: _type,
      dir: _dir,
      ...row
    }) => row,
  );
}

function quoteArgument(value: string): string {
  if (/\0|\r|\n/u.test(value)) {
    throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
  }
  return JSON.stringify(value);
}

function commandString(argv: readonly string[]): string {
  return argv.map((value) => (value === ";" ? ";" : quoteArgument(value))).join(" ");
}

function geometryDescriptorIsValid(
  descriptor: AttachmentLeaseDescriptor,
  client: TerminalAttachmentGeometryClientProof,
): boolean {
  return (
    z.uuid().safeParse(descriptor.leaseId).success &&
    z.uuid().safeParse(descriptor.requestId).success &&
    TerminalAttachmentSemanticTargetSchemaZ.safeParse(descriptor.target).success &&
    descriptor.status === "active" &&
    Number.isSafeInteger(descriptor.bindingGeneration) &&
    descriptor.bindingGeneration >= 0 &&
    Number.isSafeInteger(descriptor.viewGeneration) &&
    descriptor.viewGeneration >= 0 &&
    descriptor.viewGeneration <= GROUPED_TMUX_MAX_GENERATION &&
    z.uuid().safeParse(client.attemptId).success &&
    client.attachmentId === descriptor.leaseId &&
    client.generation === descriptor.viewGeneration &&
    Number.isSafeInteger(client.pid) &&
    client.pid > 0
  );
}

export class NativeTerminalAttachmentGeometryResolver {
  readonly #catalog: SemanticPaneCatalog;
  readonly #runner: TmuxAttachmentCommandRunner;
  readonly #serializer: TmuxAttachmentOperationSerializer;

  constructor(options: {
    catalog: SemanticPaneCatalog;
    runner: TmuxAttachmentCommandRunner;
    operationSerializer: TmuxAttachmentOperationSerializer;
  }) {
    this.#catalog = options.catalog;
    this.#runner = options.runner;
    this.#serializer = options.operationSerializer;
  }

  resolve(
    descriptor: AttachmentLeaseDescriptor,
    client: TerminalAttachmentGeometryClientProof,
  ): Promise<TerminalAttachmentGeometry> {
    return this.#serializer.run(() => this.#resolve(descriptor, client));
  }

  async #resolve(
    descriptor: AttachmentLeaseDescriptor,
    client: TerminalAttachmentGeometryClientProof,
  ): Promise<TerminalAttachmentGeometry> {
    if (!geometryDescriptorIsValid(descriptor, client)) {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    let resolution;
    try {
      resolution = await this.#catalog.resolve(descriptor.target);
    } catch {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    if (
      resolution.bindingGeneration !== descriptor.bindingGeneration ||
      resolution.target.workspaceName !== descriptor.target.workspaceName ||
      resolution.target.semanticPaneId !== descriptor.target.semanticPaneId
    ) {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    const source = resolution.source;
    const viewName = groupedTmuxViewSessionName(descriptor.leaseId, descriptor.viewGeneration);
    const marker = `v1:${descriptor.leaseId.toLowerCase()}:${descriptor.viewGeneration}`;
    const sourceTarget = `${source.sessionId}:${source.windowId}.${source.runtimePaneId}`;
    const viewTarget = `=${viewName}:${source.windowId}.${source.runtimePaneId}`;
    // The `=name` target is exact. The session-local marker then proves that
    // exact view's ownership while the linked global window id and
    // one-window/one-pane topology prove its contents. The exact target
    // already selects the expected global pane id; tmux does not populate
    // `pane_id` in this if-shell format context on all supported versions.
    const viewGuard = `#{&&:#{==:#{window_id},${source.windowId}},#{&&:#{==:#{window_panes},1},#{&&:#{==:#{session_windows},1},#{==:#{${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}},${marker}}}}}`;
    const payload = commandString([
      "display-message",
      "-p",
      "-t",
      sourceTarget,
      "source\t#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}\t#{pane_width}\t#{pane_height}",
      ";",
      "list-clients",
      "-t",
      `=${viewName}`,
      "-F",
      "client\t#{client_pid}\t#{session_name}\t#{client_width}\t#{client_height}",
    ]);
    const result = this.#runner.run({
      executable: "tmux",
      argv: [
        "if-shell",
        "-F",
        "-t",
        viewTarget,
        viewGuard,
        payload,
        commandString(["display-message", "-p", VIEW_MISMATCH]),
      ],
    });
    if (result.status !== "ok") {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    const lines = strictLines(result.stdout, MAX_GEOMETRY_CLIENTS + 1);
    if (lines.length < 2 || lines[0] === VIEW_MISMATCH) {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    const sourceFields = lines[0]!.split("\t");
    if (
      sourceFields.length !== 7 ||
      sourceFields[0] !== "source" ||
      sourceFields[1] !== source.sessionId ||
      sourceFields[2] !== source.windowId ||
      sourceFields[3] !== source.runtimePaneId ||
      sourceFields[4] !== "1"
    ) {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    const sourceGrid = viewport(sourceFields[5]!, sourceFields[6]!);
    const clients = lines.slice(1).map((line) => line.split("\t"));
    if (
      clients.length !== 1 ||
      clients[0]!.length !== 5 ||
      clients[0]![0] !== "client" ||
      !INTEGER.test(clients[0]![1]!) ||
      Number(clients[0]![1]) !== client.pid ||
      clients[0]![2] !== viewName
    ) {
      throw new NativeTerminalAttachmentRuntimeError("geometry-mismatch");
    }
    const clientViewport = viewport(clients[0]![3]!, clients[0]![4]!);
    return Object.freeze({ sourceGrid, clientViewport });
  }
}

type LeaseRuntimeOptions = Omit<
  AttachmentLeaseManagerOptions,
  "daemonInstanceId" | "catalog" | "viewExecutor"
>;
type LauncherRuntimeOptions = Omit<
  PtyTmuxAttachmentLauncherOptions,
  | "socketSelector"
  | "trustedCwd"
  | "tmuxExecutable"
  | "environment"
  | "ptyAdapter"
  | "proofRunner"
  | "proofCommandExecutor"
>;
type AdmissionRuntimeOptions = Omit<
  TerminalAttachmentAdmissionCoordinatorOptions,
  | "daemonInstanceId"
  | "webSocketUrl"
  | "leaseManager"
  | "launcher"
  | "resolveGeometry"
  | "startupBarrier"
>;

export interface NativeTerminalAttachmentRuntimeOptions {
  readonly daemonInstanceId: string;
  readonly webSocketUrl: string;
  readonly registry: WorkspaceRegistry;
  readonly tmuxAuthority: NativeTerminalAttachmentTmuxAuthority;
  readonly ptyAdapter?: PtyAdapter;
  readonly commandExecutor?: NativeTerminalAttachmentCommandExecutor;
  /** Narrow deterministic seam; production omits it and uses registry-backed discovery. */
  readonly semanticPaneCatalog?: SemanticPaneCatalog;
  readonly lease?: LeaseRuntimeOptions;
  readonly launcher?: LauncherRuntimeOptions;
  readonly admission?: AdmissionRuntimeOptions;
}

/** One daemon-generation owner for catalog, grouped view, PTY, lease and admission state. */
export class NativeTerminalAttachmentRuntime {
  readonly admission: TerminalAttachmentAdmissionCoordinator;
  readonly #launcher: PtyTmuxAttachmentLauncher;
  readonly #startupBarrier: Promise<void>;
  readonly #serializer: TmuxAttachmentOperationSerializer;
  readonly #registry: WorkspaceRegistry;
  readonly #discoverTerminalInventory: () => Promise<NativeTerminalInventorySnapshot>;
  #lifecycle: "initializing" | "ready" | "failed" | "disposing" | "disposed" = "initializing";
  #disposePromise: Promise<void> | null = null;

  constructor(options: NativeTerminalAttachmentRuntimeOptions) {
    const authority = canonicalAuthority(options.tmuxAuthority);
    const execute = options.commandExecutor ?? defaultCommandExecutor;
    const startupPolicy = {
      allowUnavailableDefaultEnumeration:
        authority.socketSelector.kind === "name" &&
        authority.socketSelector.name === "default" &&
        options.registry.list().length === 0,
    };
    const runner = pinnedRunner(authority, execute, startupPolicy);
    const discoverTerminalInventory = () =>
      discoverWorkspaceRegistryTerminalInventory(options.registry, runner);
    const serializer = new TmuxAttachmentOperationSerializer();
    const catalog =
      options.semanticPaneCatalog ??
      new SemanticPaneCatalog({
        discover: async () => {
          const inventory = await discoverTerminalInventory();
          return inventory.panes.map(
            ({
              sessionName: _sessionName,
              index: _index,
              title: _title,
              currentCommand: _currentCommand,
              active: _active,
              role: _role,
              name: _name,
              type: _type,
              dir: _dir,
              ...row
            }) => row,
          );
        },
      });
    const launcher = new PtyTmuxAttachmentLauncher({
      ...options.launcher,
      socketSelector: authority.socketSelector,
      trustedCwd: authority.trustedCwd,
      tmuxExecutable: authority.executablePath,
      environment: authority.environment,
      ptyAdapter: options.ptyAdapter,
      proofCommandExecutor: (executable, argv, executionOptions) =>
        execute(executable, argv, {
          cwd: executionOptions.cwd,
          env: executionOptions.env,
          maxBuffer: MAX_TMUX_OUTPUT_BYTES,
        }),
    });
    const viewExecutor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: launcher,
      operationSerializer: serializer,
      now: options.lease?.now,
    });
    const leaseManager = new AttachmentLeaseManager({
      ...options.lease,
      daemonInstanceId: options.daemonInstanceId,
      catalog,
      viewExecutor,
    });
    const geometry = new NativeTerminalAttachmentGeometryResolver({
      catalog,
      runner,
      operationSerializer: serializer,
    });
    this.#startupBarrier = leaseManager
      .reconcileOrphanViews()
      .then((result) => {
        startupPolicy.allowUnavailableDefaultEnumeration = false;
        if (result.failed.length > 0) {
          throw new NativeTerminalAttachmentRuntimeError("orphan-reconciliation-failed");
        }
        if (this.#lifecycle !== "initializing") {
          throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
        }
        this.#lifecycle = "ready";
      })
      .catch((error: unknown) => {
        startupPolicy.allowUnavailableDefaultEnumeration = false;
        if (this.#lifecycle === "initializing") this.#lifecycle = "failed";
        if (error instanceof NativeTerminalAttachmentRuntimeError) throw error;
        throw new NativeTerminalAttachmentRuntimeError("orphan-reconciliation-failed");
      });
    // Startup begins at construction so no caller can expose admission before
    // reconciliation starts. The rejection remains observable via whenReady()
    // and admission.issue(); this prevents an unawaited runtime from emitting
    // a process-level unhandled rejection first.
    void this.#startupBarrier.catch(() => undefined);
    this.admission = new TerminalAttachmentAdmissionCoordinator({
      ...options.admission,
      daemonInstanceId: options.daemonInstanceId,
      webSocketUrl: options.webSocketUrl,
      leaseManager,
      launcher,
      startupBarrier: this.#startupBarrier,
      resolveGeometry: (descriptor, client) => geometry.resolve(descriptor, client),
    });
    this.#launcher = launcher;
    this.#serializer = serializer;
    this.#registry = options.registry;
    this.#discoverTerminalInventory = discoverTerminalInventory;
  }

  /**
   * Exact registry-session inventory for ApplicationShell V2. The runtime and
   * attachment catalog intentionally share the same pinned runner, socket and
   * global trust analyzer.
   */
  async discoverApplicationShellSession(
    requestedSessionName: string,
  ): Promise<NativeApplicationShellSessionSnapshot | null> {
    const memberships = this.#registry
      .list()
      .filter((workspace) => workspace.sessionName === requestedSessionName);
    if (memberships.length === 0) return null;
    if (memberships.length !== 1) {
      throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
    }
    const workspace = memberships[0]!;
    const inventory = await this.#discoverTerminalInventory();
    const panes = inventory.panes.filter(
      (pane) => pane.workspaceName === workspace.name && pane.sessionName === workspace.sessionName,
    );
    if (panes.length === 0) return null;
    const active = panes.find((pane) => pane.active) ?? panes[0]!;
    const catalogIssue: NativeTerminalInventoryCatalogIssue | null = inventory.catalog
      .invalidRuntimeProof
      ? "invalid-runtime-proof"
      : inventory.catalog.missingSemanticStamp
        ? "missing-semantic-stamp"
        : inventory.catalog.duplicateSemanticStamp
          ? "duplicate-semantic-stamp"
          : inventory.catalog.duplicateRuntimePaneBinding
            ? "duplicate-runtime-pane-binding"
            : null;
    return Object.freeze({
      name: workspace.sessionName,
      runtimeSessionId: active.sessionId,
      dir: active.dir,
      catalogIssue,
      panes: Object.freeze(
        panes.map(
          ({
            workspaceName: _workspaceName,
            sessionName: _sessionName,
            sessionId: _sessionId,
            sessionWindowCount: _sessionWindowCount,
            dir: _dir,
            ...pane
          }) => Object.freeze(pane),
        ),
      ),
    });
  }

  snapshot(): TerminalAttachmentAdmissionSnapshot {
    return this.admission.snapshot();
  }

  toJSON(): TerminalAttachmentAdmissionSnapshot {
    return this.snapshot();
  }

  /** A2 must await this barrier before exposing HTTP or WebSocket listeners. */
  whenReady(): Promise<void> {
    return this.#startupBarrier;
  }

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#lifecycle = "disposing";
      this.#disposePromise = this.#finishDispose();
    }
    return this.#disposePromise;
  }

  async #finishDispose(): Promise<void> {
    try {
      const admissionBarrier = this.admission.shutdown();
      // Cancel an attach readiness wait immediately; the coordinator barrier
      // then retires the associated lease/view before this method resolves.
      this.#launcher.disposeAll();
      await Promise.all([admissionBarrier, this.#startupBarrier.catch(() => undefined)]);
      this.#launcher.disposeAll();
      await this.#serializer.barrier();
    } finally {
      this.#lifecycle = "disposed";
    }
  }
}

export function createNativeTerminalAttachmentRuntime(
  options: NativeTerminalAttachmentRuntimeOptions,
): NativeTerminalAttachmentRuntime {
  return new NativeTerminalAttachmentRuntime(options);
}
