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
  opentuiPresence: Readonly<{
    clientId: string;
    state: string;
    connectedRevision: number;
    activityRevision: number;
  }> | null;
}>;

/**
 * Renderer-focus adapter for the shared WorkspaceClient authority protocol.
 * It owns no lease state: it only projects host focus to the canonical client.
 */
export class OpenTuiTerminalHostFocus {
  #client: TerminalAuthorityClient | null = null;
  readonly #diagnose: TerminalHostFocusDiagnostic | null;
  #diagnosticEpoch = 0;
  #bindingEpoch = 0;
  #focused: boolean;

  constructor(initiallyFocused = true, diagnose: TerminalHostFocusDiagnostic | null = null) {
    this.#focused = initiallyFocused;
    this.#diagnose = diagnose;
  }

  adopt(client: TerminalAuthorityClient | null): void {
    if (client === this.#client) return;
    const previous = this.#client;
    this.#client = client;
    this.#bindingEpoch += 1;
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

  rendererFocus(): number | null {
    if (this.#focused) return null;
    const diagnosticEpoch = this.#diagnose ? ++this.#diagnosticEpoch : null;
    const identity = diagnosticEpoch === null ? null : this.#captureIdentity(this.#client);
    if (diagnosticEpoch !== null)
      this.#emit("renderer-focus-event", { diagnosticEpoch, state: "foreground" }, identity);
    this.#focus(diagnosticEpoch, identity);
    return diagnosticEpoch;
  }

  blur(): void {
    this.#blur(null);
  }

  #blur(diagnosticEpoch: number | null, identity: TerminalHostFocusIdentity | null = null): void {
    if (!this.#focused) return;
    this.#focused = false;
    if (this.#client) this.#yield(this.#client, diagnosticEpoch, identity);
  }

  rendererBlur(): number | null {
    if (!this.#focused) return null;
    const diagnosticEpoch = this.#diagnose ? ++this.#diagnosticEpoch : null;
    const identity = diagnosticEpoch === null ? null : this.#captureIdentity(this.#client);
    if (diagnosticEpoch !== null)
      this.#emit("renderer-blur-event", { diagnosticEpoch, state: "background" }, identity);
    this.#blur(diagnosticEpoch, identity);
    return diagnosticEpoch;
  }

  dispose(): void {
    const client = this.#client;
    this.#client = null;
    this.#bindingEpoch += 1;
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
    const claims = Promise.allSettled([
      client.requestAuthority("input"),
      client.requestAuthority("focus"),
      client.requestAuthority("geometry"),
    ]);
    if (diagnosticEpoch === null) return;
    const bindingEpoch = this.#bindingEpoch;
    void claims.then((results) =>
      this.#emit(
        "focus-authority-settled",
        {
          diagnosticEpoch,
          receipts: (["input", "focus", "geometry"] as const).map((authority, index) => {
            const result = results[index];
            const lease = result?.status === "fulfilled" ? result.value : null;
            return {
              authority,
              status: result?.status ?? "rejected",
              generation: lease?.generation ?? null,
              granted: lease !== null,
              revision: lease?.revision ?? null,
              session: lease?.session ?? null,
              clientId: lease?.clientId ?? null,
            };
          }),
          settledIdentity: this.#captureIdentity(client),
          bindingCurrent: this.#client === client && this.#bindingEpoch === bindingEpoch,
          status: results.every(({ status }) => status === "fulfilled") ? "fulfilled" : "partial",
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
    const releases = Promise.allSettled([
      client.releaseAuthority("input"),
      client.releaseAuthority("focus"),
      client.releaseAuthority("geometry"),
    ]);
    if (diagnosticEpoch === null) void releases;
    else {
      const bindingEpoch = this.#bindingEpoch;
      void releases.then((results) =>
        this.#emit(
          "blur-authority-settled",
          {
            diagnosticEpoch,
            receipts: (["input", "focus", "geometry"] as const).map((authority, index) => {
              const result = results[index];
              const snapshot = result?.status === "fulfilled" ? result.value : null;
              return {
                authority,
                status: result?.status ?? "rejected",
                generation: snapshot?.generation ?? null,
                owners: snapshot?.owners ?? null,
                revision: snapshot?.revision ?? null,
                session: snapshot?.session ?? null,
              };
            }),
            settledIdentity: this.#captureIdentity(client),
            bindingCurrent: this.#client === client && this.#bindingEpoch === bindingEpoch,
            status: results.every(({ status }) => status === "fulfilled") ? "fulfilled" : "partial",
          },
          identity,
        ),
      );
    }
    client.setPresence("background");
    if (diagnosticEpoch !== null)
      this.#emit("blur-presence", { diagnosticEpoch, state: "background" }, identity);
  }

  #captureIdentity(client: TerminalAuthorityClient | null): TerminalHostFocusIdentity {
    try {
      const snapshot = client?.getSnapshot();
      const opentuiClients = snapshot?.authority?.clients?.filter(
        (entry) => entry.surface === "opentui",
      );
      const opentuiPresence =
        opentuiClients?.length === 1
          ? Object.freeze({
              clientId: opentuiClients[0]!.clientId,
              state: opentuiClients[0]!.state,
              connectedRevision: opentuiClients[0]!.connectedRevision,
              activityRevision: opentuiClients[0]!.activityRevision,
            })
          : null;
      return Object.freeze({
        clientGeneration: snapshot?.generation ?? null,
        clientPhase: snapshot?.phase ?? null,
        authorityGeneration: snapshot?.authority?.generation ?? null,
        authorityOwners: snapshot?.authority?.owners ?? null,
        authorityRevision: snapshot?.authority?.revision ?? null,
        daemonInstanceId: snapshot?.target?.daemon.instanceId ?? null,
        workspaceName: snapshot?.target?.workspaceName ?? null,
        opentuiPresence,
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
        opentuiPresence: null,
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
