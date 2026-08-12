import { LocalPerformanceAggregator } from "@tmux-ide/core";
import { createRoot, createSignal } from "solid-js";

import type { TuiPerformanceEventSink } from "../../performance-events.ts";
import type { PerformanceHudHost, PerformanceHudSession } from "./contract.ts";

/**
 * Demand-owned local metrics lifecycle. Frame and paint callbacks only mutate
 * the bounded aggregator; a real parser/queue/revision/reseed event publishes
 * the next immutable Solid snapshot. This avoids a paint -> signal -> paint
 * feedback loop and keeps an idle HUD completely still.
 */
export function createPerformanceHudSession(host: PerformanceHudHost): PerformanceHudSession {
  return createRoot((disposeRoot) => {
    const [isOpen, setOpen] = createSignal(false);
    const [isDisposed, setDisposed] = createSignal(false);
    const [snapshot, setSnapshot] =
      createSignal<ReturnType<PerformanceHudSession["snapshot"]>>(null);
    let aggregator: LocalPerformanceAggregator | null = null;
    let removeEventSink: (() => void) | null = null;
    let removeFrameObserver: (() => void) | null = null;

    const publish = (): void => {
      const next = aggregator?.snapshot() ?? null;
      if (next) setSnapshot(next);
    };
    const sink: TuiPerformanceEventSink = Object.freeze({
      frame: (intervalMs: number) => aggregator?.recordFrame(intervalMs),
      terminalPaint: (dirtyRows: number, durationMs: number) => {
        aggregator?.recordDirtyRows(dirtyRows);
        aggregator?.recordPaint(durationMs);
      },
      terminalParse: (durationMs: number) => {
        aggregator?.recordParse(durationMs);
        publish();
      },
      queueDepth: (current: number, capacity: number | null) => {
        aggregator?.recordQueueDepth(current, capacity);
        publish();
      },
      revisionLag: (lag: number) => {
        aggregator?.recordRevisionLag(lag);
        publish();
      },
      reseed: () => {
        aggregator?.recordReseed();
        publish();
      },
    });

    const stop = (): void => {
      removeFrameObserver?.();
      removeFrameObserver = null;
      removeEventSink?.();
      removeEventSink = null;
      aggregator?.disable();
      aggregator = null;
    };
    const show = (): void => {
      if (isDisposed() || isOpen()) return;
      aggregator = new LocalPerformanceAggregator({
        source: "opentui",
        authority: host.authority(),
      });
      aggregator.enable();
      removeEventSink = host.installEventSink(sink);
      removeFrameObserver = host.observeFrames((intervalMs) => sink.frame(intervalMs));
      setSnapshot(aggregator.snapshot());
      setOpen(true);
    };
    const hide = (): void => {
      if (!isOpen()) return;
      stop();
      setOpen(false);
      setSnapshot(null);
    };

    return {
      open: isOpen,
      disposed: isDisposed,
      snapshot,
      toggle: () => (isOpen() ? hide() : show()),
      show,
      hide,
      dispose: () => {
        if (isDisposed()) return;
        stop();
        setOpen(false);
        setSnapshot(null);
        setDisposed(true);
        disposeRoot();
      },
    };
  });
}
