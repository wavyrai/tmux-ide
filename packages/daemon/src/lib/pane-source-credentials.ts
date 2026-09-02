import { randomBytes } from "node:crypto";

export const PANE_SOURCE_CREDENTIAL_OPTION = "@tmux_ide_source_credential_v1";
export const PANE_SOURCE_CREDENTIAL_HEADER = "X-Tmux-Ide-Pane-Source-Credential";
export const STARTUP_PANE_CREDENTIAL_TIMEOUT_MS = 2_000;

export interface PaneSourceCredentialTmux {
  run(args: readonly string[]): string;
  runAsync?: (args: readonly string[], signal?: AbortSignal) => Promise<string>;
}

interface CredentialGrant {
  readonly session: string;
  readonly runtimePaneId: string;
  readonly semanticPaneId: string;
}

/**
 * Daemon-generation-only source attribution capabilities for local tmux panes.
 *
 * Threat boundary: tmux is controlled by the local OS user. Another process
 * running as that same user can inspect or replace pane options, so this is not
 * cryptographic isolation from hostile same-user code. The capability proves
 * product transport provenance against untrusted renderer/request-body claims
 * and is continuously reconciled with daemon-owned state.
 */
export class PaneSourceCredentialAuthority {
  readonly #tmux: PaneSourceCredentialTmux;
  readonly #grants = new Map<string, CredentialGrant>();
  readonly #tokensByPane = new Map<string, string>();
  readonly #sessionRevisions = new Map<string, number>();

  constructor(tmux: PaneSourceCredentialTmux) {
    this.#tmux = tmux;
  }

  rotateSession(session: string): void {
    for (const [token, grant] of this.#grants) {
      if (grant.session === session) this.#grants.delete(token);
    }
    for (const key of this.#tokensByPane.keys()) {
      if (key.startsWith(`${session}\0`)) this.#tokensByPane.delete(key);
    }
    this.reconcileSession(session);
  }

  reconcileSession(session: string): void {
    this.#sessionRevisions.set(session, (this.#sessionRevisions.get(session) ?? 0) + 1);
    const rows = this.#tmux.run([
      "list-panes",
      "-s",
      "-t",
      `=${session}`,
      "-F",
      `#{pane_id}\t#{@tmux_ide_pane_id}\t#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]);
    const live = new Set<string>();
    for (const row of rows.split("\n")) {
      const [runtimePaneId, semanticPaneId, installedToken = ""] = row.split("\t");
      if (!runtimePaneId || !semanticPaneId) continue;
      const paneKey = `${session}\0${runtimePaneId}`;
      live.add(paneKey);
      const existingToken = this.#tokensByPane.get(paneKey);
      const existing = existingToken ? this.#grants.get(existingToken) : undefined;
      if (existing?.semanticPaneId === semanticPaneId && installedToken === existingToken) continue;
      if (existingToken) this.#grants.delete(existingToken);
      const token = randomBytes(32).toString("base64url");
      this.#tmux.run([
        "set-option",
        "-p",
        "-t",
        runtimePaneId,
        PANE_SOURCE_CREDENTIAL_OPTION,
        token,
      ]);
      this.#tokensByPane.set(paneKey, token);
      this.#grants.set(token, { session, runtimePaneId, semanticPaneId });
    }
    for (const [paneKey, token] of this.#tokensByPane) {
      if (!paneKey.startsWith(`${session}\0`) || live.has(paneKey)) continue;
      this.#tokensByPane.delete(paneKey);
      this.#grants.delete(token);
    }
  }

  /**
   * Reconcile credentials without blocking the daemon event loop. A synchronous
   * request-time reconciliation may race an awaited tmux child; the revision
   * check retries from live tmux state so the installed option and grant table
   * cannot settle on different tokens.
   */
  async reconcileSessionAsync(session: string, signal?: AbortSignal): Promise<void> {
    const runAsync = this.#tmux.runAsync;
    if (!runAsync) {
      this.reconcileSession(session);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted();
      const revision = this.#sessionRevisions.get(session) ?? 0;
      const rows = await runAsync(
        [
          "list-panes",
          "-s",
          "-t",
          `=${session}`,
          "-F",
          `#{pane_id}\t#{@tmux_ide_pane_id}\t#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
        ],
        signal,
      );
      signal?.throwIfAborted();
      if ((this.#sessionRevisions.get(session) ?? 0) !== revision) continue;

      const live = new Set<string>();
      let raced = false;
      for (const row of rows.split("\n")) {
        const [runtimePaneId, semanticPaneId, installedToken = ""] = row.split("\t");
        if (!runtimePaneId || !semanticPaneId) continue;
        const paneKey = `${session}\0${runtimePaneId}`;
        live.add(paneKey);
        const existingToken = this.#tokensByPane.get(paneKey);
        const existing = existingToken ? this.#grants.get(existingToken) : undefined;
        if (existing?.semanticPaneId === semanticPaneId && installedToken === existingToken)
          continue;

        const token = randomBytes(32).toString("base64url");
        await runAsync(
          ["set-option", "-p", "-t", runtimePaneId, PANE_SOURCE_CREDENTIAL_OPTION, token],
          signal,
        );
        signal?.throwIfAborted();
        if ((this.#sessionRevisions.get(session) ?? 0) !== revision) {
          raced = true;
          break;
        }
        if (existingToken) this.#grants.delete(existingToken);
        this.#tokensByPane.set(paneKey, token);
        this.#grants.set(token, { session, runtimePaneId, semanticPaneId });
      }
      if (raced) continue;
      for (const [paneKey, token] of this.#tokensByPane) {
        if (!paneKey.startsWith(`${session}\0`) || live.has(paneKey)) continue;
        this.#tokensByPane.delete(paneKey);
        this.#grants.delete(token);
      }
      return;
    }
  }

  resolve(
    credential: string | undefined,
    session: string,
    claimedSemanticPaneId: string | undefined,
  ): string | null {
    try {
      this.reconcileSession(session);
    } catch {
      // A missing/churning session is absence of authority, never a reason to
      // retain or fall back from a previously minted credential.
      return null;
    }
    if (!credential || credential.length > 128 || /[\0\r\n]/u.test(credential)) return null;
    const grant = this.#grants.get(credential);
    if (!grant || grant.session !== session) return null;
    if (claimedSemanticPaneId !== undefined && claimedSemanticPaneId !== grant.semanticPaneId) {
      return null;
    }
    return grant.semanticPaneId;
  }

  dispose(): void {
    this.#grants.clear();
    this.#tokensByPane.clear();
    this.#sessionRevisions.clear();
  }
}

export async function reconcilePaneSourceCredentialsAtStartup(
  authority: PaneSourceCredentialAuthority,
  sessions: readonly string[],
  timeoutMs = STARTUP_PANE_CREDENTIAL_TIMEOUT_MS,
): Promise<"complete" | "timed-out"> {
  const uniqueSessions = [...new Set(sessions)];
  if (uniqueSessions.length === 0) return "complete";
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const reconciliation = Promise.allSettled(
    uniqueSessions.map((session) => authority.reconcileSessionAsync(session, controller.signal)),
  );
  const deadline = new Promise<"timed-out">((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve("timed-out");
    }, timeoutMs);
  });
  const result = await Promise.race([reconciliation.then(() => "complete" as const), deadline]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}
