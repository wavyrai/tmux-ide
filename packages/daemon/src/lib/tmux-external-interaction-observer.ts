import { execFile } from "node:child_process";

import { WorkspacePaneCreationReferenceSchemaZ } from "@tmux-ide/contracts";
import { z } from "zod";

import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { createPinnedWorkspaceTmuxAsyncRunner } from "./workspace-pane-creation.ts";
import { getDefaultWorkspaceRegistry, type WorkspaceRegistry } from "./workspace-registry.ts";
import {
  AuthenticatedInternalReadVerifier,
  consumeInternalReadOperation,
  INTERNAL_READ_OPERATION_OPTION,
  INTERNAL_SEND_OPERATION_OPTION,
} from "./tmux-interaction-options.ts";

const HOOK_MARKER = "tmux-ide-interaction-v2";
const OWNED_HOOK_MARKER = "tmux-ide-interaction-v";
const FIELD_SEPARATOR = "|tmux-ide-input-field-v1|";
const EVENT_SEPARATOR = "|tmux-ide-input-event-v1|";
const RUNTIME_PANE = /^%[0-9]+$/u;
const RETRY_MS = 1_000;
/**
 * Hooks are shared tmux state. A config reload, another client, or a debugging
 * command can replace them without killing the daemon, so waiting forever on
 * the old signal channel is not a sufficient health check.
 */
const HOOK_HEALTHCHECK_MS = 1_000;

export { INTERNAL_READ_OPERATION_OPTION, INTERNAL_SEND_OPERATION_OPTION };

export interface ExternalTmuxInteraction {
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
  /** Present only for this daemon generation's product-authored operation. */
  readonly operationId: string | null;
}

export interface ExternalTmuxInteractionObserverIo {
  readonly runTmux: (args: readonly string[], signal?: AbortSignal) => Promise<string>;
  readonly waitForSignal: (channel: string, signal: AbortSignal) => Promise<void>;
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ExternalTmuxObserverDiagnostic {
  readonly operation: "healthcheck" | "drain";
  readonly phase: "begin" | "event-loop-sentinel" | "end";
  readonly traceId: string;
  readonly processId: string;
  readonly clockId: "node-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly activeOperations: number;
  readonly succeeded?: boolean;
}

export interface ExternalTmuxObserverDiagnostics {
  readonly nowMicros: () => number;
  readonly createTraceId: () => string;
  readonly publish: (event: ExternalTmuxObserverDiagnostic) => void;
  readonly queueMicrotask?: (callback: () => void) => void;
}

export interface InternalReadHookEmission {
  readonly bufferName: string;
  readonly signalChannel: string;
  readonly record: string;
}

function socketArguments(authority: WorkspacePaneTmuxAuthority): readonly string[] {
  return authority.socketSelector.kind === "path"
    ? ["-S", authority.socketSelector.path]
    : ["-L", authority.socketSelector.name];
}

function defaultWaiter(
  authority: WorkspacePaneTmuxAuthority,
): ExternalTmuxInteractionObserverIo["waitForSignal"] {
  const prefix = socketArguments(authority);
  return (channel, signal) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        authority.executablePath,
        [...prefix, "wait-for", channel],
        { signal, encoding: "utf8", windowsHide: true },
        (error) => {
          if (!error) resolve();
          else if (signal.aborted) resolve();
          else reject(error);
        },
      );
    });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isTmuxServerUnavailable(error: unknown): boolean {
  const details: string[] = [];
  const codes = new Set<string>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) details.push(cursor.message);
    else details.push(String(cursor));
    if (typeof cursor === "object" && cursor !== null) {
      if ("stderr" in cursor) {
        const stderr = cursor.stderr;
        if (typeof stderr === "string") details.push(stderr);
        else if (Buffer.isBuffer(stderr)) details.push(stderr.toString("utf8"));
      }
      if ("code" in cursor) codes.add(String(cursor.code));
      cursor = "cause" in cursor ? cursor.cause : undefined;
    } else {
      cursor = undefined;
    }
  }
  const detail = details.join("\n").toLowerCase();
  return (
    codes.has("ECONNREFUSED") ||
    detail.includes("failed to connect to server") ||
    detail.includes("no server running") ||
    detail.includes("error connecting to") ||
    detail.includes("connection refused")
  );
}

export function internalInteractionOperationMarker(
  daemonInstanceId: string,
  operationId: string,
): string {
  return `${daemonInstanceId}:${operationId}`;
}

export interface TmuxInputHookRecord {
  readonly runtimePaneId: string;
  readonly operationMarker: string | null;
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
}

/** Parse only the closed metadata written by our tmux hook. */
export function parseTmuxInputHookRecords(raw: string): readonly TmuxInputHookRecord[] {
  const records: TmuxInputHookRecord[] = [];
  for (const encoded of raw.split(EVENT_SEPARATOR)) {
    if (!encoded) continue;
    const fields = encoded.split(FIELD_SEPARATOR);
    if (fields.length !== 3 || !RUNTIME_PANE.test(fields[0]!)) continue;
    const marker = fields[1]!;
    if (marker.length > 160 || /[\r\n]/u.test(marker)) continue;
    const operationKind = fields[2];
    if (operationKind !== "workspace.pane.send" && operationKind !== "workspace.pane.read") {
      continue;
    }
    records.push({
      runtimePaneId: fields[0]!,
      operationMarker: marker || null,
      operationKind,
    });
  }
  return records;
}

function hookIndexes(
  output: string,
  hookName: "after-send-keys" | "after-capture-pane",
): readonly number[] {
  const row = new RegExp(`^${hookName}\\[([0-9]+)\\]\\s+(.+)$`, "u");
  const indexes: number[] = [];
  for (const line of output.split("\n")) {
    const match = row.exec(line);
    if (match && match[2]!.includes(OWNED_HOOK_MARKER)) indexes.push(Number(match[1]!));
  }
  return indexes;
}

/**
 * Event-driven adapter from tmux's native send/capture hooks into the semantic
 * interaction spine. Hooks write only runtime identity, operation kind, and an
 * internal-operation marker to a tmux paste buffer, then signal a blocked
 * `wait-for` client. No terminal input or captured output crosses this boundary.
 */
export class TmuxExternalInteractionObserver {
  readonly #daemonInstanceId: string;
  readonly #registry: WorkspaceRegistry;
  readonly #io: ExternalTmuxInteractionObserverIo;
  readonly #onObserved: (interaction: ExternalTmuxInteraction) => boolean;
  readonly #bufferName: string;
  readonly #signalChannel: string;
  readonly #abort = new AbortController();
  #active = false;
  #installed = false;
  #loop: Promise<void> | null = null;
  #starting: Promise<void> | null = null;
  #hookHealthcheck: ReturnType<typeof setInterval> | null = null;
  #drainSequence = 0;
  #tmuxWork: Promise<unknown> = Promise.resolve();
  #reconcile: Promise<void> | null = null;
  #diagnostics: ExternalTmuxObserverDiagnostics | null;
  #diagnosticActiveOperations = 0;
  readonly #authenticatedInternalReads: AuthenticatedInternalReadVerifier;

  constructor(options: {
    daemonInstanceId: string;
    tmuxAuthority: WorkspacePaneTmuxAuthority;
    internalReadOwnerToken?: string | null;
    registry?: WorkspaceRegistry;
    io?: Partial<ExternalTmuxInteractionObserverIo>;
    /**
     * Returns true only when a live, product-authored operation consumed the
     * observation. Internal-looking metadata is not authority: a false return
     * must fall through to the caller's honest external-observation path.
     */
    onObserved: (interaction: ExternalTmuxInteraction) => boolean;
    diagnostics?: ExternalTmuxObserverDiagnostics;
  }) {
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#registry = options.registry ?? getDefaultWorkspaceRegistry();
    this.#onObserved = options.onObserved;
    this.#authenticatedInternalReads = new AuthenticatedInternalReadVerifier({
      daemonInstanceId: options.daemonInstanceId,
      ownerToken: options.internalReadOwnerToken,
    });
    this.#bufferName = `${HOOK_MARKER}-${options.daemonInstanceId}`;
    this.#signalChannel = `${this.#bufferName}-ready`;
    this.#diagnostics = options.diagnostics ?? null;
    this.#io = {
      runTmux: options.io?.runTmux ?? createPinnedWorkspaceTmuxAsyncRunner(options.tmuxAuthority),
      waitForSignal: options.io?.waitForSignal ?? defaultWaiter(options.tmuxAuthority),
      delay: options.io?.delay ?? abortableDelay,
    };
  }

  /** Private synchronous equivalent of the installed after-capture hook.
   * Recovery hook bodies run with NOHOOKS, so they append this exact bounded
   * record and signal the already-owned observer drain explicitly. */
  internalReadHookEmission(runtimePaneId: string, marker: string): InternalReadHookEmission {
    if (!RUNTIME_PANE.test(runtimePaneId))
      throw new TypeError("internal read hook emission requires a runtime pane id");
    if (!/^[A-Za-z0-9:._-]{16,256}$/u.test(marker))
      throw new TypeError("internal read hook emission requires a bounded marker");
    return Object.freeze({
      bufferName: this.#bufferName,
      signalChannel: this.#signalChannel,
      record:
        `${runtimePaneId}${FIELD_SEPARATOR}${marker}${FIELD_SEPARATOR}` +
        `workspace.pane.read${EVENT_SEPARATOR}`,
    });
  }

  start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#active) return Promise.resolve();
    const work = this.#start();
    const settled = work.finally(() => {
      if (this.#starting === settled) this.#starting = null;
    });
    this.#starting = settled;
    return settled;
  }

  async #start(): Promise<void> {
    this.#active = true;
    try {
      await this.install();
    } catch (error) {
      await this.#serializeTmux(async () => {
        await this.#removeOwnedHooks();
        await this.#deleteBuffer(this.#bufferName);
      });
      if (!isTmuxServerUnavailable(error)) {
        this.#active = false;
        throw error;
      }
      // A configless first run legitimately has no tmux server yet. Keep the
      // observer alive: its retry loop installs the hooks as soon as the first
      // session creates the pinned socket. The HTTP control plane must not be
      // held hostage by optional, currently absent tmux global state.
      this.#installed = false;
    }
    if (!this.#active || this.#abort.signal.aborted) {
      await this.#serializeTmux(async () => {
        await this.#removeOwnedHooks();
        await this.#deleteBuffer(this.#bufferName);
      });
      throw new Error("tmux external interaction observer was disposed during startup");
    }
    this.#loop = this.#run();
    this.#hookHealthcheck = setInterval(() => void this.reconcileHooks(), HOOK_HEALTHCHECK_MS);
    this.#hookHealthcheck.unref?.();
  }

  setDiagnostics(diagnostics: ExternalTmuxObserverDiagnostics | null): void {
    this.#diagnostics = diagnostics;
  }

  async dispose(): Promise<void> {
    if (!this.#active && !this.#loop && !this.#starting) return;
    const starting = this.#starting;
    this.#active = false;
    this.#abort.abort();
    if (this.#hookHealthcheck) clearInterval(this.#hookHealthcheck);
    this.#hookHealthcheck = null;
    await Promise.allSettled([starting, this.#loop]);
    this.#loop = null;
    await this.#serializeTmux(async () => {
      await this.#removeOwnedHooks();
      await this.#deleteBuffer(this.#bufferName);
    });
  }

  /** Install the hook once. Public for hermetic lifecycle tests. */
  install(): Promise<void> {
    return this.#serializeTmux(() => this.#install(this.#abort.signal));
  }

  async #install(signal?: AbortSignal): Promise<void> {
    await this.#removeOwnedHooks(signal);
    await this.#deleteOwnedBuffers(signal);
    signal?.throwIfAborted();
    const hook = (
      operationKind: ExternalTmuxInteraction["operationKind"],
      markerOption: string,
      consumeMarker: boolean,
    ) => {
      const data = `#{pane_id}${FIELD_SEPARATOR}#{q:${markerOption}}${FIELD_SEPARATOR}${operationKind}${EVENT_SEPARATOR}`;
      // Expand pane/marker identity at hook invocation, then schedule the
      // append+signal as a background tmux-native command list. No shell and
      // no second tmux client sit on the invoking command queue. The tiny
      // synchronous native cleanup runs only after the record string has been
      // captured, so a marker is single-use without racing the async drain.
      const publish =
        `run-shell -b -C "set-buffer -a -b '${this.#bufferName}' '${data}'` +
        ` ; wait-for -S '${this.#signalChannel}'"`;
      // Hook commands inherit the triggering pane as their target, so cleanup
      // needs neither format expansion nor a nested command queue.
      const consume = consumeMarker ? ` ; set-option -pu '${markerOption}'` : "";
      return `${publish}${consume}`;
    };
    await this.#io.runTmux(
      [
        "set-hook",
        "-ag",
        "after-send-keys",
        hook("workspace.pane.send", INTERNAL_SEND_OPERATION_OPTION, true),
      ],
      signal,
    );
    signal?.throwIfAborted();
    await this.#io.runTmux(
      [
        "set-hook",
        "-ag",
        "after-capture-pane",
        hook("workspace.pane.read", INTERNAL_READ_OPERATION_OPTION, true),
      ],
      signal,
    );
    signal?.throwIfAborted();
    this.#installed = true;
  }

  /**
   * Restore product hooks when external tmux configuration removed them.
   * Public only so the lifecycle is hermetically testable; the production
   * observer invokes it from a cheap one-second health check.
   */
  reconcileHooks(options: { readonly allowInactive?: boolean } = {}): Promise<void> {
    if (!this.#active && options.allowInactive !== true) return Promise.resolve();
    if (this.#reconcile) return this.#reconcile;
    const work = this.#serializeTmux(async () => {
      const finish = this.#beginDiagnostic("healthcheck");
      try {
        if (await this.#ownedHooksPresent(this.#abort.signal)) {
          finish(true);
          return;
        }
        this.#installed = false;
        try {
          await this.#install(this.#abort.signal);
        } catch {
          this.#installed = false;
        }
        finish(this.#installed);
      } catch (error) {
        finish(false);
        throw error;
      }
    });
    const settled = work.finally(() => {
      if (this.#reconcile === settled) this.#reconcile = null;
    });
    this.#reconcile = settled;
    return settled;
  }

  /** Atomically detach and drain the current event buffer. */
  drain(): Promise<boolean> {
    return this.#serializeTmux(() => this.#drain());
  }

  async #drain(): Promise<boolean> {
    const finish = this.#beginDiagnostic("drain");
    const drainName = `${this.#bufferName}-drain-${++this.#drainSequence}`;
    try {
      await this.#io.runTmux(
        ["set-buffer", "-b", this.#bufferName, "-n", drainName],
        this.#abort.signal,
      );
    } catch {
      finish(false);
      return false;
    }
    let raw: string;
    try {
      raw = await this.#io.runTmux(["show-buffer", "-b", drainName], this.#abort.signal);
    } catch {
      finish(false);
      return false;
    } finally {
      await this.#deleteBuffer(drainName);
    }
    let consumed = false;
    try {
      for (const record of parseTmuxInputHookRecords(raw)) {
        consumed = (await this.#project(record)) || consumed;
      }
    } catch (error) {
      finish(false);
      throw error;
    }
    finish(true);
    return consumed;
  }

  async #run(): Promise<void> {
    while (this.#active && !this.#abort.signal.aborted) {
      try {
        if (!this.#installed) await this.install();
        // A signal sent before this waiter starts is latched by tmux, so hook
        // installation and process scheduling cannot lose the first event.
        await this.#io.waitForSignal(this.#signalChannel, this.#abort.signal);
        if (!this.#active || this.#abort.signal.aborted) break;
        await this.drain();
      } catch {
        this.#installed = false;
        await this.#io.delay(RETRY_MS, this.#abort.signal);
      }
    }
  }

  async #project(record: TmuxInputHookRecord): Promise<boolean> {
    if (
      consumeInternalReadOperation(
        record.operationMarker,
        record.runtimePaneId,
        record.operationKind,
      ) ||
      this.#authenticatedInternalReads.consume(
        record.operationMarker,
        record.runtimePaneId,
        record.operationKind,
      )
    ) {
      return true;
    }
    const ownPrefix = `${this.#daemonInstanceId}:`;
    const authoredOperationId = record.operationMarker?.startsWith(ownPrefix)
      ? record.operationMarker.slice(ownPrefix.length)
      : null;
    const operationId = z.uuid().safeParse(authoredOperationId);
    let identity: string;
    try {
      identity = await this.#io.runTmux(
        [
          "display-message",
          "-p",
          "-t",
          record.runtimePaneId,
          `#{session_name}\t#{${"@tmux_ide_pane_id"}}`,
        ],
        this.#abort.signal,
      );
    } catch {
      return false;
    }
    const separator = identity.indexOf("\t");
    if (separator < 1) return false;
    const sessionName = identity.slice(0, separator);
    const semanticPaneId = identity.slice(separator + 1);
    if (!WorkspacePaneCreationReferenceSchemaZ.safeParse(semanticPaneId).success) return false;
    const workspace = this.#registry.list().find((entry) => entry.sessionName === sessionName);
    if (!workspace) return false;
    return this.#onObserved({
      workspaceName: workspace.name,
      semanticPaneId,
      operationKind: record.operationKind,
      operationId: operationId.success ? operationId.data : null,
    });
  }

  async #removeOwnedHooks(signal?: AbortSignal): Promise<void> {
    for (const hookName of ["after-send-keys", "after-capture-pane"] as const) {
      let output: string;
      try {
        output = await this.#io.runTmux(["show-hooks", "-g", hookName], signal);
      } catch {
        continue;
      }
      for (const index of hookIndexes(output, hookName)) {
        try {
          await this.#io.runTmux(["set-hook", "-gu", `${hookName}[${index}]`], signal);
        } catch {
          // Best-effort retirement. A dead tmux server already retired the hook.
        }
      }
    }
    this.#installed = false;
  }

  async #ownedHooksPresent(signal?: AbortSignal): Promise<boolean> {
    for (const hookName of ["after-send-keys", "after-capture-pane"] as const) {
      let output: string;
      try {
        output = await this.#io.runTmux(["show-hooks", "-g", hookName], signal);
      } catch {
        return false;
      }
      if (!output.includes(this.#bufferName)) return false;
    }
    return true;
  }

  async #deleteOwnedBuffers(signal?: AbortSignal): Promise<void> {
    let output: string;
    try {
      output = await this.#io.runTmux(["list-buffers", "-F", "#{buffer_name}"], signal);
    } catch {
      return;
    }
    for (const name of output.split("\n")) {
      if (name.startsWith(OWNED_HOOK_MARKER)) await this.#deleteBuffer(name, signal);
    }
  }

  async #deleteBuffer(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#io.runTmux(["delete-buffer", "-b", name], signal);
    } catch {
      // Missing buffers are the ordinary idle case.
    }
  }

  #serializeTmux<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tmuxWork.then(operation, operation);
    this.#tmuxWork = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #beginDiagnostic(
    operation: ExternalTmuxObserverDiagnostic["operation"],
  ): (succeeded: boolean) => void {
    const diagnostics = this.#diagnostics;
    if (!diagnostics) return () => undefined;
    let traceId: string;
    let startedAtMicros: number;
    try {
      traceId = diagnostics.createTraceId();
      startedAtMicros = diagnostics.nowMicros();
    } catch {
      return () => undefined;
    }
    this.#diagnosticActiveOperations += 1;
    const publish = (
      phase: ExternalTmuxObserverDiagnostic["phase"],
      atMicros: number,
      succeeded?: boolean,
    ): void => {
      try {
        diagnostics.publish({
          operation,
          phase,
          traceId,
          processId: `daemon:${process.pid}`,
          clockId: "node-performance-now",
          clockKind: "performance-now",
          atMicros,
          activeOperations: this.#diagnosticActiveOperations,
          ...(succeeded === undefined ? {} : { succeeded }),
        });
      } catch {
        // Diagnostics never alter observer authority or lifecycle.
      }
    };
    publish("begin", startedAtMicros);
    try {
      (diagnostics.queueMicrotask ?? queueMicrotask)(() => {
        try {
          publish("event-loop-sentinel", diagnostics.nowMicros());
        } catch {
          // Diagnostics are fail-open.
        }
      });
    } catch {
      // Diagnostics are fail-open.
    }
    let finished = false;
    return (succeeded) => {
      if (finished) return;
      finished = true;
      let atMicros = startedAtMicros;
      try {
        atMicros = diagnostics.nowMicros();
      } catch {
        // Preserve the operation even when the optional clock fails.
      }
      publish("end", atMicros, succeeded);
      this.#diagnosticActiveOperations = Math.max(0, this.#diagnosticActiveOperations - 1);
    };
  }
}
