import type { HostCapabilities, WorkspaceOpenPreparedResult } from "@tmux-ide/contracts";

export type AtomicWorkspaceOpenOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "committed"; readonly prepared: WorkspaceOpenPreparedResult }
  | { readonly status: "error"; readonly reason: string };

/** Renderer owner for client-local prepare -> commit selection handoff. */
export class AtomicWorkspaceOpenController {
  readonly #workspace: HostCapabilities["workspace"];
  readonly #daemonInstanceId: string;
  #request = 0;
  #prepared: WorkspaceOpenPreparedResult | null = null;
  #disposed = false;

  constructor(workspace: HostCapabilities["workspace"], daemonInstanceId: string) {
    this.#workspace = workspace;
    this.#daemonInstanceId = daemonInstanceId;
  }

  async open(previousWorkspaceName: string | null): Promise<AtomicWorkspaceOpenOutcome> {
    const request = ++this.#request;
    await this.#cancelPrepared();
    if (
      this.#disposed ||
      !this.#workspace.prepareProjectDirectory ||
      !this.#workspace.commitPreparedOpen ||
      !this.#workspace.cancelPreparedOpen
    ) {
      return { status: "error", reason: "The host does not support atomic workspace handoff." };
    }
    let preparedHost;
    try {
      preparedHost = await this.#workspace.prepareProjectDirectory(previousWorkspaceName);
    } catch {
      return { status: "error", reason: "The workspace could not be prepared." };
    }
    if (this.#disposed || request !== this.#request) {
      if (preparedHost?.status === "ok") await this.#cancel(preparedHost.result);
      return { status: "cancelled" };
    }
    if (!preparedHost) return { status: "cancelled" };
    if (preparedHost.status === "error")
      return { status: "error", reason: preparedHost.error.reason };
    const prepared = preparedHost.result;
    if (prepared.daemonInstanceId !== this.#daemonInstanceId) {
      await this.#cancel(prepared);
      return {
        status: "error",
        reason: "The daemon generation changed while preparing the workspace.",
      };
    }
    this.#prepared = prepared;
    const decision = {
      prepareToken: prepared.prepareToken,
      preparedRevision: prepared.preparedRevision,
    };
    let committed;
    try {
      committed = await this.#workspace.commitPreparedOpen(decision);
    } catch {
      await this.#cancel(prepared);
      return { status: "error", reason: "The prepared workspace could not be committed." };
    }
    if (this.#disposed || request !== this.#request) {
      await this.#cancel(prepared);
      return { status: "cancelled" };
    }
    if (committed.status === "error") {
      await this.#cancel(prepared);
      return { status: "error", reason: committed.error.reason };
    }
    if (
      committed.result.daemonInstanceId !== this.#daemonInstanceId ||
      committed.result.workspaceName !== prepared.workspaceName ||
      committed.result.prepareToken !== prepared.prepareToken
    ) {
      await this.#cancel(prepared);
      return {
        status: "error",
        reason: "The committed workspace handoff did not match its proof.",
      };
    }
    this.#prepared = null;
    return { status: "committed", prepared };
  }

  supersede(): void {
    this.#request += 1;
    void this.#cancelPrepared();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.supersede();
  }

  async #cancelPrepared(): Promise<void> {
    const prepared = this.#prepared;
    this.#prepared = null;
    if (prepared) await this.#cancel(prepared);
  }

  async #cancel(prepared: WorkspaceOpenPreparedResult): Promise<void> {
    await this.#workspace.cancelPreparedOpen?.({
      prepareToken: prepared.prepareToken,
      preparedRevision: prepared.preparedRevision,
    });
  }
}
