import type { LocalPerformanceAuthorityV1, LocalPerformanceSnapshotV1 } from "@tmux-ide/contracts";

import type { TuiPerformanceEventSink } from "../../performance-events.ts";

export interface PerformanceHudHost {
  readonly authority: () => LocalPerformanceAuthorityV1;
  readonly installEventSink: (sink: TuiPerformanceEventSink) => () => void;
  readonly observeFrames: (listener: (intervalMs: number) => void) => () => void;
}

export interface PerformanceHudSession {
  readonly open: () => boolean;
  readonly disposed: () => boolean;
  readonly snapshot: () => LocalPerformanceSnapshotV1 | null;
  readonly toggle: () => void;
  readonly show: () => void;
  readonly hide: () => void;
  readonly dispose: () => void;
}
