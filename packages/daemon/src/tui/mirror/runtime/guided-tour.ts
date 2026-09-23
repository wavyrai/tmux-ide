/** A small, action-driven tour. No timers and no mutations of terminal sessions. */
export const GUIDED_TOUR_STEPS = [
  "welcome",
  "practice",
  "split",
  "focus",
  "resize",
  "commands",
  "theme",
  "leave",
  "reopen",
  "complete",
] as const;
export type GuidedTourStep = (typeof GUIDED_TOUR_STEPS)[number];
export interface GuidedTourPractice {
  readonly machineId: string;
  readonly serverId: string;
  readonly generation: string;
  readonly sessionId: string;
  readonly sessionName: string;
}
export interface GuidedTourState {
  readonly version: 1;
  readonly step: GuidedTourStep;
  readonly active: boolean;
  readonly practice: GuidedTourPractice | null;
}
export type GuidedTourEvent =
  | { readonly type: "start" | "pause" | "resume" | "replay" | "welcome-read" }
  | { readonly type: "practice-created"; readonly practice: GuidedTourPractice }
  | { readonly type: "practice-missing" }
  | {
      readonly type: "split-confirmed" | "focus-confirmed" | "resize-confirmed" | "reopened";
      readonly practice: GuidedTourPractice;
    }
  | { readonly type: "commands-opened" | "theme-changed" | "home-opened" };

export function initialGuidedTourState(): GuidedTourState {
  return { version: 1, step: "welcome", active: false, practice: null };
}
export function sameGuidedTourPractice(
  a: GuidedTourPractice | null,
  b: GuidedTourPractice,
): boolean {
  return (
    a !== null &&
    a.machineId === b.machineId &&
    a.serverId === b.serverId &&
    a.generation === b.generation &&
    a.sessionId === b.sessionId
  );
}
/** Call confirmation events only after an observed change, never on request dispatch. */
export function reduceGuidedTour(state: GuidedTourState, event: GuidedTourEvent): GuidedTourState {
  if (event.type === "replay") return { ...initialGuidedTourState(), active: true };
  if (event.type === "pause") return state.active ? { ...state, active: false } : state;
  if (event.type === "start" || event.type === "resume") {
    return state.step === "complete" ? state : { ...state, active: true };
  }
  if (event.type === "practice-created" && state.step === "practice") {
    return { ...state, step: "split", practice: event.practice };
  }
  if (!state.active) return state;
  if (event.type === "practice-missing" && state.practice && state.step !== "complete") {
    return { ...state, step: "practice", practice: null };
  }
  if (event.type === "welcome-read" && state.step === "welcome")
    return { ...state, step: "practice" };
  if ("practice" in event && !sameGuidedTourPractice(state.practice, event.practice)) return state;
  const expected: Partial<Record<GuidedTourStep, GuidedTourEvent["type"]>> = {
    split: "split-confirmed",
    focus: "focus-confirmed",
    resize: "resize-confirmed",
    commands: "commands-opened",
    theme: "theme-changed",
    leave: "home-opened",
    reopen: "reopened",
  };
  if (expected[state.step] !== event.type) return state;
  const step = GUIDED_TOUR_STEPS[GUIDED_TOUR_STEPS.indexOf(state.step) + 1]!;
  return { ...state, step };
}

export interface GuidedTourShortcuts {
  readonly commands?: string;
  readonly home?: string;
  readonly split?: string;
  readonly focus?: string;
}
export function guidedTourCopy(
  step: GuidedTourStep,
  keys: GuidedTourShortcuts = {},
): { title: string; body: string } {
  const shortcut = (key: string | undefined) => (key ? ` (${key})` : "");
  switch (step) {
    case "welcome":
      return {
        title: "Meet tmux-ide",
        body: "A machine can run several tmux servers. Each server has sessions; sessions contain windows, and windows contain terminal panes. Home brings agents across connected machines together.",
      };
    case "practice":
      return {
        title: "Your practice space",
        body: "Create a separate local practice session. The tour leaves your existing sessions alone. You can pause now and resume from Home.",
      };
    case "split":
      return {
        title: "Make room",
        body: `Split the practice pane${shortcut(keys.split)}. You can also find Split right in Commands${shortcut(keys.commands)}. The next step unlocks when the new pane appears.`,
      };
    case "focus":
      return {
        title: "Move between panes",
        body: `Select the other practice pane by clicking it or using your pane navigation shortcut${shortcut(keys.focus)}. Each pane is an independent terminal.`,
      };
    case "resize":
      return {
        title: "Find a comfortable layout",
        body: "Drag the divider between the practice panes. Continue working while tmux updates the layout; the tour advances after the changed dimensions arrive.",
      };
    case "commands":
      return {
        title: "Find an action",
        body: `Open Commands${shortcut(keys.commands)} to discover actions and their current shortcuts. Close the palette when you are ready to continue.`,
      };
    case "theme":
      return {
        title: "Make it yours",
        body: "Choose a different theme from Home. Automatic contrast correction improves hard-to-read terminal colors; you can turn it off in settings.",
      };
    case "leave":
      return {
        title: "Leave without losing work",
        body: `Open Home${shortcut(keys.home)}. Your practice terminals keep running in tmux while you look at agents or other sessions.`,
      };
    case "reopen":
      return {
        title: "Pick up where you left off",
        body: "Reopen your practice session. tmux keeps your terminals alive independently of which page or session you are viewing.",
      };
    case "complete":
      return {
        title: "Ready to explore",
        body: "You have split, focused and resized panes, found commands, changed theme and returned to a running session. Your practice session remains available; close it when you are finished. Replay this tour from Home.",
      };
  }
}
