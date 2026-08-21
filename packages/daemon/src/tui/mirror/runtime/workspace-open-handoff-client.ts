import { randomUUID } from "node:crypto";

import type {
  ActionInput,
  ActionName,
  ActionResult,
  CanonicalDaemonInfo,
  WorkspaceOpenPrepareArguments,
  WorkspaceOpenPreparedResult,
} from "@tmux-ide/contracts";
import { dispatchOwnerAction } from "@tmux-ide/daemon-client/owner-action-client";

import { canonicalDaemonUrl, readCanonicalDaemonInfo } from "../../../lib/canonical-daemon.ts";

const OPENTUI_WORKSPACE_HOST = `opentui:${process.pid}`;

export interface OpenTuiWorkspaceHandoffDispatch {
  <Name extends ActionName>(
    daemon: CanonicalDaemonInfo,
    name: Name,
    input: ActionInput<Name>,
    operationId: string,
  ): Promise<ActionResult<Name> | null>;
}

const dispatch: OpenTuiWorkspaceHandoffDispatch = (daemon, name, input, operationId) =>
  dispatchOwnerAction({
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken ?? "",
    hostClientId: OPENTUI_WORKSPACE_HOST,
    name,
    input,
    operationId,
    timeoutMs: 15_000,
  });

interface PendingHandoff {
  readonly revision: number;
  readonly daemon: CanonicalDaemonInfo;
  readonly prepared: WorkspaceOpenPreparedResult;
}

/** Latest-wins renderer owner for the daemon's two-phase workspace handoff. */
export class OpenTuiWorkspaceHandoffClient {
  readonly #readDaemon: () => CanonicalDaemonInfo | null;
  readonly #dispatch: OpenTuiWorkspaceHandoffDispatch;
  #revision = 0;
  #pending: PendingHandoff | null = null;
  #disposed = false;

  constructor(
    options: {
      readonly readDaemon?: () => CanonicalDaemonInfo | null;
      readonly dispatch?: OpenTuiWorkspaceHandoffDispatch;
    } = {},
  ) {
    this.#readDaemon = options.readDaemon ?? readCanonicalDaemonInfo;
    this.#dispatch = options.dispatch ?? dispatch;
  }

  async prepare(input: WorkspaceOpenPrepareArguments): Promise<WorkspaceOpenPreparedResult | null> {
    if (this.#disposed) return null;
    const revision = ++this.#revision;
    await this.#cancelPending();
    const daemon = this.#readDaemon();
    if (!daemon?.authToken || this.#disposed || revision !== this.#revision) return null;
    const prepared = await this.#dispatch(daemon, "workspace.open.prepare", input, randomUUID());
    if (!prepared) return null;
    if (this.#disposed || revision !== this.#revision) {
      await this.#cancel(daemon, prepared);
      return null;
    }
    this.#pending = { revision, daemon, prepared };
    return prepared;
  }

  async commit(prepared: WorkspaceOpenPreparedResult): Promise<boolean> {
    const pending = this.#pending;
    if (
      this.#disposed ||
      !pending ||
      pending.prepared.prepareToken !== prepared.prepareToken ||
      pending.revision !== this.#revision
    )
      return false;
    try {
      const result = await this.#dispatch(
        pending.daemon,
        "workspace.open.commit",
        {
          prepareToken: prepared.prepareToken,
          preparedRevision: prepared.preparedRevision,
        },
        randomUUID(),
      );
      if (result?.phase === "committed") return true;
      await this.#cancel(pending.daemon, pending.prepared);
      return false;
    } catch (error) {
      await this.#cancel(pending.daemon, pending.prepared);
      throw error;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async cancelCurrent(): Promise<void> {
    this.#revision += 1;
    await this.#cancelPending();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#revision += 1;
    void this.#cancelPending();
  }

  async #cancelPending(): Promise<void> {
    const pending = this.#pending;
    this.#pending = null;
    if (pending) await this.#cancel(pending.daemon, pending.prepared);
  }

  async #cancel(daemon: CanonicalDaemonInfo, prepared: WorkspaceOpenPreparedResult): Promise<void> {
    await this.#dispatch(
      daemon,
      "workspace.open.cancel",
      {
        prepareToken: prepared.prepareToken,
        preparedRevision: prepared.preparedRevision,
      },
      randomUUID(),
    ).catch(() => null);
  }
}
