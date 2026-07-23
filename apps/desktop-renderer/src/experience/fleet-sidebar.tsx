import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { FleetCatalogAgentEntryV1, FleetCatalogSessionEntryV1 } from "@tmux-ide/contracts";

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

export interface FleetPromoteOutcome {
  readonly ok: boolean;
  readonly reason?: string;
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
    setPromoteError(outcome.reason ?? "The session could not be opened as a workspace.");
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
                <span>
                  {session.label}
                  <Show when={isOpen(session)}>
                    <small class="fleet-sidebar__badge fleet-sidebar__badge--open"> open</small>
                  </Show>
                </span>
                <small>
                  {session.projectLabel} · {agentSummary(session)}
                  <Show when={!session.appCreated}>
                    <span class="fleet-sidebar__badge fleet-sidebar__badge--adopted"> adopted</span>
                  </Show>
                </small>
              </span>
              <Show when={!isOpen(session)}>
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
