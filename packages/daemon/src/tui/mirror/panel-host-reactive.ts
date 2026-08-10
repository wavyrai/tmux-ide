import { createEffect, untrack } from "solid-js";

/**
 * Track only the project-directory accessor, not the signals read while the
 * loader flushes and hydrates panel state. Without the untracked boundary a
 * loader can subscribe its own effect to the state it writes and recurse until
 * Solid exhausts the stack.
 */
export function trackPanelHostDirectory(
  directory: () => string,
  load: (directory: string) => void,
): void {
  createEffect(() => {
    const nextDirectory = directory();
    untrack(() => load(nextDirectory));
  });
}
