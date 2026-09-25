import { batch, createEffect, createSignal, onCleanup } from "solid-js";
import type { AgentActivity } from "@tmux-ide/contracts";
import type { SemanticThemeSnapshot } from "../theme.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const listeners = new Set<(frame: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let frame = 0;

/** One clock for mounted working indicators, with no daemon or inventory work. */
function subscribe(listener: (frame: number) => void): () => void {
  listeners.add(listener);
  listener(frame);
  if (!timer) {
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      batch(() => listeners.forEach((update) => update(frame)));
    }, 80);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
      frame = 0;
    }
  };
}

/** Presentation only: never infer activity from animation or process liveness. */
export function createAgentStatusMarker(options: {
  theme: () => SemanticThemeSnapshot;
  status: () => AgentActivity | "working" | "blocked" | "done" | "unknown" | undefined;
  attention?: () => boolean;
  unavailable?: () => boolean;
}) {
  const [current, setCurrent] = createSignal(0);
  const working = () => options.status() === "running" || options.status() === "working";
  const animated = () =>
    working() &&
    !options.attention?.() &&
    !options.unavailable?.() &&
    !options.theme().accessibility.reducedMotion;
  createEffect(() => {
    if (animated()) onCleanup(subscribe(setCurrent));
  });
  return () => {
    if (options.unavailable?.()) return "·";
    if (options.attention?.()) return "!";
    switch (options.status()) {
      case "running":
      case "working":
        return animated() ? FRAMES[current()]! : options.theme().glyphs.active;
      case "waiting":
      case "blocked":
        return "!";
      case "complete":
      case "done":
        return options.theme().glyphs.check;
      case "failed":
        return "×";
      case "idle":
        return options.theme().glyphs.inactive;
      default:
        return "·";
    }
  };
}
