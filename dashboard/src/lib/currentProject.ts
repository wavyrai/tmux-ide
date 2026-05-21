/**
 * Module-level signal: which project route is currently mounted.
 *
 * The dashboard's nested routes already know via `useParams`, but
 * pieces of chrome that live at the app root (e.g. the unified Cmd+K
 * palette) need the same answer outside any route's reactive scope.
 * The project route writes this on mount; consumers read it
 * synchronously.
 */

import { createSignal } from "solid-js";

const [name, setName] = createSignal<string | null>(null);

export const currentProjectName = name;

export function setCurrentProjectName(next: string | null): void {
  setName(next);
}
