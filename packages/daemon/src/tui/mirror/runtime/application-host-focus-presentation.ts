import type { TuiPerformanceEventSink } from "../performance-events.ts";
import {
  qualifiesPaneSurfaceHostFocusFrame,
  type PaneSurfaceHostFocusTransitionOwner,
} from "../pane-surface.tsx";
import type { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import type { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";

type FrameRenderer = Readonly<{
  on(event: "frame" | "focus" | "blur", listener: () => void): void;
  off(event: "frame" | "focus" | "blur", listener: () => void): void;
  requestRender(): void;
}>;

export type HostFocusRendererSource = Readonly<{
  adapter: TerminalFastLaneRendererAdapter;
  rendererEpoch: number;
  daemonGeneration: string;
  clientGeneration: number;
}>;

export function createApplicationHostFocusPresentation(
  options: Readonly<{
    renderer: FrameRenderer;
    owner: PaneSurfaceHostFocusTransitionOwner | null;
    sink: TuiPerformanceEventSink | null;
    hostFocus: OpenTuiTerminalHostFocus;
    focusedPane: () => string | null;
    rendererFocused: () => boolean;
    setRendererFocused: (focused: boolean) => void;
    rendererSource: () => HostFocusRendererSource | null;
  }>,
): Readonly<{
  driveFocusState(focused: boolean): Readonly<{
    changed: boolean;
    diagnosticEpoch: number | null;
  }>;
  dispose(): void;
}> {
  let pendingFrame: { readonly token: number; readonly listener: () => void } | null = null;
  const cancelPending = (token?: number) => {
    const pending = pendingFrame;
    if (pending && (token === undefined || pending.token === token)) {
      options.renderer.off("frame", pending.listener);
      pendingFrame = null;
    }
    options.owner?.cancel(token);
  };
  const prepare = (focused: boolean, diagnosticEpoch: number): number | null => {
    const owner = options.owner;
    if (!owner) return null;
    try {
      cancelPending();
      const paneId = options.focusedPane();
      const source = options.rendererSource();
      const identity = paneId ? source?.adapter.paneCanonicalIdentity(paneId) : null;
      if (!paneId || !source || !identity) return null;
      const token = owner.arm({
        diagnosticEpoch,
        semanticPaneId: paneId,
        focused,
        rendererEpoch: source.rendererEpoch,
        daemonGeneration: source.daemonGeneration,
        clientGeneration: source.clientGeneration,
        ...identity,
      });
      if (token === null) return null;
      const listener = () => {
        if (owner.pending(token)) return;
        const completed = owner.completed(token);
        if (completed) {
          const { event } = completed;
          try {
            const currentPaneId = options.focusedPane();
            const currentSource = options.rendererSource();
            const currentIdentity = currentPaneId
              ? currentSource?.adapter.paneCanonicalIdentity(currentPaneId)
              : null;
            if (
              currentPaneId &&
              currentSource &&
              currentIdentity &&
              qualifiesPaneSurfaceHostFocusFrame(completed, {
                semanticPaneId: currentPaneId,
                focused: options.rendererFocused(),
                rendererEpoch: currentSource.rendererEpoch,
                daemonGeneration: currentSource.daemonGeneration,
                clientGeneration: currentSource.clientGeneration,
                identity: currentIdentity,
              })
            )
              options.sink?.terminalFocusFence?.({
                ...event,
                atMicros: Math.floor(performance.now() * 1_000),
              });
          } catch {
            // A diagnostic frame fence never owns native frame publication.
          }
          owner.retire(token);
        }
        const pending = pendingFrame;
        if (pending?.token !== token) return;
        options.renderer.off("frame", pending.listener);
        pendingFrame = null;
      };
      pendingFrame = { token, listener };
      options.renderer.on("frame", listener);
      return token;
    } catch {
      cancelPending();
      return null;
    }
  };
  const settle = (token: number | null) => {
    if (token === null) return;
    try {
      options.renderer.requestRender();
    } catch {
      cancelPending(token);
    }
  };
  const driveFocusState = (focused: boolean) => {
    if (options.rendererFocused() === focused)
      return Object.freeze({ changed: false, diagnosticEpoch: null });
    const diagnosticEpoch = focused
      ? options.hostFocus.rendererFocus()
      : options.hostFocus.rendererBlur();
    const token = diagnosticEpoch === null ? null : prepare(focused, diagnosticEpoch);
    options.setRendererFocused(focused);
    settle(token);
    return Object.freeze({ changed: diagnosticEpoch !== null, diagnosticEpoch });
  };
  const focus = () => void driveFocusState(true);
  const blur = () => void driveFocusState(false);
  options.renderer.on("focus", focus);
  options.renderer.on("blur", blur);
  return Object.freeze({
    driveFocusState,
    dispose() {
      cancelPending();
      options.renderer.off("focus", focus);
      options.renderer.off("blur", blur);
    },
  });
}
