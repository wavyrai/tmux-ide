import { createSignal, onCleanup } from "solid-js";
import {
  initialGuidedTourState,
  reduceGuidedTour,
  sameGuidedTourPractice,
  type GuidedTourEvent,
  type GuidedTourPractice,
  type GuidedTourState,
} from "./guided-tour.ts";
import { readGuidedTourState, writeGuidedTourState } from "./guided-tour-storage.ts";

export interface GuidedTourObservation {
  readonly practice: GuidedTourPractice | null;
  readonly panes: readonly {
    readonly id: string;
    readonly width: number;
    readonly height: number;
  }[];
  readonly focusedPane: string | null;
  readonly surface: "home" | "terminals";
  readonly paletteOpen: boolean;
  readonly theme: string;
}
/** Compare confirmed snapshots; unrelated sessions and request attempts never count. */
export function observedGuidedTourEvent(
  state: GuidedTourState,
  previous: GuidedTourObservation | null,
  current: GuidedTourObservation,
): GuidedTourEvent | null {
  if (!state.active || !previous) return null;
  if (state.step === "commands" && current.paletteOpen && !previous.paletteOpen)
    return { type: "commands-opened" };
  if (state.step === "theme" && current.theme !== previous.theme) return { type: "theme-changed" };
  if (state.step === "leave" && current.surface === "home") return { type: "home-opened" };
  if (
    !current.practice ||
    !sameGuidedTourPractice(state.practice, current.practice) ||
    current.surface !== "terminals"
  )
    return null;
  if (
    state.step === "reopen" &&
    (previous.surface !== "terminals" ||
      !sameGuidedTourPractice(previous.practice, current.practice))
  )
    return { type: "reopened", practice: current.practice };
  if (!previous.practice || !sameGuidedTourPractice(previous.practice, current.practice))
    return null;
  if (
    state.step === "split" &&
    current.panes.length > previous.panes.length &&
    previous.panes.every((old) => current.panes.some((p) => p.id === old.id)) &&
    current.panes.some((p) => !previous.panes.some((old) => old.id === p.id))
  )
    return { type: "split-confirmed", practice: current.practice };
  if (
    state.step === "focus" &&
    previous.focusedPane &&
    current.focusedPane &&
    previous.focusedPane !== current.focusedPane &&
    current.panes.some((p) => p.id === current.focusedPane) &&
    current.panes.some((p) => p.id === previous.focusedPane)
  )
    return { type: "focus-confirmed", practice: current.practice };
  // A divider reallocates space between the same panes: one grows while
  // another shrinks on the same axis. Whole-app growth/shrink is not practice.
  const samePanes =
    current.panes.length >= 2 &&
    current.panes.length === previous.panes.length &&
    previous.panes.every((old) => current.panes.some((pane) => pane.id === old.id));
  const reallocated = (["width", "height"] as const).some((axis) => {
    const changes = current.panes.map(
      (pane) =>
        pane[axis] - (previous.panes.find((old) => old.id === pane.id)?.[axis] ?? pane[axis]),
    );
    return changes.some((change) => change > 0) && changes.some((change) => change < 0);
  });
  if (state.step === "resize" && samePanes && reallocated)
    return { type: "resize-confirmed", practice: current.practice };
  return null;
}
export function createApplicationGuidedTourOwner(options: {
  createPractice(): Promise<GuidedTourPractice>;
  openPractice(practice: GuidedTourPractice): Promise<void> | void;
  read?: () => GuidedTourState;
  write?: (state: GuidedTourState) => boolean;
}) {
  const [state, setState] = createSignal((options.read ?? readGuidedTourState)());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let previous: GuidedTourObservation | null = null;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const send = (event: GuidedTourEvent) => {
    const next = reduceGuidedTour(state(), event);
    if (next === state()) return;
    setState(next);
    if (!(options.write ?? writeGuidedTourState)(next))
      setError("Progress could not be saved. You can still continue this tour.");
  };
  return {
    state,
    busy,
    error,
    label: () =>
      state().step === "complete"
        ? "Replay walkthrough"
        : state().step === initialGuidedTourState().step
          ? "Learn tmux-ide"
          : "Resume walkthrough",
    open() {
      previous = null;
      send({ type: state().step === "complete" ? "replay" : "resume" });
    },
    replay() {
      previous = null;
      send({ type: "replay" });
    },
    pause() {
      send({ type: "pause" });
    },
    welcomeRead() {
      send({ type: "welcome-read" });
    },
    observe(current: GuidedTourObservation) {
      const event = observedGuidedTourEvent(state(), previous, current);
      previous = current;
      if (event) send(event);
    },
    async createPractice() {
      if (busy() || state().step !== "practice") return;
      setBusy(true);
      setError(null);
      try {
        const practice = await options.createPractice();
        if (disposed) return;
        send({ type: "practice-created", practice });
        if (state().active) await options.openPractice(practice);
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Could not create the practice session.",
          );
      } finally {
        if (!disposed) setBusy(false);
      }
    },
    async openPractice() {
      const practice = state().practice;
      if (!practice || busy()) return;
      setError(null);
      try {
        if (state().active) await options.openPractice(practice);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Practice session is unavailable.");
      }
    },
  };
}
