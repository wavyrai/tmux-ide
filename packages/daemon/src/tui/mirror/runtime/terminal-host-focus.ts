import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";

type TerminalAuthorityClient = Pick<
  OpenTuiProductionWorkspaceClient,
  "getSnapshot" | "noteActivity" | "releaseAuthority" | "requestAuthority" | "setPresence"
>;

export type TerminalHostFocusDiagnostic = (
  phase:
    | "renderer-focus-event"
    | "renderer-blur-event"
    | "focus-presence"
    | "focus-activity"
    | "focus-authority-settled"
    | "blur-presence"
    | "blur-authority-settled",
  details: Readonly<Record<string, unknown>>,
) => void;

type TerminalHostFocusIdentity = Readonly<{
  clientGeneration: number | null;
  clientPhase: string | null;
  authorityGeneration: string | null;
  authorityOwners: Readonly<Record<string, string | null>> | null;
  authorityRevision: number | null;
  daemonInstanceId: string | null;
  workspaceName: string | null;
}>;

/**
 * Renderer-focus adapter for the shared WorkspaceClient authority protocol.
 * It owns no lease state: it only projects host focus to the canonical client.
 */
export class OpenTuiTerminalHostFocus {
  #client: TerminalAuthorityClient | null = null;
  readonly #diagnose: TerminalHostFocusDiagnostic | null;
  #diagnosticEpoch = 0;
  #focused: boolean;

  constructor(initiallyFocused = true, diagnose: TerminalHostFocusDiagnostic | null = null) {
    this.#focused = initiallyFocused;
    this.#diagnose = diagnose;
  }

  adopt(client: TerminalAuthorityClient | null): void {
    if (client === this.#client) return;
    const previous = this.#client;
    this.#client = client;
    if (previous) this.#yield(previous);
    if (client) this.#apply(client);
  }

  focus(): void {
    this.#focus(null);
  }

  #focus(diagnosticEpoch: number | null, identity: TerminalHostFocusIdentity | null = null): void {
    if (this.#focused) return;
    this.#focused = true;
    if (this.#client) this.#claim(this.#client, diagnosticEpoch, identity);
  }

  rendererFocus(): void {
    const diagnosticEpoch = this.#diagnose ? ++this.#diagnosticEpoch : null;
    const identity = diagnosticEpoch === null ? null : this.#captureIdentity(this.#client);
    if (diagnosticEpoch !== null)
      this.#emit("renderer-focus-event", { diagnosticEpoch, state: "foreground" }, identity);
    this.#focus(diagnosticEpoch, identity);
  }

  blur(): void {
    this.#blur(null);
  }

  #blur(diagnosticEpoch: number | null, identity: TerminalHostFocusIdentity | null = null): void {
    if (!this.#focused) return;
    this.#focused = false;
    if (this.#client) this.#yield(this.#client, diagnosticEpoch, identity);
  }

  rendererBlur(): void {
    const diagnosticEpoch = this.#diagnose ? ++this.#diagnosticEpoch : null;
    const identity = diagnosticEpoch === null ? null : this.#captureIdentity(this.#client);
    if (diagnosticEpoch !== null)
      this.#emit("renderer-blur-event", { diagnosticEpoch, state: "background" }, identity);
    this.#blur(diagnosticEpoch, identity);
  }

  dispose(): void {
    const client = this.#client;
    this.#client = null;
    if (client) this.#yield(client);
  }

  #apply(client: TerminalAuthorityClient): void {
    if (this.#focused) this.#claim(client);
    else client.setPresence("background");
  }

  #claim(
    client: TerminalAuthorityClient,
    diagnosticEpoch: number | null = null,
    identity: TerminalHostFocusIdentity | null = null,
  ): void {
    client.setPresence("foreground");
    if (diagnosticEpoch !== null)
      this.#emit("focus-presence", { diagnosticEpoch, state: "foreground" }, identity);
    client.noteActivity("focus");
    if (diagnosticEpoch !== null)
      this.#emit("focus-activity", { activity: "focus", diagnosticEpoch }, identity);
    const claims = Promise.all([
      client.requestAuthority("input"),
      client.requestAuthority("focus"),
      client.requestAuthority("geometry"),
    ]);
    if (diagnosticEpoch === null) {
      void claims.catch(() => undefined);
      return;
    }
    void claims.then(
      (leases) =>
        this.#emit(
          "focus-authority-settled",
          {
            diagnosticEpoch,
            receipts: (["input", "focus", "geometry"] as const).map((authority, index) => ({
              authority,
              generation: leases[index]?.generation ?? null,
              granted: leases[index] !== null,
              revision: leases[index]?.revision ?? null,
            })),
            status: "fulfilled",
          },
          identity,
        ),
      () =>
        this.#emit(
          "focus-authority-settled",
          {
            diagnosticEpoch,
            status: "rejected",
          },
          identity,
        ),
    );
  }

  #yield(
    client: TerminalAuthorityClient,
    diagnosticEpoch: number | null = null,
    identity: TerminalHostFocusIdentity | null = null,
  ): void {
    const releases = Promise.all([
      client.releaseAuthority("input"),
      client.releaseAuthority("focus"),
      client.releaseAuthority("geometry"),
    ]);
    if (diagnosticEpoch === null) void releases.catch(() => undefined);
    else
      void releases.then(
        (snapshots) =>
          this.#emit(
            "blur-authority-settled",
            {
              diagnosticEpoch,
              receipts: (["input", "focus", "geometry"] as const).map((authority, index) => ({
                authority,
                generation: snapshots[index]?.generation ?? null,
                owners: snapshots[index]?.owners ?? null,
                revision: snapshots[index]?.revision ?? null,
              })),
              status: "fulfilled",
            },
            identity,
          ),
        () =>
          this.#emit(
            "blur-authority-settled",
            {
              diagnosticEpoch,
              status: "rejected",
            },
            identity,
          ),
      );
    client.setPresence("background");
    if (diagnosticEpoch !== null)
      this.#emit("blur-presence", { diagnosticEpoch, state: "background" }, identity);
  }

  #captureIdentity(client: TerminalAuthorityClient | null): TerminalHostFocusIdentity {
    try {
      const snapshot = client?.getSnapshot();
      return Object.freeze({
        clientGeneration: snapshot?.generation ?? null,
        clientPhase: snapshot?.phase ?? null,
        authorityGeneration: snapshot?.authority?.generation ?? null,
        authorityOwners: snapshot?.authority?.owners ?? null,
        authorityRevision: snapshot?.authority?.revision ?? null,
        daemonInstanceId: snapshot?.target?.daemon.instanceId ?? null,
        workspaceName: snapshot?.target?.workspaceName ?? null,
      });
    } catch {
      return Object.freeze({
        clientGeneration: null,
        clientPhase: null,
        authorityGeneration: null,
        authorityOwners: null,
        authorityRevision: null,
        daemonInstanceId: null,
        workspaceName: null,
      });
    }
  }

  #emit(
    phase: Parameters<TerminalHostFocusDiagnostic>[0],
    details: Readonly<Record<string, unknown>>,
    identity: TerminalHostFocusIdentity | null,
  ): void {
    const diagnose = this.#diagnose;
    if (!diagnose) return;
    try {
      diagnose(phase, {
        ...details,
        ...identity,
      });
    } catch {
      // Opt-in diagnostics never own renderer focus or authority semantics.
    }
  }
}
