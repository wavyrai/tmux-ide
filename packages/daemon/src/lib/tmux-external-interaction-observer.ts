import { execFile } from "node:child_process";

import { WorkspacePaneCreationReferenceSchemaZ } from "@tmux-ide/contracts";
import { z } from "zod";

import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { createPinnedWorkspaceTmuxRunner } from "./workspace-pane-creation.ts";
import { getDefaultWorkspaceRegistry, type WorkspaceRegistry } from "./workspace-registry.ts";
import {
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
  readonly runTmux: (args: readonly string[]) => string;
  readonly waitForSignal: (channel: string, signal: AbortSignal) => Promise<void>;
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
  #hookHealthcheck: ReturnType<typeof setInterval> | null = null;
  #drainSequence = 0;

  constructor(options: {
    daemonInstanceId: string;
    tmuxAuthority: WorkspacePaneTmuxAuthority;
    registry?: WorkspaceRegistry;
    io?: Partial<ExternalTmuxInteractionObserverIo>;
    /**
     * Returns true only when a live, product-authored operation consumed the
     * observation. Internal-looking metadata is not authority: a false return
     * must fall through to the caller's honest external-observation path.
     */
    onObserved: (interaction: ExternalTmuxInteraction) => boolean;
  }) {
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#registry = options.registry ?? getDefaultWorkspaceRegistry();
    this.#onObserved = options.onObserved;
    this.#bufferName = `${HOOK_MARKER}-${options.daemonInstanceId}`;
    this.#signalChannel = `${this.#bufferName}-ready`;
    this.#io = {
      runTmux: options.io?.runTmux ?? createPinnedWorkspaceTmuxRunner(options.tmuxAuthority),
      waitForSignal: options.io?.waitForSignal ?? defaultWaiter(options.tmuxAuthority),
      delay: options.io?.delay ?? abortableDelay,
    };
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#loop = this.#run();
    this.#hookHealthcheck = setInterval(() => this.reconcileHooks(), HOOK_HEALTHCHECK_MS);
    this.#hookHealthcheck.unref?.();
  }

  async dispose(): Promise<void> {
    if (!this.#active && !this.#loop) return;
    this.#active = false;
    this.#abort.abort();
    if (this.#hookHealthcheck) clearInterval(this.#hookHealthcheck);
    this.#hookHealthcheck = null;
    await this.#loop;
    this.#loop = null;
    this.#removeOwnedHooks();
    this.#deleteBuffer(this.#bufferName);
  }

  /** Install the hook once. Public for hermetic lifecycle tests. */
  install(): void {
    this.#removeOwnedHooks();
    this.#deleteOwnedBuffers();
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
      const consume = consumeMarker
        ? ` ; run-shell -C "set-option -pu -t '#{pane_id}' '${markerOption}'"`
        : "";
      return `${publish}${consume}`;
    };
    this.#io.runTmux([
      "set-hook",
      "-ag",
      "after-send-keys",
      hook("workspace.pane.send", INTERNAL_SEND_OPERATION_OPTION, true),
    ]);
    this.#io.runTmux([
      "set-hook",
      "-ag",
      "after-capture-pane",
      hook("workspace.pane.read", INTERNAL_READ_OPERATION_OPTION, true),
    ]);
    this.#installed = true;
  }

  /**
   * Restore product hooks when external tmux configuration removed them.
   * Public only so the lifecycle is hermetically testable; the production
   * observer invokes it from a cheap one-second health check.
   */
  reconcileHooks(): void {
    if (this.#ownedHooksPresent()) return;
    this.#installed = false;
    try {
      this.install();
    } catch {
      this.#installed = false;
    }
  }

  /** Atomically detach and drain the current event buffer. */
  drain(): boolean {
    const drainName = `${this.#bufferName}-drain-${++this.#drainSequence}`;
    try {
      this.#io.runTmux(["set-buffer", "-b", this.#bufferName, "-n", drainName]);
    } catch {
      return false;
    }
    let raw: string;
    try {
      raw = this.#io.runTmux(["show-buffer", "-b", drainName]);
    } finally {
      this.#deleteBuffer(drainName);
    }
    let consumed = false;
    for (const record of parseTmuxInputHookRecords(raw)) {
      consumed = this.#project(record) || consumed;
    }
    return consumed;
  }

  async #run(): Promise<void> {
    while (this.#active && !this.#abort.signal.aborted) {
      try {
        if (!this.#installed) this.install();
        // A signal sent before this waiter starts is latched by tmux, so hook
        // installation and process scheduling cannot lose the first event.
        await this.#io.waitForSignal(this.#signalChannel, this.#abort.signal);
        if (!this.#active || this.#abort.signal.aborted) break;
        this.drain();
      } catch {
        this.#installed = false;
        await this.#io.delay(RETRY_MS, this.#abort.signal);
      }
    }
  }

  #project(record: TmuxInputHookRecord): boolean {
    if (
      consumeInternalReadOperation(
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
      identity = this.#io.runTmux([
        "display-message",
        "-p",
        "-t",
        record.runtimePaneId,
        `#{session_name}\t#{${"@tmux_ide_pane_id"}}`,
      ]);
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

  #removeOwnedHooks(): void {
    for (const hookName of ["after-send-keys", "after-capture-pane"] as const) {
      let output: string;
      try {
        output = this.#io.runTmux(["show-hooks", "-g", hookName]);
      } catch {
        continue;
      }
      for (const index of hookIndexes(output, hookName)) {
        try {
          this.#io.runTmux(["set-hook", "-gu", `${hookName}[${index}]`]);
        } catch {
          // Best-effort retirement. A dead tmux server already retired the hook.
        }
      }
    }
    this.#installed = false;
  }

  #ownedHooksPresent(): boolean {
    for (const hookName of ["after-send-keys", "after-capture-pane"] as const) {
      let output: string;
      try {
        output = this.#io.runTmux(["show-hooks", "-g", hookName]);
      } catch {
        return false;
      }
      if (!output.includes(this.#bufferName)) return false;
    }
    return true;
  }

  #deleteOwnedBuffers(): void {
    let output: string;
    try {
      output = this.#io.runTmux(["list-buffers", "-F", "#{buffer_name}"]);
    } catch {
      return;
    }
    for (const name of output.split("\n")) {
      if (name.startsWith(OWNED_HOOK_MARKER)) this.#deleteBuffer(name);
    }
  }

  #deleteBuffer(name: string): void {
    try {
      this.#io.runTmux(["delete-buffer", "-b", name]);
    } catch {
      // Missing buffers are the ordinary idle case.
    }
  }
}
