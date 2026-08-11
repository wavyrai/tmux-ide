import { randomBytes } from "node:crypto";

export const PANE_SOURCE_CREDENTIAL_OPTION = "@tmux_ide_source_credential_v1";
export const PANE_SOURCE_CREDENTIAL_HEADER = "X-Tmux-Ide-Pane-Source-Credential";

export interface PaneSourceCredentialTmux {
  run(args: readonly string[]): string;
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
  }
}
