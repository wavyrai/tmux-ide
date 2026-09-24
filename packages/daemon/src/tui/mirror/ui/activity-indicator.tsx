/* @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";

/** One small indicator for a visible pending region, never a timer per agent. */
export function ActivityIndicator(props: { theme: SemanticThemeSnapshot; active: boolean }) {
  const [frame, setFrame] = createSignal(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  createEffect(() => {
    if (!props.active || props.theme.accessibility.reducedMotion) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 100);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <text width={2} height={1} fg={props.theme.roles.text.muted}>
      {props.active && !props.theme.accessibility.reducedMotion ? frames[frame()] : "…"}{" "}
    </text>
  );
}
