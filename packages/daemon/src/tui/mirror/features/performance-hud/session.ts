import { LocalPerformanceAggregator } from "@tmux-ide/core";
import { createRoot, createSignal } from "solid-js";

import type {
  TuiPerformanceEventSink,
  TuiTerminalDeliveryPerformanceEvent,
} from "../../performance-events.ts";
import type { PerformanceHudHost, PerformanceHudSession } from "./contract.ts";

const FPS_IDLE_MS = 500;

function authorityKey(authority: ReturnType<PerformanceHudHost["authority"]>): string {
  return [
    authority.daemonInstanceId ?? "",
    authority.workspaceName ?? "",
    authority.generation ?? "",
    authority.incarnation ?? "",
  ].join("\0");
}

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
    let aggregatorAuthorityKey: string | null = null;
    let removeEventSink: (() => void) | null = null;
    let removeFrameObserver: (() => void) | null = null;
    let removeIdleDeadline: (() => void) | null = null;
    let seenFrame = false;
    let fpsIdle = true;

    const ensureAggregator = (): LocalPerformanceAggregator | null => {
      if (!isOpen() || isDisposed()) return null;
      const authority = host.authority();
      const key = authorityKey(authority);
      if (aggregator && key === aggregatorAuthorityKey) return aggregator;
      removeIdleDeadline?.();
      removeIdleDeadline = null;
      aggregator?.disable();
      aggregator = new LocalPerformanceAggregator({ source: "opentui", authority });
      aggregator.enable();
      aggregatorAuthorityKey = key;
      seenFrame = false;
      fpsIdle = true;
      return aggregator;
    };

    const publish = (): void => {
      const next = ensureAggregator()?.snapshot() ?? null;
      if (!next) return;
      setSnapshot(fpsIdle || next.activeFps === null ? { ...next, activeFps: null } : next);
    };
    const sink: TuiPerformanceEventSink = Object.freeze({
      frame: (intervalMs: number) => {
        if (!seenFrame) {
          seenFrame = true;
          return;
        }
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
        const active = ensureAggregator();
        if (!active) return;
        active.recordFrame(intervalMs);
        fpsIdle = false;
        removeIdleDeadline?.();
        removeIdleDeadline = host.scheduleIdle(() => {
          removeIdleDeadline = null;
          fpsIdle = true;
          publish();
        }, FPS_IDLE_MS);
      },
      terminalPaint: (dirtyRows: number, durationMs: number) => {
        const active = ensureAggregator();
        active?.recordDirtyRows(dirtyRows);
        active?.recordPaint(durationMs);
      },
      terminalDelivery: (event: TuiTerminalDeliveryPerformanceEvent) => {
        const active = ensureAggregator();
        if (!active) return;
        active.recordParse(event.parseMs);
        active.recordQueueDepth(event.queuePeak, event.queueCapacity);
        active.recordQueueDepth(0, event.queueCapacity);
        active.recordRevisionLag(event.revisionLagPeak);
        active.recordRevisionLag(0);
        if (event.reseed) active.recordReseed();
        publish();
      },
    });

    const stop = (): void => {
      removeFrameObserver?.();
      removeFrameObserver = null;
      removeEventSink?.();
      removeEventSink = null;
      removeIdleDeadline?.();
      removeIdleDeadline = null;
      aggregator?.disable();
      aggregator = null;
      aggregatorAuthorityKey = null;
      seenFrame = false;
      fpsIdle = true;
    };
    const show = (): void => {
      if (isDisposed() || isOpen()) return;
      removeEventSink = host.installEventSink(sink);
      removeFrameObserver = host.observeFrames((intervalMs) => sink.frame(intervalMs));
      setOpen(true);
      ensureAggregator();
      publish();
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
