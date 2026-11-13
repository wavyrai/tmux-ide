import {
  paneStreamCloseForRetirement,
  type PaneStreamShutdownClose,
} from "../terminal/pane-stream/pane-stream-websocket.ts";
import type { TrackTeardownStep } from "./daemon-stop-progress.ts";
import type { TmuxServerOwnerRetirement } from "./tmux-server-owners.ts";

export type NativeOwnerTeardownStep = readonly [name: string, close: () => unknown];

export interface NativeOwnerTeardownParts {
  readonly serverId: string;
  readonly paneStreams: { dispose(close?: PaneStreamShutdownClose): Promise<void> };
  /** Synchronous: from here on the owner refuses new work. */
  readonly markRetired: () => void;
  /**
   * Synchronous prelude (abort credentials, start observation disposal), then
   * the ordered steps. `streamsClosed` is the stream shutdown already under way.
   */
  readonly begin: (streamsClosed: Promise<void>) => readonly NativeOwnerTeardownStep[];
  readonly track?: TrackTeardownStep;
}

/**
 * One tmux server owner's teardown. The pane streams hear first, and hear why:
 * a retired owner under a live daemon means "reconnect now", not "the daemon
 * is shutting down" (#840). Every later step runs even if an earlier one
 * fails; the failures are reported together. Idempotent.
 */
export function createNativeOwnerTeardown(
  parts: NativeOwnerTeardownParts,
): (retirement?: TmuxServerOwnerRetirement) => Promise<void> {
  let teardown: Promise<void> | null = null;
  return (retirement) => {
    if (teardown) return teardown;
    parts.markRetired();
    const streamsClosed = parts.paneStreams.dispose(paneStreamCloseForRetirement(retirement));
    streamsClosed.catch(() => undefined);
    const steps = parts.begin(streamsClosed);
    const track: TrackTeardownStep = parts.track ?? (async (_step, work) => await work());
    teardown = (async () => {
      const failures: unknown[] = [];
      for (const [step, close] of steps) {
        try {
          await track(`owner:${parts.serverId}:${step}`, close);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Tmux server owner retirement failed");
    })();
    return teardown;
  };
}
