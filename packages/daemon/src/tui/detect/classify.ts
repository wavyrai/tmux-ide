/**
 * The 4-state agent classifier.
 *
 * Turns snapshot + manifest evidence into a final per-pane status. The
 * instantaneous half (`classifyInstant`) is pure: it maps a single snapshot
 * through a manifest to blocked/working/idle/unknown. The `done` state,
 * however, is inherently cross-tick — an agent is "done" only when it WAS
 * working and has since gone quiet without being viewed. That temporal logic
 * lives in the small stateful `StatusTracker`, which layers `done` + seen
 * acknowledgement on top of the instantaneous state.
 */
import type { AgentManifest } from "./manifest.ts";
import { evaluateManifest, pickManifest } from "./manifest.ts";
import { BUNDLED_MANIFESTS } from "./manifests.ts";
import type { PaneSnapshot } from "./snapshot.ts";

/** The final per-pane status surfaced to the TUI. */
export type AgentStatus = "blocked" | "working" | "done" | "idle" | "unknown";

/** The instantaneous status derivable from a single snapshot (no history). */
export type InstantState = "blocked" | "working" | "idle" | "unknown";

/**
 * Working/blocked reports older than this are considered stale — the agent
 * (or its hook) probably died mid-turn, so we fall back to screen scraping.
 * Done/idle are terminal until the next event and never go stale.
 */
const AUTHORITY_STALE_SECONDS = 600;

const AUTHORITY_STATES = new Set(["working", "blocked", "done", "idle"]);

/**
 * Parse an authoritative `@agent_state` pane option (`"<state>:<epoch>"`,
 * written by lifecycle-hook integrations or any self-reporting agent).
 * PURE — returns the reported status, or null when the value is absent,
 * malformed, or stale (working/blocked past {@link AUTHORITY_STALE_SECONDS}).
 * A fresh authority report OUTRANKS screen-manifest scraping.
 */
export function parseAuthority(raw: string | undefined, nowSec: number): AgentStatus | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf(":");
  if (sep === -1) return null;
  const state = raw.slice(0, sep);
  const epoch = Number(raw.slice(sep + 1));
  if (!AUTHORITY_STATES.has(state) || !Number.isFinite(epoch)) return null;
  if ((state === "working" || state === "blocked") && nowSec - epoch > AUTHORITY_STALE_SECONDS) {
    return null;
  }
  return state as AgentStatus;
}

/**
 * Extract the epoch STAMP from an `@agent_state` value (`"<state>:<epoch>"`) —
 * the "since" timestamp of the reported state. PURE — returns the epoch, or
 * null when the value is absent or its stamp isn't a finite number. Staleness
 * is NOT considered here (that's {@link parseAuthority}'s job); callers pair
 * this with a fresh `parseAuthority` result to surface a state's `since`.
 */
export function parseAuthorityEpoch(raw: string | undefined): number | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf(":");
  if (sep === -1) return null;
  const epoch = Number(raw.slice(sep + 1));
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * Classify a single snapshot against a manifest — PURE, never throws.
 *
 * - no manifest → `"unknown"` (we can't reason about an unrecognized command)
 * - manifest reports `blocked` → `"blocked"`
 * - manifest reports `working` → `"working"`
 * - manifest reports `done` or nothing → `"idle"`
 *
 * A manifest-detected `done` is deliberately collapsed to `idle` here; the
 * real, cross-tick `done` is produced by {@link StatusTracker}.
 */
export function classifyInstant(
  snapshot: PaneSnapshot & { title?: string },
  manifest: AgentManifest | undefined,
): InstantState {
  if (!manifest) return "unknown";

  const { state } = evaluateManifest(snapshot, manifest);
  switch (state) {
    case "blocked":
      return "blocked";
    case "working":
      return "working";
    // "done" (instantaneous) and null both fall through to idle.
    default:
      return "idle";
  }
}

/**
 * Convenience wrapper: pick the manifest for a pane command, then classify.
 * Returns `"unknown"` when no manifest applies to the command.
 */
export function classifyPaneCommand(
  snapshot: PaneSnapshot & { title?: string },
  command: string,
  manifests: AgentManifest[] = BUNDLED_MANIFESTS,
): InstantState {
  return classifyInstant(snapshot, pickManifest(command, manifests));
}

/** Per-pane bookkeeping the tracker keeps between ticks. */
interface PaneState {
  /** Whether the previous tick observed `working`. */
  wasWorking: boolean;
  /** A working→idle transition happened and hasn't been acknowledged. */
  doneUnseen: boolean;
}

/**
 * Stateful layer that adds `done` + seen-acknowledgement on top of the
 * instantaneous state. Deterministic given its call sequence.
 */
export interface StatusTracker {
  /**
   * Fold a fresh instantaneous state into the pane's history and return the
   * final status. `opts.seen` marks the pane as currently viewed/attached,
   * which acknowledges (and suppresses) a pending `done`.
   */
  update(paneId: string, instant: InstantState, opts?: { seen?: boolean }): AgentStatus;
  /** Acknowledge a pane — clears any pending `done`. */
  markSeen(paneId: string): void;
  /** Drop a pane's state entirely (e.g. its session closed). */
  forget(paneId: string): void;
}

/**
 * Create a {@link StatusTracker}.
 *
 * State transitions (given the previous tick's bookkeeping):
 * - `working` → clear `doneUnseen`, remember working → `"working"`.
 * - `blocked` → clear `doneUnseen` (blocked outranks a pending done) →
 *   `"blocked"`.
 * - `idle`:
 *   - a working→idle transition sets `doneUnseen`.
 *   - `doneUnseen` && not seen → `"done"`.
 *   - otherwise → `"idle"`.
 * - `unknown` → `"unknown"` (leaves `doneUnseen` untouched).
 *
 * `opts.seen === true` always clears `doneUnseen`, and downgrades a would-be
 * `done` to `"idle"` — seeing a finished pane acknowledges it.
 */
export function createStatusTracker(): StatusTracker {
  const states = new Map<string, PaneState>();

  function get(paneId: string): PaneState {
    let s = states.get(paneId);
    if (!s) {
      s = { wasWorking: false, doneUnseen: false };
      states.set(paneId, s);
    }
    return s;
  }

  return {
    update(paneId, instant, opts) {
      const seen = opts?.seen === true;
      const s = get(paneId);

      switch (instant) {
        case "working":
          s.doneUnseen = false;
          s.wasWorking = true;
          return "working";

        case "blocked":
          s.doneUnseen = false;
          s.wasWorking = false;
          return "blocked";

        case "idle": {
          // A working→idle transition means the agent just finished.
          if (s.wasWorking) s.doneUnseen = true;
          s.wasWorking = false;

          // Viewing the pane acknowledges any pending done.
          if (seen) {
            s.doneUnseen = false;
            return "idle";
          }
          return s.doneUnseen ? "done" : "idle";
        }

        case "unknown":
        default:
          // Leave doneUnseen untouched; unknown is not a transition signal.
          s.wasWorking = false;
          if (seen) s.doneUnseen = false;
          return "unknown";
      }
    },

    markSeen(paneId) {
      const s = states.get(paneId);
      if (s) s.doneUnseen = false;
    },

    forget(paneId) {
      states.delete(paneId);
    },
  };
}
