import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type {
  FleetCatalogAgentEntryV1,
  FleetCatalogSessionEntryV1,
  WorkspacePromoteHostResult,
} from "@tmux-ide/contracts";

import type { DesktopFleetCatalogState } from "../runtime/fleet-catalog-store.ts";

/**
 * The fleet section of the workspace sidebar: every adopted tmux session and the
 * agents inside it, in the SAME status language as the rest of the shell. The
 * open workspace's session is distinguished; app-created vs adopted-only is quiet
 * but legible. Clicking a non-open session opens a confirm-first promote dialog —
 * the click-confirm is the only consent gate; there is no ambient promotion.
 *
 * This component is presentational: it takes the fleet store state plus a promote
 * callback, and never talks to the host directly.
 */

/** The typed error carried by a failed promotion — a daemon verdict or a transport error. */
export type FleetPromoteError = Extract<WorkspacePromoteHostResult, { status: "error" }>["error"];

export interface FleetPromoteOutcome {
  readonly ok: boolean;
  readonly error?: FleetPromoteError;
}

const GENERIC_PROMOTE_FAILURE = "The session could not be opened as a workspace.";

/**
 * A plain, bounded sentence for a `promotion_verification_failed` sub-reason.
 * Unknown sub-reasons fall back to the generic verification line rather than
 * leaking a raw daemon token into the dialog.
 */
function verificationReasonSentence(reason: string | undefined): string {
  switch (reason) {
    case "project_directory_unavailable":
      return "None of the session's directories still exist on disk.";
    case "empty_or_foreign_pane_inventory":
    case "invalid_tmux_pane_inventory":
    case "invalid_tmux_output":
      return "The session's tmux state could not be read cleanly. Try again.";
    case "session_vanished_before_stamp":
    case "session_vanished_during_proof":
      return "The session closed before it could be opened.";
    case "inventory_changed_during_proof":
      return "The session changed while it was being opened. Try again.";
    default:
      return "The session did not pass admission checks.";
  }
}

/**
 * Map a failed promotion to one plain sentence. A typed daemon verdict resolves
 * to a specific, actionable line; a generic capability error surfaces its own
 * (already plain) reason — the generic transport line is reserved for exactly
 * those cases where the daemon never reached a verdict.
 */
export function promoteFailureSentence(error: FleetPromoteError | undefined): string {
  if (!error) return GENERIC_PROMOTE_FAILURE;
  // The promotion variant is the only one carrying `kind`; its presence cleanly
  // separates a typed daemon verdict from a generic capability error.
  if ("kind" in error) {
    switch (error.code) {
      case "session_not_found":
        return "This session is no longer in the fleet.";
      case "session_not_adopted":
        return "Adopt this session before opening it as a workspace.";
      case "session_internal":
        return "Internal tmux-ide sessions cannot be opened as a workspace.";
      case "workspace_conflict":
        return "Another workspace already claims this session.";
      case "stamp_failed":
        return "tmux could not durably mark the session. Try again.";
      case "promotion_verification_failed":
        return verificationReasonSentence(error.reason);
      case "operation_conflict":
        return "A different open request is already using this id. Try again.";
      case "operation_capacity":
        return "The app is busy opening sessions. Try again in a moment.";
      case "daemon_instance_mismatch":
        return "The daemon restarted during the request. Try again.";
      default:
        return GENERIC_PROMOTE_FAILURE;
    }
  }
  // Capability errors already carry a plain, human-readable reason string.
  return error.reason;
}

export interface FleetSidebarSectionProps {
  readonly state: DesktopFleetCatalogState;
  /**
   * The opaque fleet session id of the currently open workspace, when known, so
   * it can be marked as open and made non-promotable. The renderer cannot yet
   * correlate the open workspace to its fleet session id, so callers pass null
   * until a daemon-provided correlation key exists.
   */
  readonly openSessionId?: string | null;
  /** Perform the owner-gated promotion; resolves ok/reason for the dialog. */
  readonly onPromote: (sessionId: string) => Promise<FleetPromoteOutcome>;
}

/** Map an agent's activity to the shell's shared status-glyph token. */
function agentTone(activity: FleetCatalogAgentEntryV1["activity"]): string {
  if (activity === "running") return "running";
  if (activity === "complete") return "complete";
  if (activity === "disconnected") return "recovery";
  return "waiting";
}

/**
 * Roll a session's agents up to one glyph: attention wins, then any working
 * agent, then any waiting/blocked, then completion, else idle.
 */
function sessionTone(session: FleetCatalogSessionEntryV1): string {
  if (session.agents.some((agent) => agent.attention)) return "waiting";
  if (session.agents.some((agent) => agent.activity === "running")) return "running";
  if (session.agents.some((agent) => agent.activity === "waiting" || agent.activity === "failed")) {
    return "waiting";
  }
  if (session.agents.length > 0 && session.agents.every((agent) => agent.activity === "complete")) {
    return "complete";
  }
  return "idle";
}

function agentSummary(session: FleetCatalogSessionEntryV1): string {
  const count = session.agents.length;
  if (count === 0) return "no agents";
  return count === 1 ? "1 agent" : `${count} agents`;
}

export function FleetSidebarSection(props: FleetSidebarSectionProps): JSX.Element {
  const [pendingSession, setPendingSession] = createSignal<FleetCatalogSessionEntryV1 | null>(null);
  const [promoting, setPromoting] = createSignal(false);
  const [promoteError, setPromoteError] = createSignal<string | null>(null);

  const snapshot = createMemo(() => ("snapshot" in props.state ? props.state.snapshot : null));
  const sessions = createMemo(() => snapshot()?.catalog.sessions ?? []);
  const unavailableReason = createMemo(() => {
    const state = props.state;
    if (snapshot()) return null;
    if (state.status === "loading") return "loading";
    if (state.status === "degraded" || state.status === "error") return state.reason;
    return null;
  });

  const isOpen = (session: FleetCatalogSessionEntryV1): boolean =>
    props.openSessionId != null && session.sessionId === props.openSessionId;

  const closeDialog = (): void => {
    setPendingSession(null);
    setPromoting(false);
    setPromoteError(null);
  };

  const confirmPromotion = async (): Promise<void> => {
    const session = pendingSession();
    if (!session || promoting()) return;
    setPromoting(true);
    setPromoteError(null);
    const outcome = await props.onPromote(session.sessionId);
    if (outcome.ok) {
      closeDialog();
      return;
    }
    setPromoting(false);
    setPromoteError(promoteFailureSentence(outcome.error));
  };

  return (
    <section aria-labelledby="fleet-heading" class="fleet-sidebar" data-focus-zone="fleet">
      <h2 id="fleet-heading">
        Fleet <span>{sessions().length}</span>
      </h2>

      <Show when={unavailableReason()}>
        {(reason) => (
          <p class="fleet-sidebar__quiet" data-fleet-state={props.state.status}>
            {reason() === "loading" ? "Loading the fleet…" : "Fleet unavailable"}
          </p>
        )}
      </Show>

      <Show when={snapshot() && sessions().length === 0}>
        <p class="fleet-sidebar__quiet">No adopted sessions yet.</p>
      </Show>

      <For each={sessions()}>
        {(session) => (
          <div class="fleet-sidebar__session" data-open={isOpen(session)}>
            <div
              class="sidebar-row fleet-sidebar__session-head"
              classList={{ "sidebar-row--active": isOpen(session) }}
            >
              <i data-state={sessionTone(session)} />
              <span class="sidebar-row__identity">
                <span>{session.label}</span>
                <small>
                  {session.projectLabel} · {agentSummary(session)}
                  <Show when={!session.appCreated}>
                    <span class="fleet-sidebar__badge fleet-sidebar__badge--adopted"> adopted</span>
                  </Show>
                </small>
              </span>
              {/*
               * One trailing slot, one width, for every row.
               *
               * The open badge used to live INSIDE the identity column while the
               * Open button lived outside it, so two rows of identical width gave
               * their session names different amounts of room and truncated at
               * different points — which reads as the list being unable to make
               * up its mind rather than as a name being too long.
               */}
              <span class="fleet-sidebar__affordance">
                <Show
                  when={!isOpen(session)}
                  fallback={
                    <small class="fleet-sidebar__badge fleet-sidebar__badge--open">open</small>
                  }
                >
                  <button
                    type="button"
                    class="fleet-sidebar__open-action"
                    aria-label={`Open ${session.label} as workspace`}
                    onClick={() => {
                      setPromoteError(null);
                      setPendingSession(session);
                    }}
                  >
                    Open
                  </button>
                </Show>
              </span>
            </div>

            <For each={session.agents}>
              {(agent) => (
                <div class="sidebar-row sidebar-row--agent fleet-sidebar__agent">
                  <i data-state={agentTone(agent.activity)} />
                  <span class="sidebar-row__identity">
                    <span>{agent.name}</span>
                    <small>
                      {agent.harness} · {agent.activity}
                    </small>
                  </span>
                  <Show when={agent.attention}>
                    <b aria-label="Needs attention" />
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </For>

      <Show when={pendingSession()}>
        {(session) => (
          <div class="fleet-sidebar__overlay" data-overlay-root="true">
            <div
              class="fleet-sidebar__dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="fleet-promote-title"
              aria-describedby="fleet-promote-body"
            >
              <h3 id="fleet-promote-title">Open “{session().label}” as a workspace?</h3>
              <p id="fleet-promote-body" class="fleet-sidebar__dialog-body">
                This registers the session with the app and writes tmux-ide identity options to its
                panes. Nothing is rearranged or restarted.
              </p>
              <Show when={promoteError()}>
                {(reason) => (
                  <p class="fleet-sidebar__dialog-error" role="alert">
                    {reason()}
                  </p>
                )}
              </Show>
              <div class="fleet-sidebar__dialog-actions">
                <button
                  type="button"
                  class="fleet-sidebar__dialog-cancel"
                  disabled={promoting()}
                  onClick={closeDialog}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="fleet-sidebar__dialog-confirm"
                  disabled={promoting()}
                  onClick={() => {
                    void confirmPromotion();
                  }}
                >
                  {promoting() ? "Opening…" : "Open as workspace"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
