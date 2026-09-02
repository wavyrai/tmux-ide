import type {
  SessionRuntimeActivityKind,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthorityLease,
  SessionRuntimeAuthoritySnapshot,
  SessionRuntimePresenceState,
} from "@tmux-ide/contracts";

export interface TerminalAuthorityClient {
  readonly authorityIdentity: Readonly<{
    generation: string;
    session: string;
    clientId: string;
  }>;
  getAuthoritySnapshot(): SessionRuntimeAuthoritySnapshot | null;
  getSnapshot():
    | Readonly<{
        generation?: number;
        phase?: string;
        target?: Readonly<{
          daemon: Readonly<{ instanceId: string }>;
          workspaceName: string;
        }> | null;
        authority?: SessionRuntimeAuthoritySnapshot | null;
      }>
    | null
    | undefined;
  setPresence(state: SessionRuntimePresenceState): void;
  noteActivity(activity: SessionRuntimeActivityKind): void;
  requestAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthoritySnapshot | null>;
  onAuthority(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void;
  onBinding?(listener: () => void): () => void;
}

export type TerminalHostFocusDiagnostic = (
  phase:
    | "renderer-focus-event"
    | "renderer-blur-event"
    | "focus-presence"
    | "focus-claim-attempt"
    | "focus-activity"
    | "focus-authority-settled"
    | "focus-authority-reconcile"
    | "blur-presence"
    | "blur-authority-settled",
  details: Readonly<Record<string, unknown>>,
) => void;

type TerminalHostFocusIdentity = Readonly<{
  clientGeneration: number | null;
  clientPhase: string | null;
  authorityGeneration: string | null;
  runtimeSession: string | null;
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
  #appliedClient: TerminalAuthorityClient | null = null;
  #handoff: Promise<void> = Promise.resolve();
  #handoffPending = false;
  #stopAuthority: (() => void) | null = null;
  readonly #diagnose: TerminalHostFocusDiagnostic | null;
  #diagnosticEpoch = 0;
  #bindingEpoch = 0;
  #stateEpoch = 0;
  #appliedFocused = false;
  #appliedMayHoldAuthority = false;
  #claimInFlight = false;
  readonly #heldAuthorities = new Set<SessionRuntimeAuthorityKind>();
  #latestAuthority: SessionRuntimeAuthoritySnapshot | null = null;
  #outcomeId = 0;
  #claimOrdinal = 0;
  #focused: boolean;

  constructor(initiallyFocused = true, diagnose: TerminalHostFocusDiagnostic | null = null) {
    this.#focused = initiallyFocused;
    this.#diagnose = diagnose;
  }

  adopt(client: TerminalAuthorityClient | null): void {
    if (client === this.#client) return;
    this.#stopAuthority?.();
    this.#stopAuthority = null;
    this.#latestAuthority = null;
    this.#client = client;
    this.#bindingEpoch += 1;
    this.#queueTransition(null, null);
    if (client)
      try {
        this.#stopAuthority = client.onAuthority((snapshot) => {
          this.#latestAuthority = snapshot;
          if (
            this.#client !== client ||
            !this.#focused ||
            this.#claimInFlight ||
            this.#appliedClient !== client ||
            !this.#heldAuthorityLost(client, snapshot)
          )
            return;
          // An authority loss settles this foreground/binding epoch. Competing
          // foreground hosts must not be able to make each other reclaim in a
          // loop; only a trusted blur->focus transition or a new binding epoch
          // may arm another claim triplet.
          this.#heldAuthorities.clear();
        });
      } catch {
        this.#stopAuthority = null;
      }
  }

  focus(): void {
    this.#focus(null);
  }

  #focus(diagnosticEpoch: number | null, identity: TerminalHostFocusIdentity | null = null): void {
    if (this.#focused) return;
    this.#focused = true;
    this.#queueTransition(diagnosticEpoch, identity);
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
    this.#queueTransition(diagnosticEpoch, identity);
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
    this.adopt(null);
  }

  #queueTransition(
    diagnosticEpoch: number | null,
    identity: TerminalHostFocusIdentity | null,
  ): void {
    const client = this.#client;
    const focused = this.#focused;
    const stateEpoch = ++this.#stateEpoch;
    const bindingEpoch = this.#bindingEpoch;
    const transition = async (): Promise<void> => {
      const applied = this.#appliedClient;
      const mustYield =
        applied !== null && this.#appliedMayHoldAuthority && (applied !== client || !focused);
      const yieldedForBlur = mustYield && applied === client && !focused;
      if (mustYield) {
        this.#appliedFocused = false;
        this.#appliedMayHoldAuthority = false;
        this.#heldAuthorities.clear();
        if (applied !== client) this.#appliedClient = null;
        await this.#yield(
          applied,
          focused || applied !== client ? null : diagnosticEpoch,
          identity,
          stateEpoch,
          bindingEpoch,
        );
      }
      if (
        this.#stateEpoch !== stateEpoch ||
        this.#bindingEpoch !== bindingEpoch ||
        this.#client !== client ||
        this.#focused !== focused
      )
        return;
      if (client === null) {
        this.#appliedClient = null;
        this.#appliedFocused = false;
        this.#appliedMayHoldAuthority = false;
        return;
      }
      if (this.#appliedClient !== client) {
        this.#appliedClient = client;
        this.#appliedFocused = false;
        this.#appliedMayHoldAuthority = false;
        this.#heldAuthorities.clear();
      }
      if (focused && !this.#appliedFocused) {
        this.#appliedFocused = await this.#claim(
          client,
          diagnosticEpoch,
          identity,
          stateEpoch,
          bindingEpoch,
        );
      } else if (!focused && !yieldedForBlur) {
        client.setPresence("background");
        if (diagnosticEpoch !== null)
          this.#emit("blur-presence", { diagnosticEpoch, state: "background" }, identity);
      }
    };
    const queued = this.#handoffPending ? this.#handoff.then(transition) : transition();
    this.#handoffPending = true;
    const settled = queued.catch(() => undefined);
    this.#handoff = settled;
    void settled.then(() => {
      if (this.#handoff === settled) this.#handoffPending = false;
    });
  }

  async #claim(
    client: TerminalAuthorityClient,
    diagnosticEpoch: number | null = null,
    identity: TerminalHostFocusIdentity | null = null,
    stateEpoch = this.#stateEpoch,
    bindingEpoch = this.#bindingEpoch,
  ): Promise<boolean> {
    const claimOrdinal = ++this.#claimOrdinal;
    if (this.#diagnose)
      this.#emit(
        "focus-claim-attempt",
        { claimOrdinal, diagnosticEpoch, bindingEpoch, stateEpoch },
        identity ?? this.#captureIdentity(client),
      );
    client.setPresence("foreground");
    if (diagnosticEpoch !== null)
      this.#emit("focus-presence", { diagnosticEpoch, state: "foreground" }, identity);
    client.noteActivity("focus");
    if (diagnosticEpoch !== null)
      this.#emit("focus-activity", { activity: "focus", diagnosticEpoch }, identity);
    const authorities = ["input", "focus", "geometry"] as const;
    this.#appliedMayHoldAuthority = true;
    this.#claimInFlight = true;
    const results = await Promise.allSettled(
      authorities.map((authority) => client.requestAuthority(authority)),
    );
    const current =
      this.#client === client &&
      this.#bindingEpoch === bindingEpoch &&
      this.#stateEpoch === stateEpoch &&
      this.#focused;
    const leases = results.map((result) => (result.status === "fulfilled" ? result.value : null));
    try {
      this.#latestAuthority = client.getAuthoritySnapshot();
    } catch {
      this.#latestAuthority = null;
    }
    const leaseExact = authorities.map((authority, index) =>
      this.#authorityLeaseExact(client, authority, leases[index] ?? null),
    );
    const allExact =
      current &&
      this.#latestAuthority !== null &&
      this.#authoritySnapshotExact(client, this.#latestAuthority) &&
      leaseExact.every(Boolean);
    if (current) {
      this.#heldAuthorities.clear();
      for (const [index, authority] of authorities.entries()) {
        if (
          leaseExact[index] &&
          this.#latestAuthority?.owners[authority] === client.authorityIdentity.clientId
        )
          this.#heldAuthorities.add(authority);
      }
    }
    if (this.#diagnose)
      this.#emit(
        "focus-authority-reconcile",
        {
          outcomeId: ++this.#outcomeId,
          diagnosticEpoch,
          attempt: 1,
          status: allExact ? "applied" : "failed",
          receipts: authorities.map((authority, index) => ({
            authority,
            status: results[index]?.status ?? "rejected",
            granted: leases[index] !== null,
            exact: leaseExact[index] ?? false,
          })),
        },
        identity ?? this.#captureIdentity(client),
      );
    this.#claimInFlight = false;
    if (!current) return false;
    if (allExact && diagnosticEpoch !== null)
      this.#emitFocusSettlement(
        client,
        diagnosticEpoch,
        identity,
        stateEpoch,
        bindingEpoch,
        results,
      );
    // One foreground/binding epoch owns exactly one claim triplet. A partial
    // result remains settled until blur/rebind starts a new epoch. Authority
    // loss passivates this epoch; it must not create a cross-host reclaim loop.
    return true;
  }

  #heldAuthorityLost(
    client: TerminalAuthorityClient,
    snapshot: SessionRuntimeAuthoritySnapshot,
  ): boolean {
    if (this.#heldAuthorities.size === 0) return false;
    const expected = client.authorityIdentity;
    if (snapshot.generation !== expected.generation || snapshot.session !== expected.session)
      return true;
    return [...this.#heldAuthorities].some(
      (authority) => snapshot.owners[authority] !== expected.clientId,
    );
  }

  #emitFocusSettlement(
    client: TerminalAuthorityClient,
    diagnosticEpoch: number,
    identity: TerminalHostFocusIdentity | null,
    stateEpoch: number,
    bindingEpoch: number,
    results: PromiseSettledResult<SessionRuntimeAuthorityLease | null>[],
  ): void {
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
        bindingCurrent:
          this.#client === client &&
          this.#bindingEpoch === bindingEpoch &&
          this.#stateEpoch === stateEpoch &&
          this.#focused,
        status: "fulfilled",
      },
      identity,
    );
  }

  #authorityLeaseExact(
    client: TerminalAuthorityClient,
    authority: SessionRuntimeAuthorityKind,
    lease: SessionRuntimeAuthorityLease | null,
  ): boolean {
    const expected = client.authorityIdentity;
    return (
      lease !== null &&
      lease.authority === authority &&
      lease.generation === expected.generation &&
      lease.session === expected.session &&
      lease.clientId === expected.clientId
    );
  }

  #authoritySnapshotExact(
    client: TerminalAuthorityClient,
    snapshot: SessionRuntimeAuthoritySnapshot,
  ): boolean {
    const expected = client.authorityIdentity;
    const matchingClients = snapshot.clients.filter(
      ({ clientId, state }) => clientId === expected.clientId && state === "foreground",
    );
    return (
      snapshot.generation === expected.generation &&
      snapshot.session === expected.session &&
      matchingClients.length === 1 &&
      snapshot.owners.input === expected.clientId &&
      snapshot.owners.focus === expected.clientId &&
      snapshot.owners.geometry === expected.clientId
    );
  }

  #yield(
    client: TerminalAuthorityClient,
    diagnosticEpoch: number | null = null,
    identity: TerminalHostFocusIdentity | null = null,
    stateEpoch = this.#stateEpoch,
    bindingEpoch = this.#bindingEpoch,
  ): Promise<void> {
    const releases = Promise.allSettled([
      client.releaseAuthority("input"),
      client.releaseAuthority("focus"),
      client.releaseAuthority("geometry"),
    ]);
    if (diagnosticEpoch !== null) {
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
            bindingCurrent:
              this.#client === client &&
              this.#bindingEpoch === bindingEpoch &&
              this.#stateEpoch === stateEpoch &&
              !this.#focused,
            status: results.every(({ status }) => status === "fulfilled") ? "fulfilled" : "partial",
          },
          identity,
        ),
      );
    }
    client.setPresence("background");
    if (diagnosticEpoch !== null)
      this.#emit("blur-presence", { diagnosticEpoch, state: "background" }, identity);
    return releases.then(() => undefined);
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
        runtimeSession: snapshot?.authority?.session ?? null,
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
        runtimeSession: null,
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
