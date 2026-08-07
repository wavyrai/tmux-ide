/**
 * The PURE updater state machine — the single source of truth for the auto-update
 * lifecycle. The io orchestrator ({@link ./desktop-updater.ts}) drives it with
 * events and renders its state; this module decides every legal transition and
 * nothing else. No timers, no io, no throwing.
 *
 * ```
 *            check-requested        update-found            download-succeeded
 *   idle ───────────────────▶ checking ──────────▶ downloading ──────────────▶ ready
 *    ▲  ▲                        │  │                   │                         │
 *    │  └───── no-update ────────┘  └── check-failed ───┤                         │ apply-requested
 *    │                                                  │ download-failed         ▼
 *    └──────────────────────────────────────────────────┴───────────────────  applying
 * ```
 *
 * `ready` is sticky: once an update is staged, further `check-requested` events
 * are ignored until the process restarts. Every failure edge returns to `idle`
 * with the pending version cleared — the app keeps running its current version,
 * quietly. `apply-requested` (only legal from `ready`) moves to `applying`, used
 * during quit; `apply-failed` falls back to `ready` so the app can still quit and
 * retry the swap next time.
 */
import type { DesktopUpdatePhase } from "@tmux-ide/contracts";

export interface UpdateState {
  readonly phase: DesktopUpdatePhase;
  /** The newer version in flight, or null. Set on `update-found`. */
  readonly availableVersion: string | null;
}

export type UpdateEvent =
  | { readonly type: "check-requested" }
  | { readonly type: "no-update" }
  | { readonly type: "check-failed" }
  | { readonly type: "update-found"; readonly version: string }
  | { readonly type: "download-succeeded"; readonly version: string }
  | { readonly type: "download-failed" }
  | { readonly type: "apply-requested" }
  | { readonly type: "apply-failed" };

export const INITIAL_UPDATE_STATE: UpdateState = Object.freeze({
  phase: "idle",
  availableVersion: null,
});

const IDLE: UpdateState = INITIAL_UPDATE_STATE;

/**
 * PURE — the reducer. Returns the next state, or the SAME state object when the
 * event is not legal from the current phase (so callers can cheaply detect
 * "nothing changed" by identity).
 */
export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (state.phase) {
    case "idle":
      if (event.type === "check-requested") return { phase: "checking", availableVersion: null };
      return state;
    case "checking":
      switch (event.type) {
        case "update-found":
          return { phase: "downloading", availableVersion: event.version };
        case "no-update":
        case "check-failed":
          return IDLE;
        default:
          return state;
      }
    case "downloading":
      switch (event.type) {
        case "download-succeeded":
          return { phase: "ready", availableVersion: event.version };
        case "download-failed":
          return IDLE;
        default:
          return state;
      }
    case "ready":
      if (event.type === "apply-requested") {
        return { phase: "applying", availableVersion: state.availableVersion };
      }
      return state;
    case "applying":
      if (event.type === "apply-failed") {
        return { phase: "ready", availableVersion: state.availableVersion };
      }
      return state;
    default:
      return state;
  }
}
