import { onCleanup, onMount } from "solid-js";

import { Button } from "../ui-system/index.ts";
import { DomIcon } from "./dom-icon.tsx";

export interface FirstRunIntroProps {
  readonly platform?: string;
  /** Persist the acknowledgement and hide the layer. Called once. */
  readonly onDismiss: () => void;
}

/**
 * The gentle first-run intro layer. It shows exactly once — on the first live
 * workspace — pointing at the canvas, the dock tabs, and the command palette,
 * then never returns after dismissal (the caller persists the marker). It is a
 * quiet, keyboard-dismissable panel, not a blocking modal.
 */
export function FirstRunIntro(props: FirstRunIntroProps) {
  let dismissButton: HTMLButtonElement | undefined;
  const paletteKey = () => (props.platform === "darwin" ? "⌘K" : "Ctrl K");

  onMount(() => {
    dismissButton?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onDismiss();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  return (
    <aside
      class="first-run-intro"
      role="dialog"
      aria-label="Getting started with tmux-ide"
      data-focus-zone="first-run-intro"
    >
      <div class="first-run-intro__card">
        <span class="eyebrow">You're in</span>
        <h2>Your workspace is live</h2>
        <p>A quick look at where things are. This shows once.</p>
        <ul class="first-run-intro__points">
          <li>
            <DomIcon id="terminals" usage="action" />
            <span>
              <strong>The canvas</strong> holds your terminals and agents.
            </span>
          </li>
          <li>
            <DomIcon id="files" usage="action" />
            <span>
              <strong>Files, Changes, Missions, Activity</strong> are the dock tabs below.
            </span>
          </li>
          <li>
            <DomIcon id="command" usage="action" />
            <span>
              <strong>{paletteKey()}</strong> opens the command palette for everything else.
            </span>
          </li>
        </ul>
        <div class="first-run-intro__actions">
          <Button
            ref={(element: HTMLButtonElement) => (dismissButton = element)}
            variant="primary"
            onClick={() => props.onDismiss()}
          >
            Got it
          </Button>
          <span class="first-run-intro__hint">Press Esc to dismiss</span>
        </div>
      </div>
    </aside>
  );
}
