import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  TerminalAttachmentSemanticTargetSchemaZ,
  TerminalAttachmentViewportSchemaZ,
} from "@tmux-ide/contracts";
import { runTmuxBinary, TmuxError } from "@tmux-ide/tmux-bridge";
import { z } from "zod";

import type { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import type { PtyAdapter } from "../PtyAdapter.ts";
import type { TrustedMirrorSessionInventory } from "../mirror/trusted-inventory.ts";
import type {
  SessionRuntimeRegistry,
  TrustedSessionInventoryCandidate,
} from "../session-runtime/registry.ts";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  type SessionRuntimeObservability,
} from "../session-runtime/runtime-observability.ts";
import { SessionRuntimeTransportBinder } from "../session-runtime/transport-binding.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
  type UnixSocketIdentity,
} from "../../lib/unix-socket-authority.ts";
import {
  TerminalAttachmentAdmissionCoordinator,
  type TerminalAttachmentAdmissionCoordinatorOptions,
  type TerminalAttachmentAdmissionSnapshot,
  type TerminalAttachmentGeometry,
  type TerminalAttachmentGeometryClientProof,
} from "./direct-websocket.ts";
import {
  GROUPED_TMUX_MAX_GENERATION,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
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
import type { AgentStatusPaneFacts, AgentStatusProbe } from "./agent-status-probe.ts";

const MAX_TMUX_OUTPUT_BYTES = 128 * 1024;
const TERMINAL_ATTACHMENT_TMUX_COMMAND_TIMEOUT_MS = 5_000;
const STARTUP_ORPHAN_ENUMERATION_ATTEMPTS = 2;
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

let nativeTerminalAttachmentRuntimeConstructions = 0;

/** Test/diagnostic proof that normal pane-stream startup did not construct compatibility PTYs. */
export function getNativeTerminalAttachmentRuntimeConstructionCount(): number {
  return nativeTerminalAttachmentRuntimeConstructions;
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
      readonly timeoutMs: number;
    },
  ): string | Buffer;
}

export interface NativeTerminalInventoryReadCommandExecutor {
  (
    executable: string,
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly maxBuffer: number;
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<string | Buffer>;
}

export interface NativeTerminalInventoryReadRunner {
  readonly run: (
    command: TmuxArgvPlan,
    signal?: AbortSignal,
  ) => Promise<TmuxAttachmentCommandResult>;
}

interface CanonicalTmuxAuthority {
  readonly executablePath: string;
  readonly socketSelector: DaemonTmuxSocketSelector;
  readonly socketArgv: readonly string[];
  readonly socketIdentity: UnixSocketIdentity | null;
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
    let socketIdentity: UnixSocketIdentity | null = null;
    if (input.socketSelector.kind === "path") {
      socketIdentity = captureUnixSocketIdentity(input.socketSelector.path);
      const path = socketIdentity.path;
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
      socketIdentity,
      trustedCwd,
      environment: Object.freeze(presentationEnvironment(input.environment ?? process.env)),
    });
  } catch {
    throw new NativeTerminalAttachmentRuntimeError("invalid-authority");
  }
}

function currentSocketArgv(authority: CanonicalTmuxAuthority): readonly string[] {
  return authority.socketIdentity
    ? ["-S", revalidateUnixSocketIdentity(authority.socketIdentity)]
    : authority.socketArgv;
}

function defaultCommandExecutor(
  executable: string,
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly timeoutMs: number;
  },
): string | Buffer {
  return runTmuxBinary(executable, [...argv], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });
}

function defaultReadCommandExecutor(
  executable: string,
  argv: readonly string[],
  options: Parameters<NativeTerminalInventoryReadCommandExecutor>[2],
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...argv],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: options.maxBuffer,
        timeout: options.timeoutMs,
        signal: options.signal,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
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
          [...currentSocketArgv(authority), ...command.argv],
          {
            cwd: authority.trustedCwd,
            env: authority.environment,
            maxBuffer: MAX_TMUX_OUTPUT_BYTES,
            timeoutMs: TERMINAL_ATTACHMENT_TMUX_COMMAND_TIMEOUT_MS,
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
          // The daemon may cold-start before the default tmux server even when
          // durable workspace intent exists. This one construction-time orphan
          // enumeration means zero LIVE sessions; every other command and
          // every explicit socket remains strict.
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

function readErrorCode(error: unknown): string {
  if (error instanceof TmuxError) return error.code;
  const raw = (error as { stderr?: string | Buffer })?.stderr;
  const detail = (
    Buffer.isBuffer(raw) ? raw.toString("utf8") : (raw ?? String(error))
  ).toLowerCase();
  if (
    ["can't find session", "can't find window", "can't find pane", "unknown target"].some((v) =>
      detail.includes(v),
    )
  )
    return "SESSION_NOT_FOUND";
  if (detail.includes("unknown variable:")) return "ENVIRONMENT_VARIABLE_NOT_FOUND";
  if (
    [
      "failed to connect to server",
      "no server running",
      "error connecting to",
      "connection refused",
    ].some((v) => detail.includes(v))
  )
    return "TMUX_UNAVAILABLE";
  return "TMUX_ERROR";
}

function pinnedReadRunner(
  authority: CanonicalTmuxAuthority,
  execute: NativeTerminalInventoryReadCommandExecutor,
): NativeTerminalInventoryReadRunner {
  return Object.freeze({
    async run(command: TmuxArgvPlan, signal?: AbortSignal): Promise<TmuxAttachmentCommandResult> {
      if (command.executable !== "tmux" || signal?.aborted) return { status: "failed" };
      try {
        const stdout = await execute(
          authority.executablePath,
          [...currentSocketArgv(authority), ...command.argv],
          {
            cwd: authority.trustedCwd,
            env: authority.environment,
            maxBuffer: MAX_TMUX_OUTPUT_BYTES,
            timeoutMs: TERMINAL_ATTACHMENT_TMUX_COMMAND_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          },
        );
        const value = String(stdout);
        if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TMUX_OUTPUT_BYTES)
          return { status: "failed" };
        return { status: "ok", stdout: value };
      } catch (error) {
        const code = readErrorCode(error);
        if (code === "SESSION_NOT_FOUND") return { status: "not-found" };
        if (code === "ENVIRONMENT_VARIABLE_NOT_FOUND") return { status: "variable-not-found" };
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
  /** Durable `@tmux_ide_mission` creation stamp, or null when unset. */
  readonly missionStamp: string | null;
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
  readonly panes: readonly (Omit<
    NativeTerminalInventoryPaneSnapshot,
    "workspaceName" | "sessionName" | "sessionId" | "sessionWindowCount" | "dir"
  > &
    Partial<AgentStatusPaneFacts>)[];
}

/** Agent-free topology facts used by the terminal-runtime inventory resource. */
export interface NativeTerminalRuntimeSessionSnapshot extends NativeApplicationShellSessionSnapshot {
  readonly workspaceName: string;
}

function projectTrustedMirrorInventory(
  trusted: TrustedMirrorSessionInventory,
  workspaceName: string,
  expectedSessionName: string,
): readonly NativeTerminalInventoryPaneSnapshot[] {
  if (
    typeof trusted !== "object" ||
    trusted === null ||
    typeof trusted.sessionName !== "string" ||
    typeof trusted.runtimeSessionId !== "string" ||
    !Array.isArray(trusted.panes) ||
    trusted.sessionName !== expectedSessionName ||
    !RUNTIME_SESSION_ID.test(trusted.runtimeSessionId) ||
    trusted.panes.length === 0 ||
    trusted.panes.length > MAX_DISCOVERED_PANES ||
    Buffer.byteLength(JSON.stringify(trusted), "utf8") > MAX_TMUX_OUTPUT_BYTES
  ) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  const runtimePaneIds = new Set<string>();
  const windowCounts = new Map<string, number>();
  let activeCount = 0;
  const panes = trusted.panes.map((pane) => {
    if (
      typeof pane !== "object" ||
      pane === null ||
      typeof pane.runtimeSessionId !== "string" ||
      typeof pane.runtimeWindowId !== "string" ||
      typeof pane.runtimePaneId !== "string" ||
      typeof pane.semanticWindowId !== "string" ||
      typeof pane.semanticPaneId !== "string" ||
      typeof pane.title !== "string" ||
      typeof pane.currentCommand !== "string" ||
      typeof pane.dir !== "string" ||
      typeof pane.active !== "boolean" ||
      (pane.role !== null && typeof pane.role !== "string") ||
      (pane.name !== null && typeof pane.name !== "string") ||
      (pane.type !== null && typeof pane.type !== "string") ||
      (pane.missionStamp !== null && typeof pane.missionStamp !== "string") ||
      pane.runtimeSessionId !== trusted.runtimeSessionId ||
      !RUNTIME_WINDOW_ID.test(pane.runtimeWindowId) ||
      !RUNTIME_PANE_ID.test(pane.runtimePaneId) ||
      runtimePaneIds.has(pane.runtimePaneId) ||
      !Number.isSafeInteger(pane.windowPaneCount) ||
      pane.windowPaneCount < 1 ||
      !Number.isSafeInteger(pane.sessionWindowCount) ||
      pane.sessionWindowCount < 1 ||
      !Number.isSafeInteger(pane.paneIndex) ||
      pane.paneIndex < 0
    ) {
      throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
    }
    runtimePaneIds.add(pane.runtimePaneId);
    windowCounts.set(pane.runtimeWindowId, (windowCounts.get(pane.runtimeWindowId) ?? 0) + 1);
    if (pane.active) activeCount += 1;
    const nullable = (value: string | null): string | null =>
      value === null ? null : boundedWireValue(value, 256);
    return Object.freeze({
      workspaceName,
      semanticPaneId: nullable(pane.semanticPaneId),
      windowStamp: nullable(pane.semanticWindowId),
      sessionId: pane.runtimeSessionId,
      windowId: pane.runtimeWindowId,
      runtimePaneId: pane.runtimePaneId,
      windowPaneCount: pane.windowPaneCount,
      sessionWindowCount: pane.sessionWindowCount,
      sessionName: boundedWireValue(trusted.sessionName, 160, false),
      index: pane.paneIndex,
      title: boundedWireValue(pane.title, 1_024),
      currentCommand: boundedWireValue(pane.currentCommand, 512),
      active: pane.active,
      role: nullable(pane.role),
      name: nullable(pane.name),
      type: nullable(pane.type),
      missionStamp: nullable(pane.missionStamp),
      dir: boundedWireValue(pane.dir, 4_096),
    });
  });
  if (
    activeCount !== 1 ||
    panes.some(
      (pane) =>
        pane.windowPaneCount !== windowCounts.get(pane.windowId) ||
        pane.sessionWindowCount !== windowCounts.size,
    )
  ) {
    throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
  }
  return Object.freeze(panes);
}

async function awaitInventoryUnlessAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
  let rejectAbort!: (cause: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void =>
    rejectAbort(new NativeTerminalAttachmentRuntimeError("runtime-disposed"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  "#{@tmux_ide_mission}",
  "#{pane_current_path}",
  // Durable window stamp (m41). It is a WINDOW option, so every pane of a
  // window reports the same value; the catalog requires it before a multi-pane
  // window is attachable.
  "#{@tmux_ide_window_id}",
  PANE_WIRE_SENTINEL,
].join(WIRE_SEPARATOR);

async function requiredTmuxResult(
  runner: NativeTerminalInventoryReadRunner,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runner.run({ executable: "tmux", argv }, signal);
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

async function liveSessionIdentities(
  runner: NativeTerminalInventoryReadRunner,
  signal?: AbortSignal,
): Promise<readonly LiveSessionIdentity[]> {
  const stdout = await requiredTmuxResult(runner, ["list-sessions", "-F", SESSION_FORMAT], signal);
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
    if (fields.length !== 19 || fields[18] !== PANE_WIRE_SENTINEL) {
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
      missionStamp,
      dir,
      windowStampValue,
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
      windowStamp: nullable(windowStampValue),
      index: nonnegativeInteger(indexValue),
      title: boundedWireValue(title, 1_024),
      currentCommand: boundedWireValue(currentCommand, 512),
      active: windowActive === "1" && paneActive === "1",
      role: nullable(role),
      name: nullable(name),
      type: nullable(type),
      missionStamp: nullable(missionStamp),
      // tmux can temporarily report an empty pane_current_path for a valid
      // foreground pipeline after its process-group leader exits. The
      // registered workspace remains the trusted application-shell root, so
      // keep discovery available and carry the empty presentation value.
      dir: boundedWireValue(dir, 4_096),
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
  runner: NativeTerminalInventoryReadRunner,
  signal?: AbortSignal,
): Promise<NativeTerminalInventorySnapshot> {
  const workspaces = registry.list();
  if (workspaces.length > MAX_DISCOVERED_WORKSPACES) {
    throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
  }
  if (workspaces.length === 0) {
    const catalog = analyzeTrustedSemanticPaneCatalog([]);
    return Object.freeze({ panes: Object.freeze([]), catalog });
  }
  const liveSessions = await liveSessionIdentities(runner, signal);
  const byName = new Map(liveSessions.map((session) => [session.name, session]));
  const uniqueSessionNames = new Set(workspaces.map((workspace) => workspace.sessionName));
  const bySessionName = new Map<string, readonly LivePaneFacts[]>();
  for (const sessionName of uniqueSessionNames) {
    const identity = byName.get(sessionName);
    if (!identity) continue;
    const argv = ["list-panes", "-s", "-t", identity.id, "-F", PANE_FORMAT] as const;
    const before = await requiredTmuxResult(runner, argv, signal);
    if (before === null) continue;
    const panes = parsePaneSnapshot(before, identity);
    const after = await requiredTmuxResult(runner, argv, signal);
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
        missionStamp: _missionStamp,
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
  runner: NativeTerminalInventoryReadRunner,
  signal?: AbortSignal,
): Promise<readonly TrustedSemanticPaneSnapshot[]> {
  const inventory = await discoverWorkspaceRegistryTerminalInventory(registry, runner, signal);
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
      missionStamp: _missionStamp,
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
    // exact view's ownership while the linked global window id and single-window
    // topology prove its contents. The exact target already selects the expected
    // global pane id; tmux does not populate `pane_id` in this if-shell format
    // context on all supported versions. m41 attach-2 drops the former
    // `window_panes == 1` gate so a multi-pane linked window resolves; the
    // render grid is the WHOLE window, so the payload reports window dimensions.
    const viewGuard = `#{&&:#{==:#{window_id},${source.windowId}},#{&&:#{==:#{session_windows},1},#{==:#{${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}},${marker}}}}`;
    const payload = commandString([
      "display-message",
      "-p",
      "-t",
      sourceTarget,
      "source\t#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}\t#{window_width}\t#{window_height}",
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
    // `window_panes` is now bound to the resolved windowPaneCount instead of the
    // literal 1, so a live topology change between resolution and geometry fails
    // closed. `sourceGrid` is the window's dimensions (the render grid), not one
    // pane's; the client viewport below is already window-level.
    if (
      sourceFields.length !== 7 ||
      sourceFields[0] !== "source" ||
      sourceFields[1] !== source.sessionId ||
      sourceFields[2] !== source.windowId ||
      sourceFields[3] !== source.runtimePaneId ||
      sourceFields[4] !== String(source.windowPaneCount)
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

export interface WorkspaceTerminalInventoryRuntimeOptions {
  readonly registry: WorkspaceRegistry;
  readonly sessionRuntimeRegistry?: SessionRuntimeRegistry;
  readonly tmuxAuthority: NativeTerminalAttachmentTmuxAuthority;
  readonly commandExecutor?: NativeTerminalAttachmentCommandExecutor;
  readonly readCommandExecutor?: NativeTerminalInventoryReadCommandExecutor;
  readonly semanticPaneCatalog?: SemanticPaneCatalog;
  readonly agentStatusProbe?: AgentStatusProbe;
  readonly agentStatusProbeFactory?: (deps: {
    readonly run: (argv: readonly string[], signal?: AbortSignal) => Promise<string | null>;
  }) => AgentStatusProbe;
  /** Opt-in bounded daemon qualification spans; production normally uses the disabled singleton. */
  readonly observability?: SessionRuntimeObservability;
  readonly onInventory?: (snapshot: NativeTerminalInventorySnapshot) => void;
  readonly onSessionInventory?: (
    sessionName: string,
    snapshot: NativeTerminalInventorySnapshot | null,
  ) => void;
}

/**
 * Startup enumeration is read-only and safe to repeat. A cold contender fleet
 * can exhaust the first synchronous tmux command's deadline while losing Node
 * processes are still being scheduled; one fresh read avoids publishing a
 * failed daemon generation without weakening the fail-closed cleanup policy.
 */
async function enumerateStartupMarkedViews(
  executor: TmuxAttachmentViewExecutor,
): Promise<Awaited<ReturnType<TmuxAttachmentViewExecutor["enumerateMarkedViews"]>>> {
  let failure: unknown;
  for (let attempt = 0; attempt < STARTUP_ORPHAN_ENUMERATION_ATTEMPTS; attempt += 1) {
    try {
      return await executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      );
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/**
 * Daemon-owned semantic inventory authority. It deliberately has no PTY,
 * grouped-view, attachment lease, or admission dependency, so Web/OpenTUI
 * startup can discover and mirror ordinary tmux without constructing the
 * legacy attachment stack.
 */
export class WorkspaceTerminalInventoryRuntime {
  readonly semanticPaneCatalog: SemanticPaneCatalog;
  readonly runner: TmuxAttachmentCommandRunner;
  readonly readRunner: NativeTerminalInventoryReadRunner;
  readonly #registry: WorkspaceRegistry;
  readonly #discoverTerminalInventory: (
    signal?: AbortSignal,
  ) => Promise<NativeTerminalInventorySnapshot>;
  readonly #agentStatusProbe: AgentStatusProbe | null;
  readonly #observability: SessionRuntimeObservability;
  readonly #onInventory: ((snapshot: NativeTerminalInventorySnapshot) => void) | null;
  readonly #onSessionInventory:
    | ((sessionName: string, snapshot: NativeTerminalInventorySnapshot | null) => void)
    | null;
  readonly #prewarmSessionRuntime:
    | ((sessionName: string, runtimeSessionId: string, signal: AbortSignal) => Promise<void>)
    | null;
  readonly #discoverTrustedSessionInventory:
    | ((sessionName: string, signal: AbortSignal) => Promise<TrustedSessionInventoryCandidate>)
    | null;
  readonly #trustedSessionInventoryCurrent:
    | ((sessionName: string, token: object) => boolean)
    | null;
  readonly #observeWorkspaceSession: ((workspaceName: string, sessionName: string) => void) | null;
  readonly #stopWorkspaceAddedObserver: (() => void) | null;
  readonly #stopWorkspaceRemovedObserver: (() => void) | null;
  readonly #orphanBarrier: Promise<void>;
  #inventoryEpoch = 0;
  #inventoryRead: {
    readonly epoch: number;
    readonly abort: AbortController;
    readonly promise: Promise<NativeTerminalInventorySnapshot>;
  } | null = null;
  readonly #applicationReads = new Map<
    string,
    {
      readonly epoch: number;
      readonly abort: AbortController;
      readonly promise: Promise<NativeApplicationShellSessionSnapshot | null>;
    }
  >();
  #lifecycle: "initializing" | "ready" | "failed" | "disposed" = "initializing";
  #disposed = false;

  constructor(options: WorkspaceTerminalInventoryRuntimeOptions) {
    const authority = canonicalAuthority(options.tmuxAuthority);
    const execute = options.commandExecutor ?? defaultCommandExecutor;
    const executeRead = options.readCommandExecutor ?? defaultReadCommandExecutor;
    this.runner = pinnedRunner(authority, execute, {
      allowUnavailableDefaultEnumeration: true,
    });
    this.readRunner = pinnedReadRunner(authority, executeRead);
    this.#registry = options.registry;
    this.#observability = options.observability ?? DISABLED_SESSION_RUNTIME_OBSERVABILITY;
    this.#onInventory = options.onInventory ?? null;
    this.#onSessionInventory = options.onSessionInventory ?? null;
    this.#discoverTerminalInventory = (signal) => this.#readInventory(signal);
    this.semanticPaneCatalog =
      options.semanticPaneCatalog ??
      new SemanticPaneCatalog({
        discover: async () => {
          const inventory = await this.#discoverTerminalInventory();
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
              missionStamp: _missionStamp,
              dir: _dir,
              ...row
            }) => row,
          );
        },
      });
    const orphanExecutor = new TmuxAttachmentViewExecutor({ runner: this.runner });
    this.#orphanBarrier = enumerateStartupMarkedViews(orphanExecutor)
      .then(async (candidates) => {
        for (const candidate of candidates) {
          const marker = candidate.markerValue?.match(
            /^v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*)$/u,
          );
          if (!marker || candidate.windowIds.length !== 1) continue;
          const generation = Number(marker[2]);
          if (
            !Number.isSafeInteger(generation) ||
            generation > GROUPED_TMUX_MAX_GENERATION ||
            groupedTmuxViewSessionName(marker[1]!, generation) !== candidate.viewSessionName
          ) {
            continue;
          }
          const result = await orphanExecutor.guardedCleanup({
            exactViewSessionTarget: `=${candidate.viewSessionName}`,
            markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
            expectedMarkerValue: candidate.markerValue!,
            expectedWindowId: candidate.windowIds[0]!,
          });
          if (result !== "cleaned" && result !== "absent") {
            throw new NativeTerminalAttachmentRuntimeError("orphan-reconciliation-failed");
          }
        }
        if (!this.#disposed) this.#lifecycle = "ready";
      })
      .catch((error: unknown) => {
        if (!this.#disposed) this.#lifecycle = "failed";
        if (error instanceof NativeTerminalAttachmentRuntimeError) throw error;
        throw new NativeTerminalAttachmentRuntimeError("orphan-reconciliation-failed");
      });
    void this.#orphanBarrier.catch(() => undefined);
    this.#agentStatusProbe =
      options.agentStatusProbe ??
      (options.agentStatusProbeFactory
        ? options.agentStatusProbeFactory({
            run: async (argv, signal) => {
              const result = await this.readRunner.run({ executable: "tmux", argv }, signal);
              return result.status === "ok" ? result.stdout : null;
            },
          })
        : null);
    const sessionsByWorkspace = new Map(
      options.registry.list().map((workspace) => [workspace.name, workspace.sessionName]),
    );
    if (options.sessionRuntimeRegistry) {
      const sessionRuntimeRegistry = options.sessionRuntimeRegistry;
      this.#prewarmSessionRuntime = (sessionName, runtimeSessionId, signal) => {
        const qualify = sessionRuntimeRegistry.prewarmProofQualifiedSession;
        return (
          typeof qualify === "function"
            ? qualify.call(sessionRuntimeRegistry, sessionName, runtimeSessionId, signal)
            : sessionRuntimeRegistry.prewarmSession(sessionName, signal)
        ).then(() => undefined);
      };
      this.#discoverTrustedSessionInventory =
        typeof sessionRuntimeRegistry.describeTrustedSessionInventoryCandidate === "function"
          ? (sessionName, signal) =>
              sessionRuntimeRegistry.describeTrustedSessionInventoryCandidate(sessionName, signal)
          : typeof sessionRuntimeRegistry.describeTrustedSessionInventory === "function"
            ? (sessionName, signal) =>
                sessionRuntimeRegistry
                  .describeTrustedSessionInventory(sessionName, signal)
                  .then((inventory) => ({ inventory, token: Object.freeze({}) }))
            : null;
      this.#trustedSessionInventoryCurrent =
        typeof sessionRuntimeRegistry.isTrustedSessionInventoryCandidateCurrent === "function"
          ? (sessionName, token) =>
              sessionRuntimeRegistry.isTrustedSessionInventoryCandidateCurrent(sessionName, token)
          : typeof sessionRuntimeRegistry.hasProofQualifiedInventory === "function"
            ? (sessionName) => sessionRuntimeRegistry.hasProofQualifiedInventory(sessionName)
            : null;
      this.#observeWorkspaceSession = (workspaceName, sessionName) => {
        const previousSessionName = sessionsByWorkspace.get(workspaceName);
        sessionsByWorkspace.set(workspaceName, sessionName);
        if (
          previousSessionName &&
          previousSessionName !== sessionName &&
          ![...sessionsByWorkspace.values()].some((candidate) => candidate === previousSessionName)
        ) {
          void sessionRuntimeRegistry.retireSession(previousSessionName).catch(() => undefined);
        }
      };
    } else {
      this.#prewarmSessionRuntime = null;
      this.#discoverTrustedSessionInventory = null;
      this.#trustedSessionInventoryCurrent = null;
      this.#observeWorkspaceSession = null;
    }
    this.#stopWorkspaceAddedObserver = options.registry.on("workspace.added", (workspace) => {
      this.invalidate();
      this.#observeWorkspaceSession?.(workspace.name, workspace.sessionName);
    });
    this.#stopWorkspaceRemovedObserver = options.registry.on("workspace.removed", (name) => {
      this.invalidate();
      if (!options.sessionRuntimeRegistry) return;
      const sessionName = sessionsByWorkspace.get(name);
      sessionsByWorkspace.delete(name);
      if (
        sessionName &&
        ![...sessionsByWorkspace.values()].some((candidate) => candidate === sessionName)
      ) {
        void options.sessionRuntimeRegistry.retireSession(sessionName).catch(() => undefined);
      }
    });
  }

  discoverTerminalInventory(signal?: AbortSignal): Promise<NativeTerminalInventorySnapshot> {
    return this.#discoverTerminalInventory(signal);
  }

  lifecycleState(): "initializing" | "ready" | "failed" | "disposed" {
    return this.#disposed ? "disposed" : this.#lifecycle;
  }

  whenReady(): Promise<void> {
    return this.#orphanBarrier;
  }

  recordTerminalRuntimeResourceMark(
    operation: "terminal-resource-handler-admitted" | "terminal-resource-response-projection",
  ): void {
    if (!this.#observability.enabled) return;
    try {
      const atMicros = this.#observability.nowMicros();
      this.#observability.recordSpan("transport", operation, atMicros, atMicros);
    } catch {
      // Diagnostics never own native runtime lifecycle.
    }
  }

  #observeAttempt<Value>(operation: string, run: () => Promise<Value>): Promise<Value> {
    if (!this.#observability.enabled) return run();
    let startedAtMicros: number;
    try {
      startedAtMicros = this.#observability.nowMicros();
    } catch {
      return run();
    }
    const finish = (): void => {
      try {
        this.#observability.recordSpan(
          "transport",
          operation,
          startedAtMicros,
          this.#observability.nowMicros(),
        );
      } catch {
        // Diagnostics never change discovery or enrichment results.
      }
    };
    try {
      return run().finally(finish);
    } catch (error) {
      finish();
      throw error;
    }
  }

  /** Retires the exact read generation; concurrent readers share its replacement. */
  invalidate(): void {
    this.#inventoryEpoch += 1;
    this.#inventoryRead?.abort.abort();
    this.#inventoryRead = null;
    for (const read of this.#applicationReads.values()) read.abort.abort();
    this.#applicationReads.clear();
  }

  #readInventoryAttempt(signal: AbortSignal): Promise<NativeTerminalInventorySnapshot> {
    return this.#observeAttempt("terminal-inventory-discovery", () =>
      discoverWorkspaceRegistryTerminalInventory(this.#registry, this.readRunner, signal),
    );
  }

  #publishInventory(snapshot: NativeTerminalInventorySnapshot): NativeTerminalInventorySnapshot {
    try {
      this.#onInventory?.(snapshot);
    } catch {
      // Cache adoption is an optimization/readiness fence, never inventory authority.
    }
    return snapshot;
  }

  async #readInventory(
    signal?: AbortSignal,
    staleRetry = 0,
  ): Promise<NativeTerminalInventorySnapshot> {
    if (this.#disposed) throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
    const epoch = this.#inventoryEpoch;
    if (signal) {
      if (signal.aborted) throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
      let snapshot: NativeTerminalInventorySnapshot;
      try {
        snapshot = await this.#readInventoryAttempt(signal);
      } catch (error) {
        if (this.#inventoryEpoch !== epoch) {
          if (staleRetry < 1) return this.#readInventory(signal, staleRetry + 1);
          throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
        }
        throw error;
      }
      if (signal.aborted) throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
      if (this.#inventoryEpoch !== epoch) {
        if (staleRetry < 1) return this.#readInventory(signal, staleRetry + 1);
        throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
      }
      return this.#publishInventory(snapshot);
    }
    if (this.#inventoryRead?.epoch === epoch) return this.#inventoryRead.promise;
    const abort = new AbortController();
    const promise = (async () => {
      let value: NativeTerminalInventorySnapshot;
      try {
        value = await this.#readInventoryAttempt(abort.signal);
      } catch (error) {
        if (abort.signal.aborted || this.#inventoryEpoch !== epoch) {
          if (staleRetry < 1) return this.#readInventory(undefined, staleRetry + 1);
          throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
        }
        throw error;
      }
      if (abort.signal.aborted || this.#inventoryEpoch !== epoch) {
        if (staleRetry < 1) return this.#readInventory(undefined, staleRetry + 1);
        throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
      }
      return this.#publishInventory(value);
    })().finally(() => {
      if (this.#inventoryRead?.promise === promise) this.#inventoryRead = null;
    });
    this.#inventoryRead = { epoch, abort, promise };
    return promise;
  }

  discoverApplicationShellSession(
    requestedSessionName: string,
  ): Promise<NativeApplicationShellSessionSnapshot | null> {
    if (this.#disposed)
      return Promise.reject(new NativeTerminalAttachmentRuntimeError("runtime-disposed"));
    const epoch = this.#inventoryEpoch;
    const current = this.#applicationReads.get(requestedSessionName);
    if (current?.epoch === epoch) return current.promise;
    const abort = new AbortController();
    const promise = this.#discoverApplicationShellSession(requestedSessionName, abort.signal)
      .then((value) =>
        abort.signal.aborted || this.#inventoryEpoch !== epoch
          ? this.discoverApplicationShellSession(requestedSessionName)
          : value,
      )
      .catch((error: unknown) => {
        if (abort.signal.aborted || this.#inventoryEpoch !== epoch) {
          return this.discoverApplicationShellSession(requestedSessionName);
        }
        throw error;
      })
      .finally(() => {
        if (this.#applicationReads.get(requestedSessionName)?.promise === promise) {
          this.#applicationReads.delete(requestedSessionName);
        }
      });
    this.#applicationReads.set(requestedSessionName, { epoch, abort, promise });
    return promise;
  }

  /**
   * Fresh agent-free session projection for the terminal runtime authority.
   * This deliberately does not join the application-shell enrichment flight.
   */
  discoverTerminalRuntimeSession(
    requestedSessionName: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<NativeTerminalRuntimeSessionSnapshot | null> {
    if (this.#disposed)
      return Promise.reject(new NativeTerminalAttachmentRuntimeError("runtime-disposed"));
    return this.#discoverTerminalRuntimeSession(requestedSessionName, signal);
  }

  async #discoverTerminalRuntimeSession(
    requestedSessionName: string,
    signal: AbortSignal,
    staleRetry = 0,
  ): Promise<NativeTerminalRuntimeSessionSnapshot | null> {
    const epoch = this.#inventoryEpoch;
    const assertLive = (): void => {
      if (signal.aborted || this.#disposed) {
        throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
      }
    };
    const retryIfReplaced = (): Promise<NativeTerminalRuntimeSessionSnapshot | null> | null => {
      assertLive();
      if (this.#inventoryEpoch === epoch) return null;
      if (staleRetry < 1)
        return this.#discoverTerminalRuntimeSession(requestedSessionName, signal, staleRetry + 1);
      return Promise.reject(new NativeTerminalAttachmentRuntimeError("discovery-failed"));
    };
    assertLive();
    const memberships = this.#registry
      .list()
      .filter((workspace) => workspace.sessionName === requestedSessionName);
    if (memberships.length === 0) return null;
    if (memberships.length !== 1)
      throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
    const workspace = memberships[0]!;
    let inventory: NativeTerminalInventorySnapshot;
    let trustedInventory = false;
    let trustedInventoryToken: object | null = null;
    if (this.#discoverTrustedSessionInventory) {
      const trusted = await awaitInventoryUnlessAborted(
        this.#discoverTrustedSessionInventory(workspace.sessionName, signal),
        signal,
      ).catch(() => null);
      const trustedRetry = retryIfReplaced();
      if (trustedRetry) return trustedRetry;
      if (trusted) {
        try {
          const panes = projectTrustedMirrorInventory(
            trusted.inventory,
            workspace.name,
            workspace.sessionName,
          );
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
                missionStamp: _missionStamp,
                dir: _dir,
                ...row
              }) => row,
            ),
          );
          if (
            catalog.invalidRuntimeProof ||
            catalog.missingSemanticStamp ||
            catalog.duplicateSemanticStamp ||
            catalog.duplicateRuntimePaneBinding
          ) {
            throw new NativeTerminalAttachmentRuntimeError("invalid-tmux-output");
          }
          inventory = Object.freeze({ panes, catalog });
          trustedInventory = true;
          trustedInventoryToken = trusted.token;
        } catch {
          assertLive();
          inventory = await awaitInventoryUnlessAborted(
            this.#discoverTerminalInventory(signal),
            signal,
          );
        }
      } else {
        inventory = await awaitInventoryUnlessAborted(
          this.#discoverTerminalInventory(signal),
          signal,
        );
      }
    } else {
      inventory = await awaitInventoryUnlessAborted(
        this.#discoverTerminalInventory(signal),
        signal,
      );
    }
    const inventoryRetry = retryIfReplaced();
    if (inventoryRetry) return inventoryRetry;
    const panes = inventory.panes.filter(
      (pane) => pane.workspaceName === workspace.name && pane.sessionName === workspace.sessionName,
    );
    if (panes.length === 0) return null;
    const active = panes.find((pane) => pane.active) ?? panes[0]!;
    const sessionCatalog = analyzeTrustedSemanticPaneCatalog(
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
          missionStamp: _missionStamp,
          dir: _dir,
          ...row
        }) => row,
      ),
    );
    const windowStamps = new Map<string, string>();
    let windowIdentityReady = true;
    for (const pane of sessionCatalog.rows) {
      const stamp = pane.windowStamp ?? null;
      const previous = windowStamps.get(pane.windowId);
      if (stamp === null || (previous !== undefined && previous !== stamp)) {
        windowIdentityReady = false;
        break;
      }
      windowStamps.set(pane.windowId, stamp);
    }
    if (new Set(windowStamps.values()).size !== windowStamps.size) windowIdentityReady = false;
    const shouldPrewarm =
      !sessionCatalog.invalidRuntimeProof &&
      !sessionCatalog.missingSemanticStamp &&
      !sessionCatalog.duplicateSemanticStamp &&
      !sessionCatalog.duplicateRuntimePaneBinding &&
      windowIdentityReady;
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
    if (shouldPrewarm && this.#prewarmSessionRuntime) {
      await awaitInventoryUnlessAborted(
        this.#prewarmSessionRuntime(workspace.sessionName, active.sessionId, signal),
        signal,
      ).catch(() => undefined);
      const prewarmRetry = retryIfReplaced();
      if (prewarmRetry) return prewarmRetry;
    }
    const finalRetry = retryIfReplaced();
    if (finalRetry) return finalRetry;
    if (trustedInventory) {
      if (
        trustedInventoryToken === null ||
        this.#trustedSessionInventoryCurrent?.(workspace.sessionName, trustedInventoryToken) !==
          true
      ) {
        if (staleRetry < 1)
          return this.#discoverTerminalRuntimeSession(requestedSessionName, signal, staleRetry + 1);
        throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
      }
      try {
        this.#onSessionInventory?.(workspace.sessionName, shouldPrewarm ? inventory : null);
      } catch {
        // A cache consumer cannot own terminal inventory discovery.
      }
    }
    this.#observeWorkspaceSession?.(workspace.name, workspace.sessionName);
    return Object.freeze({
      workspaceName: workspace.name,
      name: workspace.sessionName,
      runtimeSessionId: active.sessionId,
      dir: workspace.projectDir,
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
          }) => Object.freeze({ ...pane }),
        ),
      ),
    });
  }

  async #discoverApplicationShellSession(
    requestedSessionName: string,
    signal: AbortSignal,
  ): Promise<NativeApplicationShellSessionSnapshot | null> {
    const session = await this.#discoverTerminalRuntimeSession(requestedSessionName, signal);
    if (session === null) return null;
    const assertLive = (): void => {
      if (signal.aborted || this.#disposed) {
        throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
      }
    };
    let agentFacts: ReadonlyMap<string, AgentStatusPaneFacts> = new Map();
    if (this.#agentStatusProbe) {
      try {
        agentFacts = await this.#observeAttempt("terminal-agent-enrichment", () =>
          this.#agentStatusProbe!.probe(
            {
              sessionId: session.runtimeSessionId,
              nowSec: Math.floor(Date.now() / 1000),
              panes: session.panes.map((pane) => ({
                runtimePaneId: pane.runtimePaneId,
                currentCommand: pane.currentCommand,
                title: pane.title,
              })),
            },
            signal,
          ),
        );
      } catch {
        assertLive();
        agentFacts = new Map();
      }
    }
    assertLive();
    return Object.freeze({
      ...session,
      panes: Object.freeze(
        session.panes.map((pane) =>
          Object.freeze({ ...pane, ...(agentFacts.get(pane.runtimePaneId) ?? {}) }),
        ),
      ),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle = "disposed";
    this.invalidate();
    this.#stopWorkspaceAddedObserver?.();
    this.#stopWorkspaceRemovedObserver?.();
  }
}

export interface NativeTerminalAttachmentRuntimeOptions {
  readonly daemonInstanceId: string;
  readonly webSocketUrl: string;
  readonly registry: WorkspaceRegistry;
  /** Neutral catalog authority shared with pane-stream and application-shell. */
  readonly inventoryRuntime?: WorkspaceTerminalInventoryRuntime;
  /** Canonical daemon-generation client/control authority. */
  readonly sessionRuntimeRegistry?: SessionRuntimeRegistry;
  readonly tmuxAuthority: NativeTerminalAttachmentTmuxAuthority;
  readonly ptyAdapter?: PtyAdapter;
  readonly commandExecutor?: NativeTerminalAttachmentCommandExecutor;
  readonly readCommandExecutor?: NativeTerminalInventoryReadCommandExecutor;
  /** Narrow deterministic seam; production omits it and uses registry-backed discovery. */
  readonly semanticPaneCatalog?: SemanticPaneCatalog;
  readonly lease?: LeaseRuntimeOptions;
  readonly launcher?: LauncherRuntimeOptions;
  readonly admission?: AdmissionRuntimeOptions;
  /**
   * Ground-truth agent-status probe for the application-shell inventory. When
   * omitted (e.g. unit tests, catalog-only runtimes) the projection falls back
   * to its legacy shell-vs-active heuristic. A directly-injected probe wins;
   * otherwise {@link agentStatusProbeFactory} is built from the runtime's own
   * pinned runner so option/capture IO shares the attachment socket authority.
   */
  readonly agentStatusProbe?: AgentStatusProbe;
  /**
   * Build the probe from the runtime's pinned tmux runner (production wiring in
   * daemon-embed). Ignored when {@link agentStatusProbe} is provided directly.
   */
  readonly agentStatusProbeFactory?: (deps: {
    readonly run: (argv: readonly string[], signal?: AbortSignal) => Promise<string | null>;
  }) => AgentStatusProbe;
}

/** One daemon-generation owner for catalog, grouped view, PTY, lease and admission state. */
export class NativeTerminalAttachmentRuntime {
  readonly admission: TerminalAttachmentAdmissionCoordinator;
  readonly semanticPaneCatalog: SemanticPaneCatalog;
  readonly #launcher: PtyTmuxAttachmentLauncher;
  readonly #startupBarrier: Promise<void>;
  readonly #serializer: TmuxAttachmentOperationSerializer;
  readonly #registry: WorkspaceRegistry;
  readonly #inventoryRuntime: WorkspaceTerminalInventoryRuntime | null;
  readonly #discoverTerminalInventory: () => Promise<NativeTerminalInventorySnapshot>;
  readonly #readRunner: NativeTerminalInventoryReadRunner;
  readonly #agentStatusProbe: AgentStatusProbe | null;
  readonly #prewarmSessionRuntime: ((sessionName: string) => void) | null;
  readonly #observeWorkspaceSession: ((workspaceName: string, sessionName: string) => void) | null;
  readonly #stopWorkspaceAddedObserver: (() => void) | null;
  readonly #stopWorkspaceRemovedObserver: (() => void) | null;
  #inventoryEpoch = 0;
  #inventoryRead: {
    readonly epoch: number;
    readonly abort: AbortController;
    readonly promise: Promise<NativeTerminalInventorySnapshot>;
  } | null = null;
  readonly #applicationReads = new Map<
    string,
    {
      readonly epoch: number;
      readonly abort: AbortController;
      readonly promise: Promise<NativeApplicationShellSessionSnapshot | null>;
    }
  >();
  #lifecycle: "initializing" | "ready" | "failed" | "disposing" | "disposed" = "initializing";
  #disposePromise: Promise<void> | null = null;

  constructor(options: NativeTerminalAttachmentRuntimeOptions) {
    nativeTerminalAttachmentRuntimeConstructions += 1;
    const authority = canonicalAuthority(options.tmuxAuthority);
    const execute = options.commandExecutor ?? defaultCommandExecutor;
    const executeRead = options.readCommandExecutor ?? defaultReadCommandExecutor;
    const startupPolicy = {
      allowUnavailableDefaultEnumeration:
        authority.socketSelector.kind === "name" && authority.socketSelector.name === "default",
    };
    const runner =
      options.inventoryRuntime?.runner ?? pinnedRunner(authority, execute, startupPolicy);
    const readRunner =
      options.inventoryRuntime?.readRunner ?? pinnedReadRunner(authority, executeRead);
    const discoverTerminalInventory = () =>
      options.inventoryRuntime?.discoverTerminalInventory() ?? this.#readInventory();
    const serializer = new TmuxAttachmentOperationSerializer();
    const catalog =
      options.inventoryRuntime?.semanticPaneCatalog ??
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
              missionStamp: _missionStamp,
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
          timeoutMs: executionOptions.timeoutMs,
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
      ...(options.sessionRuntimeRegistry
        ? {
            bindSessionRuntime: (descriptor: AttachmentLeaseDescriptor) => {
              const workspace = options.registry.get(descriptor.target.workspaceName);
              if (!workspace) throw new Error("Terminal attachment workspace is unavailable");
              if (!descriptor.hostClientId) {
                throw new Error("Interactive terminal attachment lacks trusted host identity");
              }
              return new SessionRuntimeTransportBinder(options.sessionRuntimeRegistry!).bind({
                transport: "terminal-attachment",
                transportLeaseId: descriptor.leaseId,
                session: workspace.sessionName,
                hostClientId: descriptor.hostClientId,
                allowedSourcePaneIds: [descriptor.target.semanticPaneId],
                interactive: descriptor.viewerMode === "interactive",
              });
            },
          }
        : {}),
    });
    this.#launcher = launcher;
    this.semanticPaneCatalog = catalog;
    this.#serializer = serializer;
    this.#registry = options.registry;
    this.#inventoryRuntime = options.inventoryRuntime ?? null;
    this.#readRunner = readRunner;
    this.#discoverTerminalInventory = discoverTerminalInventory;
    this.#agentStatusProbe = options.inventoryRuntime
      ? null
      : (options.agentStatusProbe ??
        (options.agentStatusProbeFactory
          ? options.agentStatusProbeFactory({
              run: async (argv, signal) => {
                const result = await readRunner.run({ executable: "tmux", argv }, signal);
                return result.status === "ok" ? result.stdout : null;
              },
            })
          : null));
    const sessionsByWorkspace = new Map(
      options.registry.list().map((workspace) => [workspace.name, workspace.sessionName]),
    );
    if (options.sessionRuntimeRegistry && !options.inventoryRuntime) {
      const sessionRuntimeRegistry = options.sessionRuntimeRegistry;
      this.#prewarmSessionRuntime = (sessionName) => {
        // Inventory must remain responsive even if tmux control-mode startup
        // fails. Admission will retry through the same runtime on demand.
        void sessionRuntimeRegistry.prewarmSession(sessionName).catch(() => undefined);
      };
      this.#observeWorkspaceSession = (workspaceName, sessionName) => {
        const previousSessionName = sessionsByWorkspace.get(workspaceName);
        sessionsByWorkspace.set(workspaceName, sessionName);
        if (
          previousSessionName &&
          previousSessionName !== sessionName &&
          ![...sessionsByWorkspace.values()].some((candidate) => candidate === previousSessionName)
        ) {
          void sessionRuntimeRegistry.retireSession(previousSessionName).catch(() => undefined);
        }
      };
    } else {
      this.#prewarmSessionRuntime = null;
      this.#observeWorkspaceSession = null;
    }
    if (!options.inventoryRuntime) {
      this.#stopWorkspaceAddedObserver = options.registry.on("workspace.added", (workspace) => {
        this.#invalidateReads();
        this.#observeWorkspaceSession?.(workspace.name, workspace.sessionName);
      });
      this.#stopWorkspaceRemovedObserver = options.registry.on("workspace.removed", (name) => {
        this.#invalidateReads();
        if (!options.sessionRuntimeRegistry) return;
        const sessionName = sessionsByWorkspace.get(name);
        sessionsByWorkspace.delete(name);
        if (
          sessionName &&
          ![...sessionsByWorkspace.values()].some((candidate) => candidate === sessionName)
        ) {
          void options.sessionRuntimeRegistry.retireSession(sessionName).catch(() => undefined);
        }
      });
    } else {
      this.#stopWorkspaceAddedObserver = null;
      this.#stopWorkspaceRemovedObserver = null;
    }
  }

  /**
   * Exact registry-session inventory for ApplicationShell V2. The runtime and
   * attachment catalog intentionally share the same pinned runner, socket and
   * global trust analyzer.
   */
  #readsClosed(): boolean {
    return this.#lifecycle === "disposing" || this.#lifecycle === "disposed";
  }

  #invalidateReads(): void {
    this.#inventoryEpoch += 1;
    this.#inventoryRead?.abort.abort();
    this.#inventoryRead = null;
    for (const read of this.#applicationReads.values()) read.abort.abort();
    this.#applicationReads.clear();
  }

  async #readInventory(): Promise<NativeTerminalInventorySnapshot> {
    if (this.#readsClosed()) throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
    const epoch = this.#inventoryEpoch;
    if (this.#inventoryRead?.epoch === epoch) return this.#inventoryRead.promise;
    const abort = new AbortController();
    const promise = discoverWorkspaceRegistryTerminalInventory(
      this.#registry,
      this.#readRunner,
      abort.signal,
    )
      .then((value) =>
        abort.signal.aborted || this.#inventoryEpoch !== epoch ? this.#readInventory() : value,
      )
      .catch((error: unknown) => {
        if (abort.signal.aborted || this.#inventoryEpoch !== epoch) return this.#readInventory();
        throw error;
      })
      .finally(() => {
        if (this.#inventoryRead?.promise === promise) this.#inventoryRead = null;
      });
    this.#inventoryRead = { epoch, abort, promise };
    return promise;
  }

  discoverApplicationShellSession(
    requestedSessionName: string,
  ): Promise<NativeApplicationShellSessionSnapshot | null> {
    if (this.#inventoryRuntime) {
      return this.#inventoryRuntime.discoverApplicationShellSession(requestedSessionName);
    }
    if (this.#readsClosed())
      return Promise.reject(new NativeTerminalAttachmentRuntimeError("runtime-disposed"));
    const epoch = this.#inventoryEpoch;
    const current = this.#applicationReads.get(requestedSessionName);
    if (current?.epoch === epoch) return current.promise;
    const abort = new AbortController();
    const promise = this.#discoverApplicationShellSession(requestedSessionName, abort.signal)
      .then((value) =>
        abort.signal.aborted || this.#inventoryEpoch !== epoch
          ? this.discoverApplicationShellSession(requestedSessionName)
          : value,
      )
      .catch((error: unknown) => {
        if (abort.signal.aborted || this.#inventoryEpoch !== epoch) {
          return this.discoverApplicationShellSession(requestedSessionName);
        }
        throw error;
      })
      .finally(() => {
        if (this.#applicationReads.get(requestedSessionName)?.promise === promise) {
          this.#applicationReads.delete(requestedSessionName);
        }
      });
    this.#applicationReads.set(requestedSessionName, { epoch, abort, promise });
    return promise;
  }

  async #discoverApplicationShellSession(
    requestedSessionName: string,
    signal: AbortSignal,
  ): Promise<NativeApplicationShellSessionSnapshot | null> {
    const assertLive = (): void => {
      if (signal.aborted || this.#readsClosed()) {
        throw new NativeTerminalAttachmentRuntimeError("runtime-disposed");
      }
    };
    assertLive();
    const memberships = this.#registry
      .list()
      .filter((workspace) => workspace.sessionName === requestedSessionName);
    if (memberships.length === 0) return null;
    if (memberships.length !== 1) {
      throw new NativeTerminalAttachmentRuntimeError("discovery-failed");
    }
    const workspace = memberships[0]!;
    // Reconcile a stable workspace name that now resolves to a replacement
    // tmux session only after authoritative discovery is requested. This keeps
    // an in-flight rename mutation alive through its own completion while
    // ensuring the old prewarm cannot survive the next shell generation.
    this.#observeWorkspaceSession?.(workspace.name, workspace.sessionName);
    const inventory = await this.#discoverTerminalInventory();
    assertLive();
    const panes = inventory.panes.filter(
      (pane) => pane.workspaceName === workspace.name && pane.sessionName === workspace.sessionName,
    );
    if (panes.length === 0) return null;
    const active = panes.find((pane) => pane.active) ?? panes[0]!;
    const sessionCatalog = analyzeTrustedSemanticPaneCatalog(
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
          missionStamp: _missionStamp,
          dir: _dir,
          ...row
        }) => row,
      ),
    );
    const windowStamps = new Map<string, string>();
    let windowIdentityReady = true;
    for (const pane of sessionCatalog.rows) {
      const stamp = pane.windowStamp ?? null;
      const previous = windowStamps.get(pane.windowId);
      if (stamp === null || (previous !== undefined && previous !== stamp)) {
        windowIdentityReady = false;
        break;
      }
      windowStamps.set(pane.windowId, stamp);
    }
    if (new Set(windowStamps.values()).size !== windowStamps.size) windowIdentityReady = false;
    const shouldPrewarm =
      !sessionCatalog.invalidRuntimeProof &&
      !sessionCatalog.missingSemanticStamp &&
      !sessionCatalog.duplicateSemanticStamp &&
      !sessionCatalog.duplicateRuntimePaneBinding &&
      windowIdentityReady;
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
    // Ground-truth agent facts (authority + scrape fallback). All IO stays here;
    // the resource projector composes them purely. Absent probe → no facts →
    // the projector keeps its legacy heuristic. Never fail discovery over this.
    let agentFacts: ReadonlyMap<string, AgentStatusPaneFacts> = new Map();
    if (this.#agentStatusProbe) {
      try {
        agentFacts = await this.#agentStatusProbe.probe(
          {
            sessionId: active.sessionId,
            nowSec: Math.floor(Date.now() / 1000),
            panes: panes.map((pane) => ({
              runtimePaneId: pane.runtimePaneId,
              currentCommand: pane.currentCommand,
              title: pane.title,
            })),
          },
          signal,
        );
      } catch {
        assertLive();
        agentFacts = new Map();
      }
    }
    assertLive();
    // Only a fully stamped daemon-authored inventory may start MirrorService.
    // Promotion owns first identity assignment; warming earlier would let the
    // mirror race it and mint `window.mirror.*` instead of promoted identity.
    // Defer the side effect until enrichment commits the current read epoch.
    if (shouldPrewarm) this.#prewarmSessionRuntime?.(workspace.sessionName);
    return Object.freeze({
      name: workspace.sessionName,
      runtimeSessionId: active.sessionId,
      // Application-owned resources belong to the registered workspace, not
      // whichever cwd happens to be active inside one tmux pane. Pane cwd may
      // be outside the project (or move during a shell session), while the
      // registry projectDir is the durable workspace identity boundary.
      dir: workspace.projectDir,
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
          }) => Object.freeze({ ...pane, ...(agentFacts.get(pane.runtimePaneId) ?? {}) }),
        ),
      ),
    });
  }

  /**
   * The live inventory pass, taken through the same pinned runner and socket
   * the attachment catalog resolves against. Read by the startup readiness
   * ladder so its catalog rung reports what an actual attach would find rather
   * than a second, drifting view of tmux.
   */
  discoverTerminalInventory(): Promise<NativeTerminalInventorySnapshot> {
    return this.#discoverTerminalInventory();
  }

  /**
   * The startup-barrier state, observed WITHOUT awaiting it — a readiness read
   * must never block on the barrier it is reporting on.
   */
  lifecycleState(): "initializing" | "ready" | "failed" | "disposing" | "disposed" {
    return this.#lifecycle;
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
      const readBarriers = [
        ...(this.#inventoryRead ? [this.#inventoryRead.promise] : []),
        ...[...this.#applicationReads.values()].map((read) => read.promise),
      ];
      this.#invalidateReads();
      this.#disposePromise = this.#finishDispose(readBarriers);
    }
    return this.#disposePromise;
  }

  async #finishDispose(readBarriers: readonly Promise<unknown>[]): Promise<void> {
    try {
      this.#stopWorkspaceAddedObserver?.();
      this.#stopWorkspaceRemovedObserver?.();
      const admissionBarrier = this.admission.shutdown();
      // Cancel an attach readiness wait immediately; the coordinator barrier
      // then retires the associated lease/view before this method resolves.
      this.#launcher.disposeAll();
      await Promise.all([
        admissionBarrier,
        this.#startupBarrier.catch(() => undefined),
        ...readBarriers.map((read) => read.catch(() => undefined)),
      ]);
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
